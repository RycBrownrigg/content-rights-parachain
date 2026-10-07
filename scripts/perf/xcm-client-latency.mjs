#!/usr/bin/env node
/**
 * Performance test: cross-chain rights requests through pallet-rights-client (v3).
 *
 * Each run creates a fresh user on ParaB (200), funds it, and has it call
 * rightsClient.request. The pallet sends ParaA (100, CCRMS) the complete program
 *
 *   WithdrawAsset, BuyExecution,
 *   SetAppendix [RefundSurplus, DepositAsset -> ParaB sovereign],
 *   Transact (xcm_* call, beneficiary = the user's key),
 *   ReportTransactStatus -> ParaB
 *
 * and ParaB settles the user's escrow when the report arrives.
 *
 * Metrics per run (all from finalized blocks and on-chain timestamps):
 *   deliveryMs     ParaA block with the CrossChain* event minus the ParaB block
 *                  that included the request
 *   paraABlocks    ParaA blocks from the ParaA head at send time to that event
 *   roundTripMs    ParaB block with rightsClient.OutcomeReported minus the ParaB
 *                  block that included the request
 *   reported       success flag in OutcomeReported
 *   feeKept        balance change of ParaB's sovereign account on ParaA in the
 *                  event block, minus the content price: the execution fee actually
 *                  charged after RefundSurplus returned the unused part of the
 *                  150_000_000_000 withdrawn
 *   trapped        whether polkadotXcm.AssetsTrapped appeared in that block
 *
 * Failure runs request a nonexistent content ID: CCRMS reports the dispatch
 * error and ParaB refunds the escrow (refunded = user's escrow returned).
 *
 * Usage:
 *   node scripts/perf/xcm-client-latency.mjs [paraA-ws] [paraB-ws] [--runs N] [--fail-runs F] [--gap S]
 *
 * Prerequisites: HRMP channels open between para 100 and para 200; sudo on both.
 * Output: scripts/perf/results/xcm-client-latency-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const positional = process.argv.slice(2).filter((a, i, arr) =>
  !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
function flag(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
}
const PARA_A_WS = positional[0] || 'ws://127.0.0.1:9990';
const PARA_B_WS = positional[1] || 'ws://127.0.0.1:9991';
const RUNS = flag('runs', 10);
const FAIL_RUNS = flag('fail-runs', 5);
const GAP_SECONDS = flag('gap', 12);
const MAX_BLOCKS = 40;
const UNIT = 10n ** 12n;
const ESCROW = UNIT;
const USER_FUNDS = 10n * UNIT;
const PRICES = { subscribe: 500000n, purchase_views: 100000n * 5n, purchase_ownership: 2000000n };
const PARA_B_SOVEREIGN = '0x7369626cc8000000000000000000000000000000000000000000000000000000';
const OUTPUT = 'scripts/perf/results/xcm-client-latency-results.json';

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
      if (status.isInBlock) { settled = true; resolve({ blockHash: status.asInBlock, events }); }
    }).catch((e) => { if (!settled) { settled = true; reject(e); } });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = async (api, hash) => (await api.rpc.chain.getHeader(hash)).number.toNumber();
const ts = async (api, hash) => (await api.query.timestamp.now.at(hash)).toNumber();
async function finalizedHash(api, n, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fin = await api.rpc.chain.getFinalizedHead();
    if ((await num(api, fin)) >= n) return api.rpc.chain.getBlockHash(n);
    await sleep(1000);
  }
  throw new Error(`timed out waiting for block ${n} to finalize`);
}
function field(event, name) {
  const i = event.meta.fields.findIndex((f) => f.name.toString() === name);
  return i > -1 ? event.data[i] : undefined;
}
function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, mean, sd, median, min: s[0], max: s[n - 1] };
}

async function oneRun(apiA, apiB, alice, user, request, op, contentId, expectSuccess, label) {
  await sendAndWait(apiB, apiB.tx.balances.transferKeepAlive(user.address, USER_FUNDS), alice);
  const userBefore = (await apiB.query.system.account(user.address)).data.free.toBigInt();
  const aHead = await num(apiA, await apiA.rpc.chain.getHeader().then((h) => h.hash));

  const { blockHash: bHash, events } = await sendAndWait(
    apiB, apiB.tx.rightsClient.request(request, ESCROW), user);
  const bBlock = await num(apiB, bHash);
  const bTs = await ts(apiB, bHash);
  const sent = events.find(({ event }) => event.section === 'rightsClient' && event.method === 'RequestSent');
  if (!sent) return { label, op, success: false, reason: 'no RequestSent on ParaB' };
  const queryId = field(sent.event, 'query_id').toString();
  // pallet_xcm::send_xcm emits no polkadotXcm.Sent; the client reports the topic itself.
  const messageId = field(sent.event, 'message_id').toHex();
  const r = { label, op, contentId, queryId, messageId, paraBBlock: bBlock, expectSuccess };

  // Delivery on ParaA: the CrossChain* event for this beneficiary (success runs),
  // or the messageQueue.Processed event for this message ID (failure runs).
  const eventName = { subscribe: 'CrossChainSubscriptionCreated', purchase_views: 'CrossChainViewPackPurchased',
    purchase_ownership: 'CrossChainOwnershipPurchased' }[op];
  for (let n = aHead + 1; n <= aHead + MAX_BLOCKS && r.paraABlocks === undefined; n++) {
    const h = await finalizedHash(apiA, n);
    const evs = await apiA.query.system.events.at(h);
    let hit = false, trapped = false;
    for (const { event } of evs) {
      if (event.section === 'polkadotXcm' && event.method === 'AssetsTrapped') trapped = true;
      if (expectSuccess && event.section === 'contentRights' && event.method === eventName) {
        const b = field(event, 'beneficiary');
        if (b && b.eq(user.address)) hit = true;
      }
      if (!expectSuccess && event.section === 'messageQueue' && event.method === 'Processed'
          && messageId && field(event, 'id').toHex() === messageId) hit = true;
    }
    if (hit) {
      const parent = (await apiA.rpc.chain.getHeader(h)).parentHash;
      const before = (await apiA.query.system.account.at(parent, PARA_B_SOVEREIGN)).data.free.toBigInt();
      const after = (await apiA.query.system.account.at(h, PARA_B_SOVEREIGN)).data.free.toBigInt();
      const spent = before - after;
      Object.assign(r, { paraAEventBlock: n, paraABlocks: n - aHead, deliveryMs: (await ts(apiA, h)) - bTs,
        sovereignSpent: spent.toString(),
        feeKept: (spent - (expectSuccess ? PRICES[op] : 0n)).toString(), trapped });
    }
  }
  if (r.paraABlocks === undefined) return { ...r, success: false, reason: `not delivered within ${MAX_BLOCKS} ParaA blocks` };

  // Report on ParaB: rightsClient.OutcomeReported for this query.
  for (let n = bBlock + 1; n <= bBlock + MAX_BLOCKS && r.roundTripMs === undefined; n++) {
    const h = await finalizedHash(apiB, n);
    for (const { event } of await apiB.query.system.events.at(h)) {
      if (event.section === 'rightsClient' && event.method === 'OutcomeReported'
          && field(event, 'query_id').toString() === queryId) {
        r.reported = field(event, 'success').isTrue;
        r.paraBReportBlock = n;
        r.roundTripMs = (await ts(apiB, h)) - bTs;
      }
    }
  }
  if (r.roundTripMs === undefined) return { ...r, success: false, reason: `no report within ${MAX_BLOCKS} ParaB blocks` };
  const userAfter = (await apiB.query.system.account(user.address)).data.free.toBigInt();
  // Failure runs: escrow refunded means the user lost only the request's transaction fee.
  r.refunded = !expectSuccess ? (userBefore - userAfter) < ESCROW : null;
  r.success = r.reported === expectSuccess;
  return r;
}

function save(body) {
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify({ version: 3, timestamp: new Date().toISOString(),
    paraA: PARA_A_WS, paraB: PARA_B_WS, runs: RUNS, failRuns: FAIL_RUNS, ...body }, null, 2));
}

async function main() {
  const apiA = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const apiB = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS) });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  console.log('Funding ParaB sovereign on ParaA...');
  await sendAndWait(apiA, apiA.tx.sudo.sudo(apiA.tx.balances.forceSetBalance(PARA_B_SOVEREIGN, 1000n * UNIT)), alice);

  const ops = ['subscribe', 'purchase_views', 'purchase_ownership'];
  const contentFor = {};
  for (const op of ops) {
    const hash = '0x' + Buffer.from(`xcm-client-${op}-${Date.now()}`).toString('hex').slice(0, 64).padEnd(64, '0');
    const reg = await sendAndWait(apiA, apiA.tx.contentRights.registerContent(
      hash, `XCM client ${op}`, 500000, 100000, 2000000, 100), alice);
    contentFor[op] = reg.events.find(({ event }) => event.method === 'ContentRegistered').event.data[0].toNumber();
  }
  const req = {
    subscribe: (c) => ({ Subscribe: { contentId: c } }),
    purchase_views: (c) => ({ PurchaseViews: { contentId: c, numViews: 5 } }),
    purchase_ownership: (c) => ({ PurchaseOwnership: { contentId: c } }),
  };

  const results = { success: {}, failure: [] };
  const stamp = Date.now();
  for (const op of ops) {
    results.success[op] = [];
    for (let i = 0; i < RUNS; i++) {
      const user = keyring.addFromUri(`//XcmClient/${stamp}/${op}/${i}`);
      let r;
      try { r = await oneRun(apiA, apiB, alice, user, req[op](contentFor[op]), op, contentFor[op], true, `${op}_${i + 1}`); }
      catch (e) { r = { label: `${op}_${i + 1}`, op, success: false, reason: `harness error: ${e.message}` }; }
      results.success[op].push(r);
      save({ partial: true, contentIds: contentFor, results });
      console.log(r.success
        ? `${op} ${i + 1}/${RUNS} OK  blocks ${r.paraABlocks}  delivery ${r.deliveryMs} ms  round trip ${r.roundTripMs} ms  fee kept ${r.feeKept}  trapped ${r.trapped}`
        : `${op} ${i + 1}/${RUNS} FAIL ${r.reason}`);
      await sleep(GAP_SECONDS * 1000);
    }
  }
  for (let i = 0; i < FAIL_RUNS; i++) {
    const user = keyring.addFromUri(`//XcmClient/${stamp}/fail/${i}`);
    let r;
    try { r = await oneRun(apiA, apiB, alice, user, req.subscribe(999999), 'subscribe', 999999, false, `fail_${i + 1}`); }
    catch (e) { r = { label: `fail_${i + 1}`, success: false, reason: `harness error: ${e.message}` }; }
    results.failure.push(r);
    save({ partial: true, contentIds: contentFor, results });
    console.log(r.success
      ? `failure ${i + 1}/${FAIL_RUNS} OK  reported false, refunded ${r.refunded}  round trip ${r.roundTripMs} ms  trapped ${r.trapped}`
      : `failure ${i + 1}/${FAIL_RUNS} FAIL ${r.reason}`);
    await sleep(GAP_SECONDS * 1000);
  }

  const okAll = ops.flatMap((op) => results.success[op].filter((r) => r.success));
  const summary = {
    perOperation: Object.fromEntries(ops.map((op) => {
      const ok = results.success[op].filter((r) => r.success);
      return [op, { ok: ok.length, runs: results.success[op].length,
        paraABlocks: stats(ok.map((r) => r.paraABlocks)), deliverySec: stats(ok.map((r) => r.deliveryMs / 1000)),
        roundTripSec: stats(ok.map((r) => r.roundTripMs / 1000)) }];
    })),
    all: { ok: okAll.length, runs: ops.length * RUNS,
      paraABlocks: stats(okAll.map((r) => r.paraABlocks)), deliverySec: stats(okAll.map((r) => r.deliveryMs / 1000)),
      roundTripSec: stats(okAll.map((r) => r.roundTripMs / 1000)),
      feeKept: stats(okAll.filter((r) => r.feeKept !== null).map((r) => Number(r.feeKept))),
      anyTrapped: okAll.some((r) => r.trapped) },
    failure: { ok: results.failure.filter((r) => r.success).length, runs: FAIL_RUNS,
      refunded: results.failure.filter((r) => r.refunded).length,
      roundTripSec: stats(results.failure.filter((r) => r.success).map((r) => r.roundTripMs / 1000)),
      anyTrapped: results.failure.some((r) => r.trapped) },
  };
  save({ partial: false, contentIds: contentFor, summary, results });
  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  await apiA.disconnect(); await apiB.disconnect(); process.exit(0);
}
main().catch((e) => { console.error('Test failed:', e.message); process.exit(1); });
