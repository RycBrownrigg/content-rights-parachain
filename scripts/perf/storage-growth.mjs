#!/usr/bin/env node
/**
 * Performance test: storage growth analysis.
 *
 * Measures on-chain state size growth as content items and subscribers increase.
 * Registers content incrementally, adds subscribers, and measures the total
 * storage consumed by the content-rights pallet at each step.
 *
 * @module storage-growth
 *
 * Usage: node scripts/perf/storage-growth.mjs [parachain-ws]
 * Default: ws://127.0.0.1:9990
 *
 * Output: scripts/perf/results/storage-growth-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const PARA_WS = process.argv[2] || 'ws://127.0.0.1:9990';

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

function extractContentId(events) {
  for (const { event } of events) {
    if (event.section === 'contentRights' && event.method === 'ContentRegistered') {
      return event.data[0].toNumber();
    }
  }
  return -1;
}

async function measurePalletStorage(api) {
  // Count entries in each storage map
  const contentEntries = await api.query.contentRights.contents.entries();
  const subscriptionEntries = await api.query.contentRights.subscriptions.entries();
  const viewPackEntries = await api.query.contentRights.viewPacks.entries();
  const ownershipEntries = await api.query.contentRights.ownership.entries();

  // Estimate bytes from encoded sizes
  let totalBytes = 0;
  let contentBytes = 0;
  let subscriptionBytes = 0;
  let viewPackBytes = 0;
  let ownershipBytes = 0;

  for (const [key, value] of contentEntries) {
    const entrySize = key.toU8a().length + value.toU8a().length;
    contentBytes += entrySize;
    totalBytes += entrySize;
  }
  for (const [key, value] of subscriptionEntries) {
    const entrySize = key.toU8a().length + value.toU8a().length;
    subscriptionBytes += entrySize;
    totalBytes += entrySize;
  }
  for (const [key, value] of viewPackEntries) {
    const entrySize = key.toU8a().length + value.toU8a().length;
    viewPackBytes += entrySize;
    totalBytes += entrySize;
  }
  for (const [key, value] of ownershipEntries) {
    const entrySize = key.toU8a().length + value.toU8a().length;
    ownershipBytes += entrySize;
    totalBytes += entrySize;
  }

  return {
    contentCount: contentEntries.length,
    subscriptionCount: subscriptionEntries.length,
    viewPackCount: viewPackEntries.length,
    ownershipCount: ownershipEntries.length,
    contentBytes,
    subscriptionBytes,
    viewPackBytes,
    ownershipBytes,
    totalBytes,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Performance Test: Storage Growth Analysis');
  console.log('═══════════════════════════════════════════════════════════');

  const provider = new WsProvider(PARA_WS);
  const api = await ApiPromise.create({ provider });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Fund subscriber accounts
  const subscribers = [];
  const SUB_COUNT = 40;
  console.log(`\n  Funding ${SUB_COUNT} subscriber accounts...`);
  let nonce = (await api.rpc.system.accountNextIndex(alice.address)).toNumber();
  const fundPromises = [];
  for (let i = 0; i < SUB_COUNT; i++) {
    const acct = keyring.addFromUri(`//StorageUser${i}`);
    subscribers.push(acct);
    const tx = api.tx.sudo.sudo(api.tx.balances.forceSetBalance(acct.address, '1000000000000000'));
    fundPromises.push(new Promise((resolve, reject) => {
      tx.signAndSend(alice, { nonce: nonce++ }, ({ status, dispatchError }) => {
        if (dispatchError) reject(new Error('fund failed'));
        if (status.isInBlock) resolve();
      });
    }));
  }
  await Promise.all(fundPromises);
  console.log('  Funded.');

  const results = [];

  // ── Baseline: empty state ──────────────────────────────────────────────
  console.log('\n── Baseline (empty) ──');
  const baseline = await measurePalletStorage(api);
  results.push({ phase: 'baseline', ...baseline });
  console.log(`  Total: ${baseline.totalBytes} bytes (${baseline.contentCount} content, ${baseline.subscriptionCount} subs)`);

  // ── Phase 1: Register content incrementally ────────────────────────────
  const CONTENT_STEPS = [1, 5, 10, 25, 50];
  let totalContentRegistered = 0;
  const contentIds = [];

  console.log('\n── Phase 1: Content Registration Growth ──');
  for (const target of CONTENT_STEPS) {
    const toRegister = target - totalContentRegistered;
    if (toRegister <= 0) continue;

    for (let i = 0; i < toRegister; i++) {
      const hash = '0x' + Buffer.from(`storage-${Date.now()}-${totalContentRegistered + i}`).toString('hex').padEnd(64, '0');
      const reg = await sendAndWait(api, api.tx.contentRights.registerContent(
        hash, `Content ${totalContentRegistered + i}`, 500000, 100000, 2000000, 100,
      ), alice);
      contentIds.push(extractContentId(reg.events));
    }
    totalContentRegistered = target;

    const measurement = await measurePalletStorage(api);
    results.push({ phase: `content_${target}`, ...measurement });
    const perContent = measurement.contentCount > 0 ? Math.round(measurement.contentBytes / measurement.contentCount) : 0;
    console.log(`  ${target} content items: ${measurement.contentBytes} bytes (${perContent} bytes/content)`);
  }

  // ── Phase 2: Add subscribers to first content item ─────────────────────
  const SUB_STEPS = [1, 5, 10, 20, 40];
  let totalSubscribed = 0;
  const targetContentId = contentIds[0];

  console.log(`\n── Phase 2: Subscriber Growth (content ${targetContentId}) ──`);
  for (const target of SUB_STEPS) {
    const toSubscribe = target - totalSubscribed;
    if (toSubscribe <= 0) continue;

    for (let i = totalSubscribed; i < target; i++) {
      try {
        await sendAndWait(api, api.tx.contentRights.subscribe(targetContentId), subscribers[i]);
      } catch (e) {
        console.log(`    Sub ${i} failed: ${e.message}`);
        break;
      }
    }
    totalSubscribed = target;

    const measurement = await measurePalletStorage(api);
    results.push({ phase: `subs_${target}`, ...measurement });
    const perSub = measurement.subscriptionCount > 0 ? Math.round(measurement.subscriptionBytes / measurement.subscriptionCount) : 0;
    console.log(`  ${target} subscribers: ${measurement.subscriptionBytes} bytes (${perSub} bytes/sub), total: ${measurement.totalBytes} bytes`);
  }

  // ── Phase 3: Add PPV view packs ────────────────────────────────────────
  const ppvContentId = contentIds[1] || contentIds[0];
  console.log(`\n── Phase 3: PPV View Pack Growth (content ${ppvContentId}) ──`);
  const PPV_STEPS = [1, 5, 10, 20];
  let totalPPV = 0;

  for (const target of PPV_STEPS) {
    const toPurchase = target - totalPPV;
    if (toPurchase <= 0) continue;

    for (let i = totalPPV; i < target; i++) {
      try {
        await sendAndWait(api, api.tx.contentRights.purchaseViews(ppvContentId, 10), subscribers[i]);
      } catch (e) {
        console.log(`    PPV ${i} failed: ${e.message}`);
        break;
      }
    }
    totalPPV = target;

    const measurement = await measurePalletStorage(api);
    results.push({ phase: `ppv_${target}`, ...measurement });
    const perPack = measurement.viewPackCount > 0 ? Math.round(measurement.viewPackBytes / measurement.viewPackCount) : 0;
    console.log(`  ${target} view packs: ${measurement.viewPackBytes} bytes (${perPack} bytes/pack), total: ${measurement.totalBytes} bytes`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('\n── Storage Growth Summary ──');
  console.log('Phase                    | Content | Subs | ViewPacks | Own  | Total Bytes');
  console.log('─────────────────────────|---------|------|-----------|------|───────────');
  for (const r of results) {
    console.log(
      `${r.phase.padEnd(25)}| ${String(r.contentCount).padStart(7)} | ${String(r.subscriptionCount).padStart(4)} | ${String(r.viewPackCount).padStart(9)} | ${String(r.ownershipCount).padStart(4)} | ${String(r.totalBytes).padStart(11)}`
    );
  }

  // Compute per-item averages
  const lastContent = results.find(r => r.phase === 'content_50');
  const lastSubs = results.find(r => r.phase.startsWith('subs_') && r.subscriptionCount > 0);
  const lastPPV = results.find(r => r.phase.startsWith('ppv_') && r.viewPackCount > 0);

  if (lastContent) {
    console.log(`\n  Avg bytes per content item: ${Math.round(lastContent.contentBytes / lastContent.contentCount)}`);
  }
  if (lastSubs) {
    console.log(`  Avg bytes per subscription: ${Math.round(lastSubs.subscriptionBytes / lastSubs.subscriptionCount)}`);
  }
  if (lastPPV) {
    console.log(`  Avg bytes per view pack: ${Math.round(lastPPV.viewPackBytes / lastPPV.viewPackCount)}`);
  }

  // ── Save Results ───────────────────────────────────────────────────────
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync('scripts/perf/results/storage-growth-results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    chain: PARA_WS,
    results,
  }, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Results saved to scripts/perf/results/storage-growth-results.json');
  console.log('═══════════════════════════════════════════════════════════');

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
