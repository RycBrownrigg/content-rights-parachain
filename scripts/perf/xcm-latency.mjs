#!/usr/bin/env node
/**
 * Performance test: XCM cross-chain operation latency (v2).
 *
 * Sends WithdrawAsset → BuyExecution → Transact from ParaB (200) to ParaA
 * (100, CCRMS) carrying the real xcm_* extrinsics (payer = ParaB sovereign,
 * beneficiary = a fresh account per run), then follows ParaA block by block
 * until the *specific* CrossChain* event for that beneficiary appears.
 *
 * Differences from v1 (which produced the April 2026 Table 7.2 figures):
 *   - v1 put plain subscribe/purchaseViews/purchaseOwnership inside Transact,
 *     not the xcm_* extrinsics.
 *   - v1 matched the first *any* contentRights event (or any messageQueue
 *     Processed) and started scanning at a block produced *before* the send,
 *     so it could match unrelated, pre-existing events (hence a 0-block delta).
 *   - v1 always waited for 15 blocks, so its "wall clock" (~100 s) measured
 *     the scan window, not latency.
 *   - v1 did not check that the XCM message executed successfully.
 *
 * Metrics per run:
 *   latencyMs     on-chain time: timestamp of the ParaA block containing the
 *                 event minus timestamp of the ParaB block that included the
 *                 send (both from pallet-timestamp; same host clock in Zombienet)
 *   paraABlocks   ParaA blocks from the ParaA head at send time to the event
 *   wallClockMs   client-observed time from submitting on ParaB to seeing the
 *                 event on ParaA (includes RPC polling overhead)
 *
 * Usage:
 *   node scripts/perf/xcm-latency.mjs [paraA-ws] [paraB-ws] [--runs N] [--max-blocks M]
 *
 * Prerequisites: HRMP channels open between para 100 and para 200; sudo on ParaB.
 *
 * Output: scripts/perf/results/xcm-latency-results-v2.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

// ── Arguments ───────────────────────────────────────────────────────────────
const positional = process.argv.slice(2).filter((a, i, arr) =>
  !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
function flag(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
}
const PARA_A_WS = positional[0] || 'ws://127.0.0.1:9990';
const PARA_B_WS = positional[1] || 'ws://127.0.0.1:9991';
const RUNS_PER_OPERATION = flag('runs', 10);
const MAX_BLOCKS = flag('max-blocks', 30);
const XCM_FEE_AMOUNT = 100_000_000_000;
const PARA_A_ID = 100;
const OUTPUT = 'scripts/perf/results/xcm-latency-results-v2.json';

// ── Helpers ─────────────────────────────────────────────────────────────────
function sendAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (settled) return;
      if (dispatchError) {
        settled = true;
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${d.section}.${d.name}`));
        } else reject(new Error(dispatchError.toString()));
        return;
      }
      if (status.isInBlock) {
        settled = true;
        resolve({ blockHash: status.asInBlock, events });
      }
    }).catch((e) => { if (!settled) { settled = true; reject(e); } });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function blockNumberOf(api, hash) {
  return (await api.rpc.chain.getHeader(hash)).number.toNumber();
}

async function timestampAt(api, hash) {
  return (await api.query.timestamp.now.at(hash)).toNumber();
}

/** Wait until block `n` exists on `api`, then return its hash. */
async function waitForBlockHash(api, n, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    if (head >= n) return api.rpc.chain.getBlockHash(n);
    await sleep(500);
  }
  throw new Error(`timed out waiting for block ${n}`);
}

function field(event, name) {
  const idx = event.meta.fields.findIndex((f) => f.name.toString() === name);
  return idx > -1 ? event.data[idx] : undefined;
}

function stats(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, mean, sd, median, min: s[0], max: s[n - 1] };
}

