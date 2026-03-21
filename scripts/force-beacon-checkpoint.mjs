#!/usr/bin/env node
/**
 * Forces a beacon checkpoint on Bridge Hub via sudo XCM from relay chain.
 *
 * Reads the checkpoint hex from /tmp/snowbridge-v2/beacon-checkpoint.hex
 * and submits it as ethereumBeaconClient.forceCheckpoint via relay sudo XCM.
 *
 * @module forceBeaconCheckpoint
 *
 * Usage: node scripts/force-beacon-checkpoint.mjs [relay-ws-url]
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { readFileSync } from 'fs';

const RELAY_WS = process.argv[2] || 'ws://127.0.0.1:50882';
const BRIDGE_HUB_PARAID = 1013;

function sendAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
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
        resolve({ blockHash: status.asInBlock, events });
      } else if (status.isFinalized) {
        resolve({ blockHash: status.asFinalized, events });
      }
    });
  });
}

async function main() {
  // Read the checkpoint hex
  const checkpointHex = readFileSync('/tmp/snowbridge-v2/beacon-checkpoint.hex', 'utf8').trim();
  console.log(`Checkpoint hex length: ${checkpointHex.length} chars`);

  // Bridge Hub call: ethereumBeaconClient.forceCheckpoint
  // Pallet index 0x52 = 82, call index 0x00
  const transactCall = '0x5200' + checkpointHex;
  console.log(`Transact call length: ${transactCall.length} chars`);

  console.log(`\nConnecting to relay chain at ${RELAY_WS}...`);
  const provider = new WsProvider(RELAY_WS);
  const api = await ApiPromise.create({ provider });
  await api.isReady;

  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  console.log('Forcing beacon checkpoint on Bridge Hub via sudo XCM...');

  const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: BRIDGE_HUB_PARAID }] } } };
  const message = {
    V4: [
      { UnpaidExecution: { weight_limit: 'Unlimited' } },
      {
        Transact: {
          origin_kind: 'Superuser',
          require_weight_at_most: { ref_time: 500000000000, proof_size: 5000000 },
          call: { encoded: transactCall },
        },
      },
    ],
  };

  const tx = api.tx.sudo.sudo(api.tx.xcmPallet.send(dest, message));
  const result = await sendAndWait(api, tx, alice);
  console.log(`Beacon checkpoint forced on Bridge Hub. Block: ${result.blockHash}`);

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed to force beacon checkpoint:', e.message);
  process.exit(1);
});
