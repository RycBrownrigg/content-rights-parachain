#!/usr/bin/env node
// Opens bidirectional HRMP channels between Para 100 and Para 200
// via sudo on the relay chain. Run after both parachains are producing blocks.
//
// Usage: node scripts/open-hrmp-channels.mjs [relay-ws-url]
// Default relay URL: ws://127.0.0.1:9944

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const RELAY_WS = process.argv[2] || 'ws://127.0.0.1:9944';

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
      if (status.isInBlock || status.isFinalized) {
        resolve({ blockHash: status.asInBlock || status.asFinalized, events });
      }
    });
  });
}

async function main() {
  console.log(`Connecting to relay chain at ${RELAY_WS}...`);
  const provider = new WsProvider(RELAY_WS);
  const api = await ApiPromise.create({ provider });
  await api.isReady;

  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  const maxCapacity = 8;
  const maxMessageSize = 8192;

  // Open channel 100 -> 200
  console.log('Opening HRMP channel 100 -> 200...');
  const open100to200 = api.tx.sudo.sudo(
    api.tx.hrmp.forceOpenHrmpChannel(100, 200, maxCapacity, maxMessageSize)
  );
  await sendAndWait(api, open100to200, alice);
  console.log('  Done.');

  // Open channel 200 -> 100
  console.log('Opening HRMP channel 200 -> 100...');
  const open200to100 = api.tx.sudo.sudo(
    api.tx.hrmp.forceOpenHrmpChannel(200, 100, maxCapacity, maxMessageSize)
  );
  await sendAndWait(api, open200to100, alice);
  console.log('  Done.');

  // Channels become active after the next session change on the relay chain.
  // With rococo-local this is fast (a few blocks).
  console.log('\nHRMP channels requested. They will be active after the next relay session change.');
  console.log('Wait ~30 seconds, then run: node scripts/xcm-e2e-test.mjs');

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed to open HRMP channels:', e.message);
  process.exit(1);
});