// ── One measured run ────────────────────────────────────────────────────────
async function sendXcmAndMeasure(apiA, apiB, encodedCall, signer, label, eventName, beneficiary) {
  const paraAHeadAtSend = (await apiA.rpc.chain.getHeader()).number.toNumber();

  const xcmMessage = {
    V3: [
      { WithdrawAsset: [{ id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: XCM_FEE_AMOUNT } }] },
      { BuyExecution: { fees: { id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: XCM_FEE_AMOUNT } }, weightLimit: 'Unlimited' } },
      { Transact: { originKind: 'SovereignAccount', requireWeightAtMost: { refTime: 1_000_000_000, proofSize: 100_000 }, call: { encoded: encodedCall } } },
    ],
  };
  const dest = { V3: { parents: 1, interior: { X1: { Parachain: PARA_A_ID } } } };
  const tx = apiB.tx.sudo.sudo(apiB.tx.polkadotXcm.send(dest, xcmMessage));

  const tSubmit = Date.now();
  const { blockHash: bHash, events: bEvents } = await sendAndWait(apiB, tx, signer);
  const paraBBlock = await blockNumberOf(apiB, bHash);
  const paraBTimestamp = await timestampAt(apiB, bHash);
  const sentOk = bEvents.some(({ event }) => event.section === 'polkadotXcm' && event.method === 'Sent');
  const sudoFailed = bEvents.find(({ event }) =>
    event.section === 'sudo' && event.method === 'Sudid' && event.data[0].isErr);
  if (!sentOk || sudoFailed) {
    return { label, success: false, reason: 'send failed on ParaB', paraBBlock };
  }

  // Follow ParaA strictly after the head at send time.
  const processed = [];
  for (let n = paraAHeadAtSend + 1; n <= paraAHeadAtSend + MAX_BLOCKS; n++) {
    const hash = await waitForBlockHash(apiA, n);
    const events = await apiA.query.system.events.at(hash);
    let hit = null;
    for (const { event } of events) {
      if (event.section === 'messageQueue' && event.method === 'Processed') {
        const ok = field(event, 'success');
        processed.push({ block: n, success: ok ? ok.isTrue : null });
      }
      if (event.section === 'contentRights' && event.method === eventName) {
        const b = field(event, 'beneficiary');
        if (b && b.eq(beneficiary)) hit = event;
      }
    }
    if (hit) {
      const tSeen = Date.now();
      const paraATimestamp = await timestampAt(apiA, hash);
      return {
        label,
        success: true,
        paraBBlock,
        paraAHeadAtSend,
        paraAEventBlock: n,
        paraABlocks: n - paraAHeadAtSend,
        latencyMs: paraATimestamp - paraBTimestamp,
        wallClockMs: tSeen - tSubmit,
        messageQueueProcessed: processed,
      };
    }
  }

  const failedProcessing = processed.some((p) => p.success === false);
  return {
    label,
    success: false,
    reason: failedProcessing
      ? 'XCM message processed with success=false on ParaA (Transact failed)'
      : `no ${eventName} for beneficiary within ${MAX_BLOCKS} ParaA blocks`,
    paraBBlock,
    paraAHeadAtSend,
    messageQueueProcessed: processed,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Performance Test: XCM Cross-Chain Latency (v2)');
  console.log(`  runs/operation: ${RUNS_PER_OPERATION}   max ParaA blocks: ${MAX_BLOCKS}`);
  console.log('═══════════════════════════════════════════════════════════');

  const apiA = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const apiB = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS) });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Fund ParaB sovereign account on ParaA (payer for every xcm_* call).
  console.log('\n  Funding ParaB sovereign on ParaA...');
  const paraBSovereign = '0x7369626cc8000000000000000000000000000000000000000000000000000000';
  await sendAndWait(apiA, apiA.tx.sudo.sudo(
    apiA.tx.balances.forceSetBalance(paraBSovereign, '1000000000000000000')
  ), alice);

  // One content item per operation (≤ RUNS children each, under the 50 cap).
  console.log('  Registering one content item per operation on ParaA...');
  const ops = ['xcm_subscribe', 'xcm_purchase_views', 'xcm_purchase_ownership'];
  const contentFor = {};
  for (const op of ops) {
    const hash = '0x' + Buffer.from(`xcm-lat-${op}-${Date.now()}`).toString('hex').slice(0, 64).padEnd(64, '0');
    const reg = await sendAndWait(apiA, apiA.tx.contentRights.registerContent(
      hash, `XCM Latency ${op}`, 500000, 100000, 2000000, 100,
    ), alice);
    const ev = reg.events.find(({ event }) =>
      event.section === 'contentRights' && event.method === 'ContentRegistered');
    contentFor[op] = ev.event.data[0].toNumber();
  }
  console.log(`  Content IDs: ${JSON.stringify(contentFor)}`);

  const build = {
    xcm_subscribe: (cid, who) => [apiA.tx.contentRights.xcmSubscribe(cid, who), 'CrossChainSubscriptionCreated'],
    xcm_purchase_views: (cid, who) => [apiA.tx.contentRights.xcmPurchaseViews(cid, who, 5), 'CrossChainViewPackPurchased'],
    xcm_purchase_ownership: (cid, who) => [apiA.tx.contentRights.xcmPurchaseOwnership(cid, who), 'CrossChainOwnershipPurchased'],
  };

  const results = {};
  const stamp = Date.now();
  for (const op of ops) {
    console.log(`\n── ${op} ──`);
    results[op] = [];
    for (let run = 0; run < RUNS_PER_OPERATION; run++) {
      const beneficiary = keyring.addFromUri(`//XcmLatency/${stamp}/${op}/${run}`).address;
      const [call, eventName] = build[op](contentFor[op], beneficiary);
      const r = await sendXcmAndMeasure(
        apiA, apiB, call.method.toHex(), alice, `${op}_${run + 1}`, eventName, beneficiary);
      results[op].push(r);
      console.log(r.success
        ? `  ${run + 1}/${RUNS_PER_OPERATION} OK   ParaA blocks: ${r.paraABlocks}  latency: ${r.latencyMs} ms  wall: ${r.wallClockMs} ms`
        : `  ${run + 1}/${RUNS_PER_OPERATION} FAIL ${r.reason}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = {};
  console.log('\n── Summary (successful runs) ──');
  console.log('Operation               |  ok/n | blocks median (min–max) | latency s: median, mean ± sd');
  for (const op of ops) {
    const ok = results[op].filter((r) => r.success);
    const b = stats(ok.map((r) => r.paraABlocks));
    const l = stats(ok.map((r) => r.latencyMs / 1000));
    const w = stats(ok.map((r) => r.wallClockMs / 1000));
    summary[op] = { succeeded: ok.length, runs: results[op].length, paraABlocks: b, latencySec: l, wallClockSec: w };
    console.log(`${op.padEnd(24)}| ${String(ok.length).padStart(2)}/${String(results[op].length).padEnd(2)} | ` +
      (b ? `${b.median} (${b.min}–${b.max})`.padEnd(23) : 'n/a'.padEnd(23)) + ' | ' +
      (l ? `${l.median.toFixed(1)}, ${l.mean.toFixed(1)} ± ${l.sd.toFixed(1)}` : 'n/a'));
  }
  const all = ops.flatMap((op) => results[op].filter((r) => r.success));
  summary.all = {
    paraABlocks: stats(all.map((r) => r.paraABlocks)),
    latencySec: stats(all.map((r) => r.latencyMs / 1000)),
  };
  if (summary.all.latencySec) {
    const a = summary.all;
    console.log(`\nAll operations: ${a.latencySec.n} runs, median ${a.paraABlocks.median} ParaA blocks, ` +
      `median latency ${a.latencySec.median.toFixed(1)} s (range ${a.latencySec.min.toFixed(1)}–${a.latencySec.max.toFixed(1)} s)`);
  }

  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify({
    version: 2,
    timestamp: new Date().toISOString(),
    paraA: PARA_A_WS,
    paraB: PARA_B_WS,
    runsPerOperation: RUNS_PER_OPERATION,
    maxBlocks: MAX_BLOCKS,
    contentIds: contentFor,
    summary,
    results,
  }, null, 2));
  console.log(`\nResults saved to ${OUTPUT}`);

  await apiA.disconnect();
  await apiB.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
