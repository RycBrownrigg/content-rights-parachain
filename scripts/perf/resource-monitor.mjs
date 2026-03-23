#!/usr/bin/env node
/**
 * Performance test: resource utilisation monitor.
 *
 * Scrapes Prometheus metrics from a parachain collator during a configurable
 * window, recording block production time, transaction pool depth, database
 * cache, and block height. Optionally runs a load generator concurrently.
 *
 * @module resource-monitor
 *
 * Usage:
 *   node scripts/perf/resource-monitor.mjs [prometheus-url] [parachain-ws] [duration-secs]
 *
 * Defaults:
 *   prometheus: http://127.0.0.1:54187/metrics
 *   parachain:  ws://127.0.0.1:9990
 *   duration:   120 (seconds)
 *
 * Output: scripts/perf/results/resource-monitor-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const PROMETHEUS_URL = process.argv[2] || 'http://127.0.0.1:54187/metrics';
const PARA_WS = process.argv[3] || 'ws://127.0.0.1:9990';
const DURATION_SECS = parseInt(process.argv[4] || '120');
const POLL_INTERVAL_MS = 3000;

async function scrapeMetrics(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  const metrics = {};

  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;

    // Parse simple gauge/counter metrics
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?.*?\}?\s+([\d.e+-]+)$/);
    if (match) {
      const [, name, value] = match;
      if (!metrics[name]) metrics[name] = [];
      metrics[name].push(parseFloat(value));
    }
  }

  return {
    timestamp: Date.now(),
    blockHeight: getFirst(metrics, 'substrate_block_height'),
    dbCacheBytes: getFirst(metrics, 'substrate_database_cache_bytes'),
    readyTxCount: getFirst(metrics, 'substrate_ready_transactions_number'),
    blockConstructedCount: getFirst(metrics, 'substrate_proposer_block_constructed_count'),
    blockConstructedSum: getFirst(metrics, 'substrate_proposer_block_constructed_sum'),
    proposerTxCount: getFirst(metrics, 'substrate_proposer_number_of_transactions'),
    blockProposalCount: getFirst(metrics, 'substrate_proposer_block_proposal_time_count'),
    blockProposalSum: getFirst(metrics, 'substrate_proposer_block_proposal_time_sum'),
    rpcCallsStarted: getFirst(metrics, 'substrate_rpc_calls_started'),
    rpcCallsFinished: getFirst(metrics, 'substrate_rpc_calls_finished'),
    tasksSpawned: getFirst(metrics, 'substrate_tasks_spawned_total'),
  };
}

function getFirst(metrics, name) {
  const vals = metrics[name];
  return vals && vals.length > 0 ? vals[0] : null;
}

function sendAndWait(api, tx, signer, nonce) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, { nonce }, ({ status, dispatchError }) => {
      if (dispatchError) reject(new Error('tx failed'));
      if (status.isInBlock) resolve();
    });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Performance Test: Resource Utilisation Monitor');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Prometheus: ${PROMETHEUS_URL}`);
  console.log(`  Parachain:  ${PARA_WS}`);
  console.log(`  Duration:   ${DURATION_SECS}s`);
  console.log(`  Poll:       every ${POLL_INTERVAL_MS}ms`);
  console.log('');

  // Verify Prometheus is accessible
  try {
    const test = await scrapeMetrics(PROMETHEUS_URL);
    console.log(`  Prometheus OK — block height: ${test.blockHeight}`);
  } catch (e) {
    console.error(`  ERROR: Cannot reach Prometheus at ${PROMETHEUS_URL}`);
    process.exit(1);
  }

  const api = await ApiPromise.create({ provider: new WsProvider(PARA_WS) });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Fund load test accounts
  const LOAD_ACCOUNTS = 20;
  const accounts = [];
  console.log(`  Funding ${LOAD_ACCOUNTS} load accounts...`);
  let nonce = (await api.rpc.system.accountNextIndex(alice.address)).toNumber();
  const fundPromises = [];
  for (let i = 0; i < LOAD_ACCOUNTS; i++) {
    const acct = keyring.addFromUri(`//LoadUser${i}`);
    accounts.push(acct);
    fundPromises.push(new Promise((resolve, reject) => {
      api.tx.sudo.sudo(api.tx.balances.forceSetBalance(acct.address, '1000000000000000'))
        .signAndSend(alice, { nonce: nonce++ }, ({ status, dispatchError }) => {
          if (dispatchError) reject(new Error('fund failed'));
          if (status.isInBlock) resolve();
        });
    }));
  }
  await Promise.all(fundPromises);
  console.log('  Funded.');

  // ── Phase 1: Idle baseline (30s) ──────────────────────────────────────
  console.log('\n── Phase 1: Idle baseline (30s) ──');
  const idleSamples = [];
  const idleEnd = Date.now() + 30000;
  while (Date.now() < idleEnd) {
    const sample = await scrapeMetrics(PROMETHEUS_URL);
    sample.phase = 'idle';
    idleSamples.push(sample);
    console.log(`  [idle] block=${sample.blockHeight} txPool=${sample.readyTxCount} dbCache=${Math.round((sample.dbCacheBytes||0)/1024/1024)}MB`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // ── Phase 2: Sustained load (60s) ─────────────────────────────────────
  console.log('\n── Phase 2: Sustained load (60s) ──');
  const loadSamples = [];
  let loadTxCount = 0;

  // Start load generator in background
  const loadEnd = Date.now() + 60000;
  const loadGenerator = (async () => {
    while (Date.now() < loadEnd) {
      const batch = accounts.map((acct, i) => {
        const hash = '0x' + Buffer.from(`load-${Date.now()}-${i}`).toString('hex').padEnd(64, '0');
        return api.tx.contentRights.registerContent(hash, `Load ${loadTxCount + i}`, 500000, 0, 0, 100);
      });
      const promises = batch.map((tx, i) => {
        return new Promise((resolve) => {
          tx.signAndSend(accounts[i], ({ status }) => {
            if (status.isInBlock) { loadTxCount++; resolve(); }
          }).catch(() => resolve());
        });
      });
      await Promise.all(promises);
    }
  })();

  // Monitor during load
  while (Date.now() < loadEnd) {
    const sample = await scrapeMetrics(PROMETHEUS_URL);
    sample.phase = 'load';
    sample.loadTxSubmitted = loadTxCount;
    loadSamples.push(sample);
    console.log(`  [load] block=${sample.blockHeight} txPool=${sample.readyTxCount} txSubmitted=${loadTxCount} dbCache=${Math.round((sample.dbCacheBytes||0)/1024/1024)}MB`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  await loadGenerator;
  console.log(`  Total load txs submitted: ${loadTxCount}`);

  // ── Phase 3: Cooldown (30s) ───────────────────────────────────────────
  console.log('\n── Phase 3: Cooldown (30s) ──');
  const cooldownSamples = [];
  const coolEnd = Date.now() + 30000;
  while (Date.now() < coolEnd) {
    const sample = await scrapeMetrics(PROMETHEUS_URL);
    sample.phase = 'cooldown';
    cooldownSamples.push(sample);
    console.log(`  [cool] block=${sample.blockHeight} txPool=${sample.readyTxCount} dbCache=${Math.round((sample.dbCacheBytes||0)/1024/1024)}MB`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // ── Analysis ──────────────────────────────────────────────────────────
  const allSamples = [...idleSamples, ...loadSamples, ...cooldownSamples];

  // Compute block construction rate
  const firstLoad = loadSamples[0];
  const lastLoad = loadSamples[loadSamples.length - 1];
  const blocksConstructedDuringLoad = (lastLoad?.blockConstructedCount || 0) - (firstLoad?.blockConstructedCount || 0);
  const loadDurationSecs = ((lastLoad?.timestamp || 0) - (firstLoad?.timestamp || 0)) / 1000;
  const avgBlockTimeDuringLoad = blocksConstructedDuringLoad > 0 ? loadDurationSecs / blocksConstructedDuringLoad : 0;

  // Avg block construction time
  const constructTimeDelta = (lastLoad?.blockConstructedSum || 0) - (firstLoad?.blockConstructedSum || 0);
  const avgConstructMs = blocksConstructedDuringLoad > 0 ? (constructTimeDelta / blocksConstructedDuringLoad * 1000) : 0;

  // DB cache
  const idleDbCache = idleSamples.length > 0 ? Math.round(idleSamples[idleSamples.length - 1].dbCacheBytes / 1024 / 1024) : 0;
  const loadDbCache = lastLoad ? Math.round(lastLoad.dbCacheBytes / 1024 / 1024) : 0;
  const coolDbCache = cooldownSamples.length > 0 ? Math.round(cooldownSamples[cooldownSamples.length - 1].dbCacheBytes / 1024 / 1024) : 0;

  console.log('\n── Resource Monitor Summary ──');
  console.log(`  Blocks constructed during load: ${blocksConstructedDuringLoad}`);
  console.log(`  Load duration: ${loadDurationSecs.toFixed(1)}s`);
  console.log(`  Avg block time during load: ${avgBlockTimeDuringLoad.toFixed(2)}s`);
  console.log(`  Avg block construction time: ${avgConstructMs.toFixed(2)}ms`);
  console.log(`  Total txs submitted: ${loadTxCount}`);
  console.log(`  Effective TPS: ${(loadTxCount / loadDurationSecs).toFixed(2)}`);
  console.log(`  DB cache (idle): ${idleDbCache} MB`);
  console.log(`  DB cache (load): ${loadDbCache} MB`);
  console.log(`  DB cache (cool): ${coolDbCache} MB`);

  // ── Save ───────────────────────────────────────────────────────────────
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync('scripts/perf/results/resource-monitor-results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    prometheusUrl: PROMETHEUS_URL,
    parachain: PARA_WS,
    durationSecs: DURATION_SECS,
    summary: {
      blocksConstructedDuringLoad,
      loadDurationSecs,
      avgBlockTimeSecs: avgBlockTimeDuringLoad,
      avgBlockConstructMs: avgConstructMs,
      totalLoadTxs: loadTxCount,
      effectiveTps: loadTxCount / loadDurationSecs,
      dbCacheIdleMB: idleDbCache,
      dbCacheLoadMB: loadDbCache,
      dbCacheCooldownMB: coolDbCache,
    },
    samples: allSamples,
  }, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Results saved to scripts/perf/results/resource-monitor-results.json');
  console.log('═══════════════════════════════════════════════════════════');

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
