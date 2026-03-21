#!/usr/bin/env node
/**
 * Debug version: Forces beacon checkpoint on Bridge Hub with event monitoring.
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { readFileSync } from 'fs';

const RELAY_WS = 'ws://127.0.0.1:50882';
const BRIDGE_HUB_WS = 'ws://127.0.0.1:8943';

async function main() {
  const checkpointHex = readFileSync('/tmp/snowbridge-v2/beacon-checkpoint.hex', 'utf8').trim();
  console.log(`Checkpoint hex length: ${checkpointHex.length}`);

  // Connect to both relay and bridge hub
  const relayApi = await ApiPromise.create({ provider: new WsProvider(RELAY_WS) });
  const bhApi = await ApiPromise.create({ provider: new WsProvider(BRIDGE_HUB_WS) });
  await relayApi.isReady;
  await bhApi.isReady;

  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Subscribe to Bridge Hub events before sending
  console.log('\nSubscribing to Bridge Hub events...');
  const unsub = await bhApi.query.system.events((events) => {
    events.forEach((record) => {
      const { event } = record;
      if (event.section === 'messageQueue' || event.section === 'ethereumBeaconClient') {
        console.log(`[BH Event] ${event.section}.${event.method}:`, JSON.stringify(event.data.toHuman()));
      }
    });
  });

  // Also check relay chain events
  const unsub2 = await relayApi.query.system.events((events) => {
    events.forEach((record) => {
      const { event } = record;
      if (event.section === 'xcmPallet' || event.section === 'sudo') {
        console.log(`[Relay Event] ${event.section}.${event.method}:`, JSON.stringify(event.data.toHuman()));
      }
    });
  });

  const transactCall = '0x5200' + checkpointHex;

  // Method 1: Try with smaller test call first
  console.log('\n--- Test: Simple system.remark on Bridge Hub via XCM ---');
  const testCall = '0x0007' + '04' + '2a'; // system.remarkWithEvent with tiny data
  const testDest = { V4: { parents: 0, interior: { X1: [{ Parachain: 1013 }] } } };
  const testMsg = {
    V4: [
      { UnpaidExecution: { weight_limit: 'Unlimited' } },
      {
        Transact: {
          origin_kind: 'Superuser',
          require_weight_at_most: { ref_time: 1000000000, proof_size: 10000 },
          call: { encoded: testCall },
        },
      },
    ],
  };

  const testTx = relayApi.tx.sudo.sudo(relayApi.tx.xcmPallet.send(testDest, testMsg));

  await new Promise((resolve, reject) => {
    testTx.signAndSend(alice, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        if (dispatchError.isModule) {
          const decoded = relayApi.registry.findMetaError(dispatchError.asModule);
          console.log(`[Relay Error] ${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`);
          reject(new Error(decoded.name));
        } else {
          console.log(`[Relay Error] ${dispatchError.toString()}`);
          reject(new Error(dispatchError.toString()));
        }
      }
      if (status.isInBlock) {
        console.log(`[Relay] Test call included in block ${status.asInBlock}`);
        events.forEach(({ event }) => {
          if (event.section === 'xcmPallet' || event.section === 'sudo') {
            console.log(`  ${event.section}.${event.method}:`, JSON.stringify(event.data.toHuman()));
          }
        });
        resolve();
      }
    });
  });

  // Wait for Bridge Hub to process
  console.log('Waiting 30s for BH to process...');
  await new Promise(r => setTimeout(r, 30000));

  // Check beacon state
  const root = await bhApi.query.ethereumBeaconClient.latestFinalizedBlockRoot();
  console.log(`\nAfter test - Latest finalized block root: ${root.toHex()}`);

  unsub();
  unsub2();
  await relayApi.disconnect();
  await bhApi.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
