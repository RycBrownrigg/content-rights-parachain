#!/usr/bin/env node
/**
 * Performance test: local extrinsic throughput and latency.
 *
 * Measures TPS and inclusion latency for each pallet-content-rights extrinsic type
 * by submitting batches of concurrent transactions from multiple accounts.
 *
 * @module local-throughput
 *
 * Usage: node scripts/perf/local-throughput.mjs [parachain-ws]
 * Default: ws://127.0.0.1:9990
 *
 * Output: scripts/perf/results/throughput-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const PARA_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const NUM_ACCOUNTS = 100;
const BATCH_SIZES = [1, 10, 20, 50, 100];

// ─── Helpers ────────────────────────────────────────────────────────────────

function sendAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
    const tSubmit = Date.now();
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`));
        } else {
          reject(new Error(dispatchError.toString()));
        }
      }
      if (status.isInBlock) {
        resolve({
          blockHash: status.asInBlock.toHex(),
          tSubmit,
          tIncluded: Date.now(),
          latencyMs: Date.now() - tSubmit,
          events,
        });
      }
    });
  });
}

async function fundAccounts(api, sudo, accounts) {
  console.log(`  Funding ${accounts.length} test accounts...`);
  // No utility pallet — fund one at a time via sudo
  for (let i = 0; i < accounts.length; i++) {
    const tx = api.tx.sudo.sudo(
      api.tx.balances.forceSetBalance(accounts[i].address, '1000000000000000')
    );
    await sendAndWait(api, tx, sudo);
    if ((i + 1) % 20 === 0) console.log(`    Funded ${i + 1}/${accounts.length}`);
  }
  console.log('  All accounts funded.');
}

async function getBlockWeight(api, blockHash) {
  const weight = await api.query.system.blockWeight.at(blockHash);
  return {
    normal: {
      refTime: weight.normal.refTime.toBigInt(),
      proofSize: weight.normal.proofSize.toBigInt(),
    },
    mandatory: {
      refTime: weight.mandatory.refTime.toBigInt(),
      proofSize: weight.mandatory.proofSize.toBigInt(),
    },
  };
}

// ─── Test Runners ───────────────────────────────────────────────────────────

async function testRegisterContent(api, accounts, batchSize) {
  const subset = accounts.slice(0, batchSize);
  const promises = subset.map((acct, i) => {
    // registerContent(metadataHash, title, subscriptionPrice, ppvPrice, ownershipPrice, periodLength)
    const hash = '0x' + Buffer.from(`perf-${Date.now()}-${i}`).toString('hex').padEnd(64, '0');
    const tx = api.tx.contentRights.registerContent(
      hash,
      `Perf Test ${i}`,
      1000000, // subscriptionPrice
      0,       // ppvPrice
      0,       // ownershipPrice
      100,     // periodLength
    );
    return sendAndWait(api, tx, acct);
  });
  return Promise.allSettled(promises);
}

async function testSubscribe(api, accounts, batchSize, contentId) {
  const subset = accounts.slice(0, batchSize);
  const promises = subset.map((acct) => {
    const tx = api.tx.contentRights.subscribe(contentId);
    return sendAndWait(api, tx, acct);
  });
  return Promise.allSettled(promises);
}

async function testRenewSubscription(api, accounts, batchSize, contentId) {
  const subset = accounts.slice(0, batchSize);
  const promises = subset.map((acct) => {
    const tx = api.tx.contentRights.renewSubscription(contentId);
    return sendAndWait(api, tx, acct);
  });
  return Promise.allSettled(promises);
}

async function testPurchaseViews(api, accounts, batchSize, contentId) {
  const subset = accounts.slice(0, batchSize);
  const promises = subset.map((acct) => {
    const tx = api.tx.contentRights.purchaseViews(contentId, 5);
    return sendAndWait(api, tx, acct);
  });
  return Promise.allSettled(promises);
}

async function testConsumeView(api, accounts, batchSize, contentId) {
  const subset = accounts.slice(0, batchSize);
  const promises = subset.map((acct) => {
    const tx = api.tx.contentRights.consumeView(contentId);
    return sendAndWait(api, tx, acct);
  });
  return Promise.allSettled(promises);
}

async function testPurchaseOwnership(api, accounts, batchSize, contentId) {
  const subset = accounts.slice(0, batchSize);
  const promises = subset.map((acct) => {
    const tx = api.tx.contentRights.purchaseOwnership(contentId);
    return sendAndWait(api, tx, acct);
  });
  return Promise.allSettled(promises);
}

async function testCheckAccess(api, accounts, batchSize, contentId) {
  const subset = accounts.slice(0, batchSize);
  const promises = subset.map((acct) => {
    // checkAccess only takes contentId — caller is the signer
    const tx = api.tx.contentRights.checkAccess(contentId);
    return sendAndWait(api, tx, acct);
  });
  return Promise.allSettled(promises);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Performance Test: Local Extrinsic Throughput & Latency');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Chain: ${PARA_WS}`);
  console.log(`  Accounts: ${NUM_ACCOUNTS}`);
  console.log(`  Batch sizes: ${BATCH_SIZES.join(', ')}`);
  console.log('');

  const provider = new WsProvider(PARA_WS);
  const api = await ApiPromise.create({ provider });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Generate test accounts
  const accounts = [];
  for (let i = 0; i < NUM_ACCOUNTS; i++) {
    accounts.push(keyring.addFromUri(`//PerfUser${i}`));
  }

  // Fund all accounts
  await fundAccounts(api, alice, accounts);

  const allResults = {};

  // ── Register Content (creates unique content per account) ──────────────
  console.log('\n── register_content ──');
  allResults.register_content = {};
  for (const batchSize of BATCH_SIZES) {
    console.log(`  Batch size: ${batchSize}`);
    const tStart = Date.now();
    const settled = await testRegisterContent(api, accounts, batchSize);
    const tEnd = Date.now();
    const results = processResults(settled, tStart, tEnd, batchSize);
    allResults.register_content[batchSize] = results;
    printResults(results);
  }

  // Register content for subsequent tests (Alice registers 3 types)
  console.log('\n  Setting up content for remaining tests...');
  // Subscription content (id=0 from earlier tests, but let's make a fresh one)
  // registerContent(metadataHash, title, subscriptionPrice, ppvPrice, ownershipPrice, periodLength)
  const subHash = '0x' + Buffer.from('perf-subscription-content').toString('hex').padEnd(64, '0');
  const subReg = await sendAndWait(api, api.tx.contentRights.registerContent(
    subHash, 'Perf Subscription', 500000, 0, 0, 50,
  ), alice);
  // PPV content
  const ppvHash = '0x' + Buffer.from('perf-ppv-content').toString('hex').padEnd(64, '0');
  const ppvReg = await sendAndWait(api, api.tx.contentRights.registerContent(
    ppvHash, 'Perf PPV', 0, 100000, 0, 0,
  ), alice);
  // Ownership content
  const ownHash = '0x' + Buffer.from('perf-ownership-content').toString('hex').padEnd(64, '0');
  const ownReg = await sendAndWait(api, api.tx.contentRights.registerContent(
    ownHash, 'Perf Ownership', 0, 0, 2000000, 0,
  ), alice);

  // Get content IDs from events
  const subContentId = extractContentId(subReg.events);
  const ppvContentId = extractContentId(ppvReg.events);
  const ownContentId = extractContentId(ownReg.events);
  console.log(`  Subscription content: ${subContentId}, PPV: ${ppvContentId}, Ownership: ${ownContentId}`);

  // ── Subscribe (register fresh content per batch to avoid AlreadyExists) ─
  console.log('\n── subscribe ──');
  allResults.subscribe = {};
  for (const batchSize of BATCH_SIZES) {
    console.log(`  Batch size: ${batchSize}`);
    // Register fresh content for this batch
    const freshHash = '0x' + Buffer.from(`sub-batch-${batchSize}-${Date.now()}`).toString('hex').padEnd(64, '0');
    const freshReg = await sendAndWait(api, api.tx.contentRights.registerContent(
      freshHash, `Sub Batch ${batchSize}`, 500000, 0, 0, 50,
    ), alice);
    const freshId = extractContentId(freshReg.events);
    const tStart = Date.now();
    const settled = await testSubscribe(api, accounts, batchSize, freshId);
    const tEnd = Date.now();
    allResults.subscribe[batchSize] = processResults(settled, tStart, tEnd, batchSize);
    printResults(allResults.subscribe[batchSize]);
  }

  // ── Renew Subscription (skip — requires expired subscriptions) ─────────
  console.log('\n── renew_subscription ── (skipped — requires expired subscriptions)');

  // ── Purchase Views ─────────────────────────────────────────────────────
  console.log('\n── purchase_views ──');
  allResults.purchase_views = {};
  for (const batchSize of BATCH_SIZES) {
    console.log(`  Batch size: ${batchSize}`);
    const tStart = Date.now();
    const settled = await testPurchaseViews(api, accounts, batchSize, ppvContentId);
    const tEnd = Date.now();
    allResults.purchase_views[batchSize] = processResults(settled, tStart, tEnd, batchSize);
    printResults(allResults.purchase_views[batchSize]);
  }

  // ── Consume View ───────────────────────────────────────────────────────
  console.log('\n── consume_view ──');
  allResults.consume_view = {};
  for (const batchSize of BATCH_SIZES) {
    console.log(`  Batch size: ${batchSize}`);
    const tStart = Date.now();
    const settled = await testConsumeView(api, accounts, batchSize, ppvContentId);
    const tEnd = Date.now();
    allResults.consume_view[batchSize] = processResults(settled, tStart, tEnd, batchSize);
    printResults(allResults.consume_view[batchSize]);
  }

  // ── Purchase Ownership (fresh content per batch to avoid AlreadyOwned) ─
  console.log('\n── purchase_ownership ──');
  allResults.purchase_ownership = {};
  for (const batchSize of BATCH_SIZES) {
    console.log(`  Batch size: ${batchSize}`);
    const freshHash = '0x' + Buffer.from(`own-batch-${batchSize}-${Date.now()}`).toString('hex').padEnd(64, '0');
    const freshReg = await sendAndWait(api, api.tx.contentRights.registerContent(
      freshHash, `Own Batch ${batchSize}`, 0, 0, 2000000, 0,
    ), alice);
    const freshId = extractContentId(freshReg.events);
    const tStart = Date.now();
    const settled = await testPurchaseOwnership(api, accounts, batchSize, freshId);
    const tEnd = Date.now();
    allResults.purchase_ownership[batchSize] = processResults(settled, tStart, tEnd, batchSize);
    printResults(allResults.purchase_ownership[batchSize]);
  }

  // ── Check Access ───────────────────────────────────────────────────────
  console.log('\n── check_access ──');
  allResults.check_access = {};
  for (const batchSize of BATCH_SIZES) {
    console.log(`  Batch size: ${batchSize}`);
    const tStart = Date.now();
    const settled = await testCheckAccess(api, accounts, batchSize, subContentId);
    const tEnd = Date.now();
    allResults.check_access[batchSize] = processResults(settled, tStart, tEnd, batchSize);
    printResults(allResults.check_access[batchSize]);
  }

  // ── Save Results ───────────────────────────────────────────────────────
  mkdirSync('scripts/perf/results', { recursive: true });
  const output = {
    timestamp: new Date().toISOString(),
    chain: PARA_WS,
    numAccounts: NUM_ACCOUNTS,
    batchSizes: BATCH_SIZES,
    results: allResults,
  };
  writeFileSync('scripts/perf/results/throughput-results.json', JSON.stringify(output, null, 2));
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Results saved to scripts/perf/results/throughput-results.json');
  console.log('═══════════════════════════════════════════════════════════');

  // Print summary table
  console.log('\n── Summary (batch=20) ──');
  console.log('Extrinsic                | TPS    | Mean Latency | Success | Failed');
  console.log('─────────────────────────|--------|--------------|---------|-------');
  for (const [name, batches] of Object.entries(allResults)) {
    const r = batches[20] || batches[10] || batches[5] || batches[1];
    if (r) {
      console.log(
        `${name.padEnd(25)}| ${r.tps.toFixed(2).padStart(6)} | ${(r.meanLatencyMs + 'ms').padStart(12)} | ${String(r.succeeded).padStart(7)} | ${String(r.failed).padStart(5)}`
      );
    }
  }

  await api.disconnect();
  process.exit(0);
}

// ─── Result Processing ──────────────────────────────────────────────────────

function processResults(settled, tStart, tEnd, batchSize) {
  const succeeded = settled.filter((r) => r.status === 'fulfilled');
  const failed = settled.filter((r) => r.status === 'rejected');
  const latencies = succeeded.map((r) => r.value.latencyMs);
  const wallClockMs = tEnd - tStart;

  latencies.sort((a, b) => a - b);
  const meanLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  const medianLatency = latencies.length > 0
    ? latencies[Math.floor(latencies.length / 2)]
    : 0;
  const p95Latency = latencies.length > 0
    ? latencies[Math.floor(latencies.length * 0.95)]
    : 0;
  const minLatency = latencies.length > 0 ? latencies[0] : 0;
  const maxLatency = latencies.length > 0 ? latencies[latencies.length - 1] : 0;

  // Unique blocks used
  const blocks = new Set(succeeded.map((r) => r.value.blockHash));

  return {
    batchSize,
    succeeded: succeeded.length,
    failed: failed.length,
    failReasons: failed.map((r) => r.reason?.message || 'unknown'),
    wallClockMs,
    tps: succeeded.length > 0 ? (succeeded.length / (wallClockMs / 1000)) : 0,
    meanLatencyMs: meanLatency,
    medianLatencyMs: medianLatency,
    p95LatencyMs: p95Latency,
    minLatencyMs: minLatency,
    maxLatencyMs: maxLatency,
    blocksUsed: blocks.size,
  };
}

function printResults(r) {
  console.log(
    `    ${r.succeeded}/${r.batchSize} ok | TPS: ${r.tps.toFixed(2)} | ` +
    `Mean: ${r.meanLatencyMs}ms | P95: ${r.p95LatencyMs}ms | ` +
    `Blocks: ${r.blocksUsed} | Wall: ${r.wallClockMs}ms`
  );
  if (r.failed > 0) {
    console.log(`    Failed: ${r.failReasons.slice(0, 3).join(', ')}`);
  }
}

function extractContentId(events) {
  for (const { event } of events) {
    if (event.section === 'contentRights' && event.method === 'ContentRegistered') {
      return event.data[0].toNumber();
    }
  }
  return 0;
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
