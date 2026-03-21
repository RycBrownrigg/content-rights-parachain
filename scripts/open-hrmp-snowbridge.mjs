#!/usr/bin/env node
//! Opens HRMP channels for the Snowbridge 4-chain Zombienet topology.
//!
//! Opens bidirectional channels:
//!   Bridge Hub (1013) ↔ AssetHub (1000) — Snowbridge message routing
//!   AssetHub (1000) ↔ Content Rights (100) — forwarding bridged tokens
//!
//! Usage: node scripts/open-hrmp-snowbridge.mjs [relay-ws-url]
//! Default relay URL: ws://127.0.0.1:50882

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const RELAY_WS = process.argv[2] || 'ws://127.0.0.1:50882';

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
  console.log(`Connecting to relay chain at ${RELAY_WS}...`);
  const provider = new WsProvider(RELAY_WS);
  const api = await ApiPromise.create({ provider });
  await api.isReady;

  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  const maxCapacity = 8;
  const maxMessageSize = 524288; // 512 KiB — matches Snowbridge reference config

  const channels = [
    [1013, 1000, 'Bridge Hub -> AssetHub'],
    [1000, 1013, 'AssetHub -> Bridge Hub'],
    [1000, 100,  'AssetHub -> Content Rights'],
    [100,  1000, 'Content Rights -> AssetHub'],
  ];

  for (const [sender, recipient, label] of channels) {
    console.log(`Opening HRMP channel ${sender} -> ${recipient} (${label})...`);
    const tx = api.tx.sudo.sudo(
      api.tx.hrmp.forceOpenHrmpChannel(sender, recipient, maxCapacity, maxMessageSize)
    );
    await sendAndWait(api, tx, alice);
    console.log('  Done.');
  }

  console.log('\nAll HRMP channels requested. They will be active after the next relay session change.');
  console.log('Wait ~30 seconds for session rotation, then verify with polkadot.js.');

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed to open HRMP channels:', e.message);
  process.exit(1);
});
