#!/usr/bin/env node
/**
 * Reliability test: uptime measurement and MTTR (Mean Time To Recovery).
 *
 * Phase 1: Monitors block production for 2 minutes to establish baseline.
 * Phase 2: Kills the collator, measures time to reconnect and resume blocks.
 * Phase 3: Verifies state integrity after restart.
 * Phase 4: Monitors post-recovery block production for 2 minutes.
 *
 * @module reliability-test
 *
 * Usage: node scripts/perf/reliability-test.mjs [parachain-ws]
 *
 * IMPORTANT: This script kills the collator process. It must be able to
 * find and restart it. The collator command line is extracted from the
 * running process.
 *
 * Output: scripts/perf/results/reliability-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync, spawn } from 'child_process';

const PARA_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const BASELINE_DURATION_MS = 120_000; // 2 minutes
const RECOVERY_DURATION_MS = 120_000; // 2 minutes
const SAMPLE_INTERVAL_MS = 2_000;

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

async function monitorBlocks(api, durationMs, label) {
  const samples = [];
  const startTime = Date.now();
  const endTime = startTime + durationMs;
  let lastBlock = null;

  while (Date.now() < endTime) {
    try {
      const header = await api.rpc.chain.getHeader();
      const blockNum = header.number.toNumber();
      const now = Date.now();

      if (lastBlock !== null && blockNum > lastBlock.block) {
        const blockDelta = blockNum - lastBlock.block;
        const timeDelta = now - lastBlock.time;
        samples.push({
          timestamp: now,
          block: blockNum,
          blockDelta,
          timeDeltaMs: timeDelta,
          avgBlockTimeMs: timeDelta / blockDelta,
        });
      }

      lastBlock = { block: blockNum, time: now };
      const elapsed = Math.round((now - startTime) / 1000);
      process.stdout.write(`\r  [${label}] ${elapsed}s — block ${blockNum}`);
    } catch {
      const now = Date.now();
      const elapsed = Math.round((now - startTime) / 1000);
      process.stdout.write(`\r  [${label}] ${elapsed}s — disconnected`);
    }
    await new Promise(r => setTimeout(r, SAMPLE_INTERVAL_MS));
  }
  console.log('');

  return samples;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Reliability Test: Uptime & MTTR');
  console.log('═══════════════════════════════════════════════════════════');

  // ── Phase 0: Setup ─────────────────────────────────────────────────────
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_WS) });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Find the collator PID and command
  const psOutput = execSync('ps aux | grep "parachain-template-node.*rpc-port 9990" | grep -v grep').toString();
  const collatorPid = psOutput.trim().split(/\s+/)[1];
  console.log(`  Collator PID: ${collatorPid}`);

  // Extract command from /proc or ps
  const cmdLine = execSync(`ps -o command= -p ${collatorPid}`).toString().trim();
  console.log(`  Command: ${cmdLine.substring(0, 100)}...`);

  // Register some content to verify state survives restart
  console.log('  Creating test state...');
  const hash = '0x' + Buffer.from('reliability-test-content').toString('hex').padEnd(64, '0');
  const reg = await sendAndWait(api, api.tx.contentRights.registerContent(
    hash, 'Reliability Test', 100, 10, 500, 100,
  ), alice);
  let testContentId = null;
  for (const { event } of reg.events) {
    if (event.section === 'contentRights' && event.method === 'ContentRegistered') {
      testContentId = event.data[0].toNumber();
    }
  }
  console.log(`  Test content ID: ${testContentId}`);

  // Subscribe to it
  await sendAndWait(api, api.tx.contentRights.subscribe(testContentId), alice);
  console.log('  Alice subscribed to test content.');
  await api.disconnect();

  // ── Phase 1: Baseline uptime (2 min) ──────────────────────────────────
  console.log('\n── Phase 1: Baseline block production (2 min) ──');
  const api1 = await ApiPromise.create({ provider: new WsProvider(PARA_WS) });
  const baselineStartBlock = (await api1.rpc.chain.getHeader()).number.toNumber();
  const baselineSamples = await monitorBlocks(api1, BASELINE_DURATION_MS, 'baseline');
  const baselineEndBlock = (await api1.rpc.chain.getHeader()).number.toNumber();
  await api1.disconnect();

  const baselineBlocksProduced = baselineEndBlock - baselineStartBlock;
  const expectedBlocks = Math.floor(BASELINE_DURATION_MS / 6000); // ~6s block time
  const baselineUptime = Math.min(100, (baselineBlocksProduced / expectedBlocks) * 100);
  const baselineAvgBlockTime = baselineSamples.length > 0
    ? baselineSamples.reduce((a, s) => a + s.avgBlockTimeMs, 0) / baselineSamples.length
    : 0;

  console.log(`  Blocks produced: ${baselineBlocksProduced} (expected ~${expectedBlocks})`);
  console.log(`  Uptime: ${baselineUptime.toFixed(1)}%`);
  console.log(`  Avg block time: ${(baselineAvgBlockTime / 1000).toFixed(2)}s`);

  // ── Phase 2: Kill collator and measure MTTR ────────────────────────────
  console.log('\n── Phase 2: Failure simulation (kill collator) ──');
  const killTime = Date.now();
  console.log(`  Killing collator PID ${collatorPid}...`);
  try {
    process.kill(parseInt(collatorPid), 'SIGTERM');
  } catch (e) {
    console.log(`  Kill failed: ${e.message}`);
  }
  console.log('  Collator killed.');

  // Wait a moment for process to die
  await new Promise(r => setTimeout(r, 3000));

  // Restart the collator
  console.log('  Restarting collator...');
  const restartTime = Date.now();
  const downtime = restartTime - killTime;

  // Parse command into args
  const cmdParts = cmdLine.split(/\s+/);
  const binary = cmdParts[0];
  const args = cmdParts.slice(1);

  const child = spawn(binary, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
  console.log(`  Restarted with PID ${child.pid}`);

  // Wait for RPC to come back
  console.log('  Waiting for RPC reconnection...');
  let reconnected = false;
  let reconnectTime = null;
  let firstBlockTime = null;
  let firstBlockAfterRestart = null;

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const testApi = await ApiPromise.create({
        provider: new WsProvider(PARA_WS, false),
        throwOnConnect: true,
      });
      await testApi.isReady;
      reconnectTime = Date.now();
      const header = await testApi.rpc.chain.getHeader();
      firstBlockAfterRestart = header.number.toNumber();
      firstBlockTime = Date.now();
      reconnected = true;
      await testApi.disconnect();
      break;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const mttrMs = reconnected ? reconnectTime - killTime : null;
  const totalDowntimeMs = reconnected ? firstBlockTime - killTime : null;

  console.log(`  Reconnected: ${reconnected}`);
  console.log(`  MTTR (to RPC ready): ${mttrMs ? (mttrMs / 1000).toFixed(1) + 's' : 'FAILED'}`);
  console.log(`  Total downtime (to first block): ${totalDowntimeMs ? (totalDowntimeMs / 1000).toFixed(1) + 's' : 'FAILED'}`);

  // ── Phase 3: State integrity verification ──────────────────────────────
  console.log('\n── Phase 3: State integrity verification ──');
  let stateIntact = false;
  if (reconnected) {
    await new Promise(r => setTimeout(r, 10000)); // Wait for blocks to stabilize

    const api3 = await ApiPromise.create({ provider: new WsProvider(PARA_WS) });

    // Verify content exists
    const content = await api3.query.contentRights.contents(testContentId);
    const contentExists = content.isSome;
    console.log(`  Content ${testContentId} exists: ${contentExists}`);

    // Verify subscription exists
    const sub = await api3.query.contentRights.subscriptions(testContentId, alice.address);
    const subExists = sub.isSome;
    console.log(`  Alice subscription exists: ${subExists}`);

    // Try a new transaction
    let newTxWorks = false;
    try {
      const hash2 = '0x' + Buffer.from('post-restart-content').toString('hex').padEnd(64, '0');
      await sendAndWait(api3, api3.tx.contentRights.registerContent(
        hash2, 'Post Restart', 100, 10, 500, 100,
      ), alice);
      newTxWorks = true;
    } catch (e) {
      console.log(`  New tx failed: ${e.message}`);
    }
    console.log(`  New transaction succeeds: ${newTxWorks}`);

    stateIntact = contentExists && subExists && newTxWorks;
    console.log(`  State integrity: ${stateIntact ? 'INTACT' : 'COMPROMISED'}`);

    await api3.disconnect();
  }

  // ── Phase 4: Post-recovery uptime (2 min) ──────────────────────────────
  console.log('\n── Phase 4: Post-recovery block production (2 min) ──');
  let recoverySamples = [];
  let recoveryBlocksProduced = 0;
  let recoveryUptime = 0;
  let recoveryAvgBlockTime = 0;

  if (reconnected) {
    await new Promise(r => setTimeout(r, 5000));
    const api4 = await ApiPromise.create({ provider: new WsProvider(PARA_WS) });
    const recoveryStartBlock = (await api4.rpc.chain.getHeader()).number.toNumber();
    recoverySamples = await monitorBlocks(api4, RECOVERY_DURATION_MS, 'recovery');
    const recoveryEndBlock = (await api4.rpc.chain.getHeader()).number.toNumber();

    recoveryBlocksProduced = recoveryEndBlock - recoveryStartBlock;
    recoveryUptime = Math.min(100, (recoveryBlocksProduced / expectedBlocks) * 100);
    recoveryAvgBlockTime = recoverySamples.length > 0
      ? recoverySamples.reduce((a, s) => a + s.avgBlockTimeMs, 0) / recoverySamples.length
      : 0;

    console.log(`  Blocks produced: ${recoveryBlocksProduced} (expected ~${expectedBlocks})`);
    console.log(`  Uptime: ${recoveryUptime.toFixed(1)}%`);
    console.log(`  Avg block time: ${(recoveryAvgBlockTime / 1000).toFixed(2)}s`);
    await api4.disconnect();
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' RELIABILITY TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Baseline uptime:            ${baselineUptime.toFixed(1)}%`);
  console.log(`  Baseline avg block time:    ${(baselineAvgBlockTime / 1000).toFixed(2)}s`);
  console.log(`  Baseline blocks (2 min):    ${baselineBlocksProduced}`);
  console.log(`  MTTR (RPC ready):           ${mttrMs ? (mttrMs / 1000).toFixed(1) + 's' : 'N/A'}`);
  console.log(`  Total downtime:             ${totalDowntimeMs ? (totalDowntimeMs / 1000).toFixed(1) + 's' : 'N/A'}`);
  console.log(`  State integrity:            ${stateIntact ? 'INTACT' : 'FAILED'}`);
  console.log(`  Recovery uptime:            ${recoveryUptime.toFixed(1)}%`);
  console.log(`  Recovery avg block time:    ${(recoveryAvgBlockTime / 1000).toFixed(2)}s`);
  console.log(`  Recovery blocks (2 min):    ${recoveryBlocksProduced}`);
  console.log('═══════════════════════════════════════════════════════════');

  // ── Save ───────────────────────────────────────────────────────────────
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync('scripts/perf/results/reliability-results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    baseline: {
      durationMs: BASELINE_DURATION_MS,
      blocksProduced: baselineBlocksProduced,
      expectedBlocks,
      uptimePct: baselineUptime,
      avgBlockTimeMs: baselineAvgBlockTime,
      samples: baselineSamples,
    },
    failure: {
      mttrMs,
      totalDowntimeMs,
      stateIntact,
    },
    recovery: {
      durationMs: RECOVERY_DURATION_MS,
      blocksProduced: recoveryBlocksProduced,
      uptimePct: recoveryUptime,
      avgBlockTimeMs: recoveryAvgBlockTime,
      samples: recoverySamples,
    },
  }, null, 2));

  console.log(' Results saved to scripts/perf/results/reliability-results.json');

  process.exit(0);
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
