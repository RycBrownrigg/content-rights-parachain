#!/usr/bin/env node
/**
 * Performance test: XCM cross-chain operation latency.
 *
 * Measures end-to-end latency for cross-chain content rights operations
 * by recording the block delta between XCM send on ParaB and event
 * arrival on ParaA.
 *
 * @module xcm-latency
 *
 * Usage: node scripts/perf/xcm-latency.mjs [paraA-ws] [paraB-ws] [relay-ws]
 *
 * Prerequisites: HRMP channels open between para 100 and para 200
 *
 * Output: scripts/perf/results/xcm-latency-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const PARA_B_WS = process.argv[3] || 'ws://127.0.0.1:9991';
const RELAY_WS = process.argv[4] || 'ws://127.0.0.1:54180';
const XCM_FEE_AMOUNT = 100_000_000_000;
const RUNS_PER_OPERATION = 3;

function sendAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${decoded.section}.${decoded.name}`));
        } else reject(new Error(dispatchError.toString()));
      }
      if (status.isInBlock) resolve({ blockHash: status.asInBlock, events });
    });
  });
}

async function waitForBlock(api, minBlock) {
  return new Promise((resolve) => {
    const unsub = api.rpc.chain.subscribeNewHeads(async (header) => {
      if (header.number.toNumber() >= minBlock) {
        (await unsub)();
        resolve(header.number.toNumber());
      }
    });
  });
}

async function sendXcmAndMeasure(apiA, apiB, encodedCall, signer, label) {
  const tStart = Date.now();
  const paraBBlockBefore = (await apiB.rpc.chain.getHeader()).number.toNumber();
  const paraABlockBefore = (await apiA.rpc.chain.getHeader()).number.toNumber();

  // Send XCM from ParaB to ParaA
  const xcmMessage = {
    V3: [
      { WithdrawAsset: [{ id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: XCM_FEE_AMOUNT } }] },
      { BuyExecution: { fees: { id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: XCM_FEE_AMOUNT } }, weightLimit: 'Unlimited' } },
      { Transact: { originKind: 'SovereignAccount', requireWeightAtMost: { refTime: 1_000_000_000, proofSize: 100_000 }, call: { encoded: encodedCall } } },
    ]
  };

  const dest = { V3: { parents: 1, interior: { X1: { Parachain: 100 } } } };
  const tx = apiB.tx.sudo.sudo(apiB.tx.polkadotXcm.send(dest, xcmMessage));
  await sendAndWait(apiB, tx, signer);
  const tSent = Date.now();
  const paraBBlockAfter = (await apiB.rpc.chain.getHeader()).number.toNumber();

  // Wait for event on ParaA
  const scanEnd = paraABlockBefore + 15;
  await waitForBlock(apiA, scanEnd);
  const tReceived = Date.now();

  // Scan for the contentRights event on ParaA
  const found = await scanForEvent(apiA, paraABlockBefore, scanEnd, 'contentRights', null)
    || await scanForEvent(apiA, paraABlockBefore, scanEnd, 'messageQueue', 'Processed');

  const paraABlockEvent = found ? found.block : null;
  const blockDelta = paraABlockEvent ? paraABlockEvent - paraABlockBefore : null;

  return {
    label,
    success: !!found,
    paraBBlockSend: paraBBlockAfter,
    paraABlockBefore,
    paraABlockEvent,
    blockDelta,
    wallClockSendMs: tSent - tStart,
    wallClockTotalMs: tReceived - tStart,
  };
}

async function scanForEvent(api, startBlock, endBlock, section, method) {
  for (let i = startBlock; i <= endBlock; i++) {
    try {
      const hash = await api.rpc.chain.getBlockHash(i);
      const events = await api.query.system.events.at(hash);
      for (const { event } of events) {
        if (event.section === section) {
          if (!method || event.method === method) {
            return { block: i, section: event.section, method: event.method };
          }
        }
      }
    } catch { /* pruned */ }
  }
  return null;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Performance Test: XCM Cross-Chain Latency');
  console.log('═══════════════════════════════════════════════════════════');

  const apiA = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const apiB = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS) });
  const relayApi = await ApiPromise.create({ provider: new WsProvider(RELAY_WS) });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Fund ParaB sovereign account on ParaA (for XCM fee payment)
  console.log('\n  Funding ParaB sovereign on ParaA...');
  const paraBSovereign = '0x7369626cc8000000000000000000000000000000000000000000000000000000';
  await sendAndWait(apiA, apiA.tx.sudo.sudo(
    apiA.tx.balances.forceSetBalance(paraBSovereign, '10000000000000000')
  ), alice);
  console.log('  Funded.');

  // Register content on ParaA for XCM tests
  console.log('  Registering test content on ParaA...');
  const contentIds = [];
  for (let i = 0; i < RUNS_PER_OPERATION + 2; i++) {
    const hash = '0x' + Buffer.from(`xcm-perf-${Date.now()}-${i}`).toString('hex').padEnd(64, '0');
    const reg = await sendAndWait(apiA, apiA.tx.contentRights.registerContent(
      hash, `XCM Perf ${i}`, 500000, 100000, 2000000, 100,
    ), alice);
    for (const { event } of reg.events) {
      if (event.section === 'contentRights' && event.method === 'ContentRegistered') {
        contentIds.push(event.data[0].toNumber());
      }
    }
  }
  console.log(`  Registered content IDs: ${contentIds.join(', ')}`);

  const allResults = {};

  // ── XCM Subscribe ──────────────────────────────────────────────────────
  console.log('\n── xcm_subscribe ──');
  allResults.xcm_subscribe = [];
  for (let run = 0; run < RUNS_PER_OPERATION; run++) {
    const cid = contentIds[run];
    const call = apiA.tx.contentRights.subscribe(cid);
    console.log(`  Run ${run + 1}/${RUNS_PER_OPERATION} (content ${cid})...`);
    const result = await sendXcmAndMeasure(apiA, apiB, call.method.toHex(), alice, `subscribe_${cid}`);
    allResults.xcm_subscribe.push(result);
    console.log(`    ${result.success ? 'OK' : 'FAIL'} | blockDelta: ${result.blockDelta} | wall: ${result.wallClockTotalMs}ms`);
  }

  // ── XCM Purchase Views ─────────────────────────────────────────────────
  console.log('\n── xcm_purchase_views ──');
  allResults.xcm_purchase_views = [];
  for (let run = 0; run < RUNS_PER_OPERATION; run++) {
    const cid = contentIds[run];
    const call = apiA.tx.contentRights.purchaseViews(cid, 5);
    console.log(`  Run ${run + 1}/${RUNS_PER_OPERATION} (content ${cid})...`);
    const result = await sendXcmAndMeasure(apiA, apiB, call.method.toHex(), alice, `purchase_views_${cid}`);
    allResults.xcm_purchase_views.push(result);
    console.log(`    ${result.success ? 'OK' : 'FAIL'} | blockDelta: ${result.blockDelta} | wall: ${result.wallClockTotalMs}ms`);
  }

  // ── XCM Purchase Ownership ─────────────────────────────────────────────
  console.log('\n── xcm_purchase_ownership ──');
  allResults.xcm_purchase_ownership = [];
  for (let run = 0; run < RUNS_PER_OPERATION; run++) {
    const cid = contentIds[run];
    const call = apiA.tx.contentRights.purchaseOwnership(cid);
    console.log(`  Run ${run + 1}/${RUNS_PER_OPERATION} (content ${cid})...`);
    const result = await sendXcmAndMeasure(apiA, apiB, call.method.toHex(), alice, `purchase_ownership_${cid}`);
    allResults.xcm_purchase_ownership.push(result);
    console.log(`    ${result.success ? 'OK' : 'FAIL'} | blockDelta: ${result.blockDelta} | wall: ${result.wallClockTotalMs}ms`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('\n── XCM Latency Summary ──');
  console.log('Operation               | Runs | Avg Block Delta | Avg Wall Clock (ms) | Success');
  console.log('────────────────────────|------|-----------------|---------------------|────────');
  for (const [name, runs] of Object.entries(allResults)) {
    const successful = runs.filter(r => r.success && r.blockDelta !== null);
    const avgDelta = successful.length > 0
      ? (successful.reduce((a, r) => a + r.blockDelta, 0) / successful.length).toFixed(1)
      : 'N/A';
    const avgWall = successful.length > 0
      ? Math.round(successful.reduce((a, r) => a + r.wallClockTotalMs, 0) / successful.length)
      : 'N/A';
    console.log(
      `${name.padEnd(24)}| ${String(runs.length).padStart(4)} | ${String(avgDelta).padStart(15)} | ${String(avgWall).padStart(19)} | ${successful.length}/${runs.length}`
    );
  }

  // ── Save ───────────────────────────────────────────────────────────────
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync('scripts/perf/results/xcm-latency-results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    paraA: PARA_A_WS,
    paraB: PARA_B_WS,
    relay: RELAY_WS,
    runsPerOperation: RUNS_PER_OPERATION,
    results: allResults,
  }, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Results saved to scripts/perf/results/xcm-latency-results.json');
  console.log('═══════════════════════════════════════════════════════════');

  await apiA.disconnect();
  await apiB.disconnect();
  await relayApi.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
