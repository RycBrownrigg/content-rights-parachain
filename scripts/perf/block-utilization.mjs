#!/usr/bin/env node
/**
 * Performance test: block weight saturation.
 *
 * Determines the maximum number of each extrinsic type that fits in a single
 * block by submitting increasingly large batches until transactions spill
 * into multiple blocks.
 *
 * @module block-utilization
 *
 * Usage: node scripts/perf/block-utilization.mjs [parachain-ws]
 * Default: ws://127.0.0.1:9990
 *
 * Output: scripts/perf/results/block-utilization-results.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const PARA_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const BATCH_SIZES = [50, 100, 150, 200, 300, 500];
const MAX_ACCOUNTS = 500;

function sendAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
    const tSubmit = Date.now();
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${decoded.section}.${decoded.name}`));
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
        });
      }
    });
  });
}

async function fundAccounts(api, sudo, accounts) {
  console.log(`  Funding ${accounts.length} accounts concurrently...`);
  // Send all funding txs concurrently with manual nonce management
  let nonce = (await api.rpc.system.accountNextIndex(sudo.address)).toNumber();
  const CHUNK = 50;
  for (let start = 0; start < accounts.length; start += CHUNK) {
    const chunk = accounts.slice(start, start + CHUNK);
    const promises = chunk.map((acct) => {
      const tx = api.tx.sudo.sudo(
        api.tx.balances.forceSetBalance(acct.address, '1000000000000000')
      );
      return new Promise((resolve, reject) => {
        tx.signAndSend(sudo, { nonce: nonce++ }, ({ status, dispatchError }) => {
          if (dispatchError) reject(new Error('fund failed'));
          if (status.isInBlock) resolve();
        });
      });
    });
    await Promise.all(promises);
    console.log(`    Funded ${Math.min(start + CHUNK, accounts.length)}/${accounts.length}`);
  }
  console.log('  All accounts funded.');
}

async function getBlockWeight(api, blockHash) {
  const weight = await api.query.system.blockWeight.at(blockHash);
  const maxBlock = api.consts.system.blockWeights;
  return {
    normal: {
      refTime: weight.normal.refTime.toBigInt(),
      proofSize: weight.normal.proofSize.toBigInt(),
    },
    maxBlock: {
      refTime: maxBlock.maxBlock.refTime.toBigInt(),
      proofSize: maxBlock.maxBlock.proofSize.toBigInt(),
    },
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Performance Test: Block Weight Saturation');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Chain: ${PARA_WS}`);
  console.log(`  Batch sizes: ${BATCH_SIZES.join(', ')}`);
  console.log('');

  const provider = new WsProvider(PARA_WS);
  const api = await ApiPromise.create({ provider });
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Generate accounts
  const accounts = [];
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    accounts.push(keyring.addFromUri(`//BlockUser${i}`));
  }
  await fundAccounts(api, alice, accounts);

  // Get max block weight for reference
  const maxBlock = api.consts.system.blockWeights;
  console.log(`\n  Max block weight: ref_time=${maxBlock.maxBlock.refTime.toBigInt()}, proof_size=${maxBlock.maxBlock.proofSize.toBigInt()}`);

  const allResults = {};

  // ── Test register_content (no nesting limit) ──────────────────────────
  console.log('\n── register_content (no nesting limit) ──');
  allResults.register_content = [];

  for (const batchSize of BATCH_SIZES) {
    const subset = accounts.slice(0, batchSize);
    console.log(`  Batch: ${batchSize}...`);

    const promises = subset.map((acct, i) => {
      const hash = '0x' + Buffer.from(`blk-${Date.now()}-${i}`).toString('hex').padEnd(64, '0');
      const tx = api.tx.contentRights.registerContent(hash, `Block Test ${i}`, 1000000, 0, 0, 100);
      return sendAndWait(api, tx, acct);
    });

    const settled = await Promise.allSettled(promises);
    const succeeded = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r) => r.status === 'rejected');

    // Collect unique blocks and their weights
    const blockMap = new Map();
    for (const r of succeeded) {
      const bh = r.value.blockHash;
      if (!blockMap.has(bh)) {
        const w = await getBlockWeight(api, bh);
        blockMap.set(bh, { weight: w, count: 0 });
      }
      blockMap.get(bh).count++;
    }

    const blockDetails = [];
    for (const [hash, data] of blockMap) {
      blockDetails.push({
        blockHash: hash,
        txCount: data.count,
        refTimeUsed: data.weight.normal.refTime.toString(),
        proofSizeUsed: data.weight.normal.proofSize.toString(),
        refTimeMax: data.weight.maxBlock.refTime.toString(),
        proofSizeMax: data.weight.maxBlock.proofSize.toString(),
        refTimePct: Number((data.weight.normal.refTime * 10000n) / data.weight.maxBlock.refTime) / 100,
        proofSizePct: data.weight.maxBlock.proofSize > 0n
          ? Number((data.weight.normal.proofSize * 10000n) / data.weight.maxBlock.proofSize) / 100
          : 0,
      });
    }

    const result = {
      batchSize,
      succeeded: succeeded.length,
      failed: failed.length,
      blocksUsed: blockMap.size,
      maxTxInOneBlock: Math.max(...blockDetails.map((b) => b.txCount)),
      blockDetails,
    };

    allResults.register_content.push(result);

    console.log(
      `    ${succeeded.length}/${batchSize} ok | ${blockMap.size} blocks | ` +
      `max ${result.maxTxInOneBlock}/block | ` +
      blockDetails.map((b) => `[${b.txCount} txs, ${b.refTimePct}% ref_time, ${b.proofSizePct}% proof_size]`).join(' ')
    );

    if (failed.length > 0) {
      const reasons = [...new Set(failed.map((r) => r.reason?.message || 'unknown'))];
      console.log(`    Errors: ${reasons.join(', ')}`);
    }

    // Stop if we got failures from weight exhaustion
    if (failed.length > 0 && failed.some((r) => r.reason?.message?.includes('Exhausted'))) {
      console.log('    Block weight exhausted — stopping escalation.');
      break;
    }
  }

  // ── Test check_access (read-heavy, no nesting limit) ──────────────────
  console.log('\n── check_access (read-heavy) ──');
  allResults.check_access = [];

  for (const batchSize of BATCH_SIZES) {
    const subset = accounts.slice(0, batchSize);
    console.log(`  Batch: ${batchSize}...`);

    const promises = subset.map((acct) => {
      const tx = api.tx.contentRights.checkAccess(0);
      return sendAndWait(api, tx, acct);
    });

    const settled = await Promise.allSettled(promises);
    const succeeded = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r) => r.status === 'rejected');

    const blockMap = new Map();
    for (const r of succeeded) {
      const bh = r.value.blockHash;
      if (!blockMap.has(bh)) {
        const w = await getBlockWeight(api, bh);
        blockMap.set(bh, { weight: w, count: 0 });
      }
      blockMap.get(bh).count++;
    }

    const blockDetails = [];
    for (const [hash, data] of blockMap) {
      blockDetails.push({
        blockHash: hash,
        txCount: data.count,
        refTimePct: Number((data.weight.normal.refTime * 10000n) / data.weight.maxBlock.refTime) / 100,
        proofSizePct: data.weight.maxBlock.proofSize > 0n
          ? Number((data.weight.normal.proofSize * 10000n) / data.weight.maxBlock.proofSize) / 100
          : 0,
      });
    }

    const result = {
      batchSize,
      succeeded: succeeded.length,
      failed: failed.length,
      blocksUsed: blockMap.size,
      maxTxInOneBlock: blockDetails.length > 0 ? Math.max(...blockDetails.map((b) => b.txCount)) : 0,
      blockDetails,
    };
    allResults.check_access.push(result);

    console.log(
      `    ${succeeded.length}/${batchSize} ok | ${blockMap.size} blocks | ` +
      `max ${result.maxTxInOneBlock}/block | ` +
      blockDetails.map((b) => `[${b.txCount} txs, ${b.refTimePct}% ref_time, ${b.proofSizePct}% proof_size]`).join(' ')
    );

    if (failed.length > 0) {
      const reasons = [...new Set(failed.map((r) => r.reason?.message || 'unknown'))];
      console.log(`    Errors: ${reasons.join(', ')}`);
    }
  }

  // ── Save Results ───────────────────────────────────────────────────────
  mkdirSync('scripts/perf/results', { recursive: true });
  const output = {
    timestamp: new Date().toISOString(),
    chain: PARA_WS,
    maxBlockWeight: {
      refTime: maxBlock.maxBlock.refTime.toBigInt().toString(),
      proofSize: maxBlock.maxBlock.proofSize.toBigInt().toString(),
    },
    results: allResults,
  };
  writeFileSync('scripts/perf/results/block-utilization-results.json', JSON.stringify(output, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Results saved to scripts/perf/results/block-utilization-results.json');
  console.log('═══════════════════════════════════════════════════════════');

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
