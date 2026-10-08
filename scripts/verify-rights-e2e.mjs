#!/usr/bin/env node
/**
 * End-to-end test: ParaB (200) verifies CCRMS (100) rights with pallet-rights-verifier,
 * using state proven through the relay chain (no caller-supplied root).
 *
 * 1. On CCRMS, //Alice registers content and //Bob buys ownership.
 * 2. Pick a relay block R that ParaB has recorded in rightsVerifier.relayRoots
 *    and whose Paras::Heads(100) is a CCRMS block at or after the purchase.
 * 3. Build a relay proof of Paras::Heads(100) at R and a CCRMS proof of
 *    Ownership(content, who) at that CCRMS block, both via state_getReadProof.
 * 4. Submit verifyOwnership on ParaB for Bob (expect true), for Charlie (expect
 *    false), and with Bob's proof but a relay block ParaB never recorded (expect
 *    UnknownRelayBlock).
 *
 * Usage:
 *   node scripts/verify-rights-e2e.mjs <relay-ws> [paraA-ws] [paraB-ws]
 * Output: scripts/perf/results/verify-rights-e2e-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const RELAY_WS = process.argv[2];
const PARA_A_WS = process.argv[3] || 'ws://127.0.0.1:9990';
const PARA_B_WS = process.argv[4] || 'ws://127.0.0.1:9991';
const OUTPUT = 'scripts/perf/results/verify-rights-e2e-results.json';
if (!RELAY_WS) { console.error('Usage: node scripts/verify-rights-e2e.mjs <relay-ws> [paraA-ws] [paraB-ws]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolves once the transaction is FINALIZED (blocks on this single-collator
// testnet are sometimes discarded and re-authored, Finding F), with its
// dispatch error if any. Rejects on Invalid/Dropped/Usurped or after 3 minutes.
function send(api, tx, signer) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error('transaction not finalized after 180 s')), 180_000);
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (done) return;
      if (status.isInvalid || status.isDropped || status.isUsurped) return finish(reject, new Error(`transaction ${status.type}`));
      if (!status.isFinalized) return;
      if (dispatchError) {
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          return finish(resolve, { error: `${d.section}.${d.name}`, events, blockHash: status.asFinalized });
        }
        return finish(resolve, { error: dispatchError.toString(), events, blockHash: status.asFinalized });
      }
      finish(resolve, { blockHash: status.asFinalized, events });
    }).catch((e) => finish(reject, e));
  });
}
const byteLen = (proof) => proof.reduce((a, hex) => a + (hex.length - 2) / 2, 0);

async function main() {
  const apiR = await ApiPromise.create({ provider: new WsProvider(RELAY_WS) });
  const apiA = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const apiB = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS) });
  await cryptoWaitReady();
  const k = new Keyring({ type: 'sr25519' });
  const alice = k.addFromUri('//Alice'), bob = k.addFromUri('//Bob'), charlie = k.addFromUri('//Charlie');

  // 1. Rights on CCRMS.
  const hash = '0x' + Buffer.from(`verify-e2e-${Date.now()}`).toString('hex').slice(0, 64).padEnd(64, '0');
  const reg = await send(apiA, apiA.tx.contentRights.registerContent(hash, 'Verify e2e', 1000, 100, 5000, 100), alice);
  if (reg.error) throw new Error(`registerContent: ${reg.error}`);
  const contentId = reg.events.find(({ event }) => event.method === 'ContentRegistered').event.data[0].toNumber();
  const buy = await send(apiA, apiA.tx.contentRights.purchaseOwnership(contentId), bob);
  if (buy.error) throw new Error(`purchaseOwnership: ${buy.error}`);
  const purchaseBlock = (await apiA.rpc.chain.getHeader(buy.blockHash)).number.toNumber();
  console.log(`CCRMS: content ${contentId}, Bob bought ownership in block ${purchaseBlock}`);

  // 2. A relay block recorded by ParaB whose CCRMS head includes the purchase.
  let chosen = null;
  for (let attempt = 0; attempt < 60 && !chosen; attempt++) {
    const roots = await apiB.query.rightsVerifier.relayRoots();
    for (const [n, root] of [...roots].reverse()) {
      const relayNumber = n.toNumber();
      const relayHash = await apiR.rpc.chain.getBlockHash(relayNumber);
      const relayHeader = await apiR.rpc.chain.getHeader(relayHash);
      if (!relayHeader.stateRoot.eq(root)) continue; // a different fork at that height
      const head = await apiR.query.paras.heads.at(relayHash, 100);
      if (head.isNone) continue;
      const ccrmsHeader = apiA.registry.createType('Header', head.unwrap().toU8a(true));
      if (ccrmsHeader.number.toNumber() >= purchaseBlock) {
        chosen = { relayNumber, relayHash, ccrmsNumber: ccrmsHeader.number.toNumber(), ccrmsHash: ccrmsHeader.hash };
        break;
      }
    }
    if (!chosen) await sleep(6000);
  }
  if (!chosen) throw new Error('no recorded relay block includes the purchase yet');
  console.log(`Relay block ${chosen.relayNumber} (recorded on ParaB) includes CCRMS block ${chosen.ccrmsNumber}`);

  // 3. Proofs.
  // Proof nodes go in as hex strings: polkadot.js treats a raw Uint8Array given
  // for a Bytes argument as already length-prefixed.
  const relayProof = (await apiR.rpc.state.getReadProof([apiR.query.paras.heads.key(100)], chosen.relayHash)).proof.map((p) => p.toHex());
  const proofFor = async (who) =>
    (await apiA.rpc.state.getReadProof([apiA.query.contentRights.ownership.key(contentId, who)], chosen.ccrmsHash)).proof.map((p) => p.toHex());
  const bobProof = await proofFor(bob.address);
  const charlieProof = await proofFor(charlie.address);

  // 4. Verify on ParaB.
  const verify = async (relayNumber, rProof, cProof, who) => {
    const r = await send(apiB, apiB.tx.rightsVerifier.verifyOwnership(relayNumber, rProof, cProof, contentId, who), alice);
    if (r.error) return { error: r.error };
    const ev = r.events.find(({ event }) => event.section === 'rightsVerifier' && event.method === 'OwnershipVerified');
    return { isOwner: ev.event.data[2].isTrue, rightsBlock: ev.event.data[4].toNumber() };
  };
  const t0 = Date.now();
  const bobResult = await verify(chosen.relayNumber, relayProof, bobProof, bob.address);
  const verifyWallMs = Date.now() - t0;
  const charlieResult = await verify(chosen.relayNumber, relayProof, charlieProof, charlie.address);
  const unknownResult = await verify(chosen.relayNumber + 1_000_000, relayProof, bobProof, bob.address);

  const checks = {
    bobIsOwner: bobResult.isOwner === true,
    charlieIsNotOwner: charlieResult.isOwner === false,
    unrecordedRelayBlockRejected: unknownResult.error === 'rightsVerifier.UnknownRelayBlock',
  };
  const out = { timestamp: new Date().toISOString(), contentId, purchaseBlock, ...chosen,
    relayHash: chosen.relayHash.toHex(), ccrmsHash: chosen.ccrmsHash.toHex(),
    relayProofBytes: byteLen(relayProof), rightsProofBytes: byteLen(bobProof), verifyWallMs,
    bobResult, charlieResult, unknownResult, checks, passed: Object.values(checks).every(Boolean) };
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ checks, relayProofBytes: out.relayProofBytes, rightsProofBytes: out.rightsProofBytes }, null, 2));
  console.log(out.passed ? 'PASS' : 'FAIL');
  await apiR.disconnect(); await apiA.disconnect(); await apiB.disconnect();
  process.exit(out.passed ? 0 : 1);
}
main().catch((e) => { console.error('Test failed:', e.message); process.exit(1); });
