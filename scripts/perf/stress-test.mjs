#!/usr/bin/env node
/**
 * Stress test: sustained high-concurrency load to find breaking points.
 *
 * Continuously submits transactions from 200 accounts as fast as possible
 * for 3 minutes, measuring when blocks overflow, tx pool backs up,
 * or transactions start failing.
 *
 * @module stress-test
 *
 * Usage: node scripts/perf/stress-test.mjs [parachain-ws] [prometheus-url]
 *
 * Output: scripts/perf/results/stress-test-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const PARA_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const PROMETHEUS_URL = process.argv[3] || 'http://127.0.0.1:54187/metrics';
const NUM_ACCOUNTS = 200;
const LOAD_DURATION_SECS = 180;
const POLL_INTERVAL_MS = 2000;

async function scrapeMetrics(url) {
  try {
    const resp = await fetch(url);
    const text = await resp.text();
    const get = (name) => {
      const match = text.match(new RegExp(`^${name}\\{[^}]*\\}\\s+([\\d.e+-]+)`, 'm'));
      return match ? parseFloat(match[1]) : null;
    };
    return {
      timestamp: Date.now(),
      blockHeight: get('substrate_block_height'),
      readyTxCount: get('substrate_ready_transactions_number'),
      blockConstructedCount: get('substrate_proposer_block_constructed_count'),
      blockConstructedSum: get('substrate_proposer_block_constructed_sum'),
      proposerTxCount: get('substrate_proposer_number_of_transactions'),
    };
  } catch {
    return { timestamp: Date.now() };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' STRESS TEST: Sustained High-Concurrency Load');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Accounts:  ${NUM_ACCOUNTS}`);
  console.log(`  Duration:  ${LOAD_DURATION_SECS}s`);
  console.log('');

  const api = await ApiPromise.create({ provider: new WsProvider(PARA_WS) });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Fund accounts sequentially with timeout
  console.log(`  Funding ${NUM_ACCOUNTS} accounts...`);
  const accounts = [];
  for (let i = 0; i < NUM_ACCOUNTS; i++) {
    const acct = keyring.addFromUri(`//StressUser${i}`);
    accounts.push(acct);
    await Promise.race([
      new Promise((resolve) => {
        api.tx.sudo.sudo(api.tx.balances.forceSetBalance(acct.address, '10000000000000000'))
          .signAndSend(alice, ({ status }) => {
            if (status.isInBlock) resolve();
          }).catch(() => resolve());
      }),
      new Promise((resolve) => setTimeout(resolve, 30000)), // 30s timeout
    ]);
    if ((i + 1) % 20 === 0) console.log(`    Funded ${i + 1}/${NUM_ACCOUNTS}`);
  }

  // Track metrics
  const samples = [];
  let totalSubmitted = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;
  let batchNumber = 0;
  let peakTxPool = 0;
  let peakTxPerBlock = 0;

  const startBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  const startTime = Date.now();
  const endTime = startTime + LOAD_DURATION_SECS * 1000;

  console.log(`\n  Starting stress load at block ${startBlock}...`);
  console.log('  Time  | Submitted | Succeeded | Failed | TxPool | Block | TPS');
  console.log('  ──────|───────────|───────────|────────|────────|───────|────');

  // Prometheus monitor (background)
  const monitorInterval = setInterval(async () => {
    const m = await scrapeMetrics(PROMETHEUS_URL);
    if (m.readyTxCount > peakTxPool) peakTxPool = m.readyTxCount;
    samples.push({ ...m, totalSubmitted, totalSucceeded, totalFailed });
  }, POLL_INTERVAL_MS);

  // Submit load continuously
  while (Date.now() < endTime) {
    batchNumber++;
    const batchAccounts = accounts.slice(0, Math.min(NUM_ACCOUNTS, 200));
    const batchPromises = batchAccounts.map((acct, i) => {
      const hash = '0x' + Buffer.from(`stress-${batchNumber}-${i}`).toString('hex').padEnd(64, '0');
      const tx = api.tx.contentRights.registerContent(hash, `S${batchNumber}-${i}`, 500000, 0, 0, 100);
      totalSubmitted++;
      return new Promise((resolve) => {
        tx.signAndSend(acct, ({ status, dispatchError }) => {
          if (dispatchError) { totalFailed++; resolve('fail'); }
          else if (status.isInBlock) { totalSucceeded++; resolve('ok'); }
        }).catch(() => { totalFailed++; resolve('fail'); });
      });
    });

    await Promise.all(batchPromises);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
    const m = await scrapeMetrics(PROMETHEUS_URL);
    const tps = elapsed > 0 ? (totalSucceeded / elapsed).toFixed(1) : '0';

    console.log(
      `  ${String(elapsed).padStart(4)}s | ${String(totalSubmitted).padStart(9)} | ` +
      `${String(totalSucceeded).padStart(9)} | ${String(totalFailed).padStart(6)} | ` +
      `${String(m.readyTxCount || 0).padStart(6)} | ${String(currentBlock).padStart(5)} | ${tps}`
    );
  }

  clearInterval(monitorInterval);

  const endBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  const totalTime = (Date.now() - startTime) / 1000;
  const blocksProduced = endBlock - startBlock;

  // Wait for pool to drain
  console.log('\n  Waiting for tx pool to drain...');
  await new Promise(r => setTimeout(r, 15000));
  const finalBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  const finalM = await scrapeMetrics(PROMETHEUS_URL);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' STRESS TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Duration:              ${totalTime.toFixed(1)}s`);
  console.log(`  Total submitted:       ${totalSubmitted}`);
  console.log(`  Total succeeded:       ${totalSucceeded}`);
  console.log(`  Total failed:          ${totalFailed}`);
  console.log(`  Success rate:          ${((totalSucceeded / totalSubmitted) * 100).toFixed(1)}%`);
  console.log(`  Sustained TPS:         ${(totalSucceeded / totalTime).toFixed(2)}`);
  console.log(`  Blocks produced:       ${blocksProduced} (during load) + ${finalBlock - endBlock} (drain)`);
  console.log(`  Avg txs/block:         ${(totalSucceeded / blocksProduced).toFixed(1)}`);
  console.log(`  Peak tx pool depth:    ${peakTxPool}`);
  console.log(`  Final tx pool depth:   ${finalM.readyTxCount || 0}`);
  console.log(`  Failure reasons:       ${totalFailed > 0 ? 'nonce conflicts / tx pool limits' : 'none'}`);
  console.log('═══════════════════════════════════════════════════════════');

  // Save
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync('scripts/perf/results/stress-test-results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    config: { numAccounts: NUM_ACCOUNTS, durationSecs: LOAD_DURATION_SECS },
    summary: {
      durationSecs: totalTime,
      totalSubmitted, totalSucceeded, totalFailed,
      successRate: totalSucceeded / totalSubmitted,
      sustainedTps: totalSucceeded / totalTime,
      blocksProduced,
      avgTxsPerBlock: totalSucceeded / blocksProduced,
      peakTxPoolDepth: peakTxPool,
    },
    samples,
  }, null, 2));

  console.log(' Results saved to scripts/perf/results/stress-test-results.json');

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Stress test failed:', e.message);
  process.exit(1);
});
