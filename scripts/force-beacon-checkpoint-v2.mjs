#!/usr/bin/env node
/**
 * Forces beacon checkpoint on Bridge Hub with full monitoring.
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { readFileSync } from 'fs';

const RELAY_WS = 'ws://127.0.0.1:50882';
const BRIDGE_HUB_WS = 'ws://127.0.0.1:8943';

async function main() {
  const checkpointHex = readFileSync('/tmp/snowbridge-v2/beacon-checkpoint.hex', 'utf8').trim();
  console.log(`Checkpoint hex length: ${checkpointHex.length} (${checkpointHex.length/2} bytes)`);

  const relayApi = await ApiPromise.create({ provider: new WsProvider(RELAY_WS) });
  const bhApi = await ApiPromise.create({ provider: new WsProvider(BRIDGE_HUB_WS) });

  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Monitor Bridge Hub events
  let bhBlockCount = 0;
  const unsub = await bhApi.rpc.chain.subscribeNewHeads(async (header) => {
    bhBlockCount++;
    const hash = header.hash;
    const events = await bhApi.query.system.events.at(hash);
    events.forEach((record) => {
      const { event } = record;
      if (event.section === 'messageQueue' || event.section === 'ethereumBeaconClient') {
        console.log(`[BH #${header.number}] ${event.section}.${event.method}:`, JSON.stringify(event.data.toHuman()));
      }
    });
  });

  // Send the force_checkpoint
  const transactCall = '0x5200' + checkpointHex;
  console.log(`\nSending force_checkpoint XCM (call size: ${transactCall.length / 2} bytes)...`);

  const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: 1013 }] } } };
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

  const tx = relayApi.tx.sudo.sudo(relayApi.tx.xcmPallet.send(dest, message));

  await new Promise((resolve, reject) => {
    tx.signAndSend(alice, ({ status, dispatchError, events }) => {
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
        console.log(`[Relay] Included in block ${status.asInBlock}`);
        events.forEach(({ event }) => {
          console.log(`  ${event.section}.${event.method}:`,
            event.section === 'xcmPallet' ? 'Sent' : JSON.stringify(event.data.toHuman()));
        });
        resolve();
      }
    });
  });

  // Wait for Bridge Hub processing
  console.log('\nWaiting 60s for Bridge Hub to process the message...');
  await new Promise(r => setTimeout(r, 60000));

  // Final check
  const root = await bhApi.query.ethereumBeaconClient.latestFinalizedBlockRoot();
  const init = await bhApi.query.ethereumBeaconClient.initialCheckpointRoot();
  console.log(`\nFinal state:`);
  console.log(`  latestFinalizedBlockRoot: ${root.toHex()}`);
  console.log(`  initialCheckpointRoot: ${init.toHex()}`);
  console.log(`  BH blocks observed: ${bhBlockCount}`);

  unsub();
  await relayApi.disconnect();
  await bhApi.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
