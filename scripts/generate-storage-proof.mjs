#!/usr/bin/env node
/**
 * Generate a Merkle storage proof for content rights verification.
 *
 * Queries a parachain's storage for a specific content-rights entry and
 * generates a storage proof that can be submitted to the rights-verifier
 * pallet on another chain.
 *
 * @module generate-storage-proof
 *
 * Exports: (none — CLI entry point)
 *
 * Usage:
 *   node scripts/generate-storage-proof.mjs <storage-type> <content-id> <account> [ws-url]
 *
 * Arguments:
 *   storage-type  One of: ownership, subscription, viewpack
 *   content-id    Numeric content ID (e.g. 0)
 *   account       SS58 address of the account to check
 *   ws-url        WebSocket URL of the source parachain (default: ws://127.0.0.1:9990)
 *
 * Examples:
 *   node scripts/generate-storage-proof.mjs ownership 0 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
 *   node scripts/generate-storage-proof.mjs subscription 0 5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty ws://127.0.0.1:9990
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import { xxhashAsHex, blake2AsHex } from '@polkadot/util-crypto';
import { u8aConcat, u8aToHex, hexToU8a, compactAddLength } from '@polkadot/util';
import { decodeAddress } from '@polkadot/keyring';

const STORAGE_TYPES = {
  ownership: 'Ownership',
  subscription: 'Subscriptions',
  viewpack: 'ViewPacks',
};

const PALLET_NAME = 'ContentRights';

/** Builds the full storage key for a ContentRights StorageDoubleMap entry. */
function buildStorageKey(storageName, contentId, accountBytes) {
  // Twox128(pallet)
  const palletHash = xxhashAsHex(PALLET_NAME, 128).slice(2);
  // Twox128(storage)
  const storageHash = xxhashAsHex(storageName, 128).slice(2);

  // Blake2_128Concat(content_id as u32 LE)
  const contentIdBytes = new Uint8Array(4);
  new DataView(contentIdBytes.buffer).setUint32(0, contentId, true);
  const contentIdHex = u8aToHex(contentIdBytes).slice(2);
  const key1Hash = blake2AsHex(contentIdBytes, 128).slice(2) + contentIdHex;

  // Blake2_128Concat(account)
  const accountHex = u8aToHex(accountBytes).slice(2);
  const key2Hash = blake2AsHex(accountBytes, 128).slice(2) + accountHex;

  return '0x' + palletHash + storageHash + key1Hash + key2Hash;
}

async function main() {
  const storageType = process.argv[2];
  const contentId = parseInt(process.argv[3], 10);
  const account = process.argv[4];
  const wsUrl = process.argv[5] || 'ws://127.0.0.1:9990';

  if (!storageType || isNaN(contentId) || !account) {
    console.error('Usage: node generate-storage-proof.mjs <ownership|subscription|viewpack> <content-id> <account> [ws-url]');
    process.exit(1);
  }

  const storageName = STORAGE_TYPES[storageType.toLowerCase()];
  if (!storageName) {
    console.error(`Unknown storage type: ${storageType}. Use: ownership, subscription, viewpack`);
    process.exit(1);
  }

  const accountBytes = decodeAddress(account);
  const storageKey = buildStorageKey(storageName, contentId, accountBytes);

  console.log(`\n=== Storage Proof Generator ===`);
  console.log(`  Chain:        ${wsUrl}`);
  console.log(`  Pallet:       ${PALLET_NAME}`);
  console.log(`  Storage:      ${storageName}`);
  console.log(`  Content ID:   ${contentId}`);
  console.log(`  Account:      ${account}`);
  console.log(`  Storage key:  ${storageKey}`);
  console.log();

  const provider = new WsProvider(wsUrl);
  const api = await ApiPromise.create({ provider });

  try {
    // Get the current block hash for the proof
    const blockHash = await api.rpc.chain.getBlockHash();
    console.log(`  Block hash:   ${blockHash.toHex()}`);

    // Read the current value (for display)
    const value = await api.rpc.state.getStorage(storageKey, blockHash);
    console.log(`  Value:        ${value.toHex() || '(empty — key not found)'}`);

    // Generate the read proof
    const proof = await api.rpc.state.getReadProof([storageKey], blockHash);
    const stateRoot = proof.at.toHex();
    const proofNodes = proof.proof.map(node => node.toHex());

    console.log(`  State root:   ${stateRoot}`);
    console.log(`  Proof nodes:  ${proofNodes.length}`);
    console.log();

    // Output as JSON for programmatic use
    const output = {
      storage_type: storageName,
      content_id: contentId,
      account,
      storage_key: storageKey,
      block_hash: blockHash.toHex(),
      state_root: stateRoot,
      proof: proofNodes,
      value: value.toHex() || null,
    };

    console.log('=== JSON Output (for extrinsic submission) ===');
    console.log(JSON.stringify(output, null, 2));
    console.log();

    // Show how to submit the verification extrinsic
    const verifyCall = storageType.toLowerCase() === 'ownership'
      ? 'verifyOwnership'
      : storageType.toLowerCase() === 'subscription'
        ? 'verifySubscription'
        : 'verifyViewPack';

    console.log('=== Submission ===');
    console.log(`To verify on the consumer chain, submit:`);
    console.log(`  api.tx.rightsVerifier.${verifyCall}(`);
    console.log(`    "${stateRoot}",          // state_root`);
    console.log(`    ${JSON.stringify(proofNodes)},  // proof`);
    console.log(`    ${contentId},                    // content_id`);
    console.log(`    "${account}"             // who`);
    console.log(`  )`);
    console.log();

  } finally {
    await api.disconnect();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
