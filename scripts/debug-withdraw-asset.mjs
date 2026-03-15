#!/usr/bin/env node
// Debug: test WithdrawAsset locally via polkadotXcm.execute
// Requires XcmExecuteFilter = Everything in the runtime.
//
// Tests multiple asset ID variants to find which one works:
// 1. {parents: 1, interior: Here}  — relay chain token (matches IsConcrete<RelayLocation>)
// 2. {parents: 0, interior: Here}  — native/self token

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';

async function testWithdraw(api, alice, assetLocation, label) {
  console.log(`\n=== Testing WithdrawAsset with ${label} ===`);
  console.log(`  Asset ID: ${JSON.stringify(assetLocation)}`);

  const xcmMsg = {
    V3: [
      {
        WithdrawAsset: [
          { id: { Concrete: assetLocation }, fun: { Fungible: 1000 } }
        ]
      },
      {
        DepositAsset: {
          assets: { Wild: 'All' },
          beneficiary: {
            parents: 0,
            interior: { X1: { AccountId32: { network: null, id: alice.publicKey } } }
          },
        }
      },
    ]
  };
  const maxWeight = { refTime: 10_000_000_000, proofSize: 1_000_000 };

  try {
    const executeTx = api.tx.polkadotXcm.execute(xcmMsg, maxWeight);
    await new Promise((resolve, reject) => {
      executeTx.signAndSend(alice, ({ status, dispatchError, events }) => {
        if (status.isInBlock) {
          // Always print events, even if there's a dispatch error
          console.log('  Events:');
          for (const { event } of events) {
            if (event.section === 'polkadotXcm') {
              console.log(`    ${event.section}.${event.method}:`);
              try {
                console.log(`      ${JSON.stringify(event.toHuman().data, null, 6)}`);
              } catch {
                console.log(`      ${event.data.toString()}`);
              }
            }
          }

          if (dispatchError) {
            if (dispatchError.isModule) {
              const decoded = api.registry.findMetaError(dispatchError.asModule);
              console.log(`  DISPATCH ERROR: ${decoded.section}.${decoded.name}`);
              console.log(`    ${decoded.docs.join(' ')}`);
              // Try to show raw error data for more detail
              console.log(`    Raw: ${JSON.stringify(dispatchError.asModule.toHuman())}`);
            } else {
              console.log(`  DISPATCH ERROR: ${dispatchError.toString()}`);
            }
            resolve('failed');
          } else {
            console.log('  SUCCESS: No dispatch error');
            resolve('success');
          }
        }
      });
    });
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

async function main() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  const api = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  await api.isReady;

  console.log(`Alice: ${alice.address}`);
  const aliceInfo = await api.query.system.account(alice.address);
  console.log(`Alice free balance: ${aliceInfo.data.free.toString()}`);
  console.log(`Existential deposit: ${api.consts.balances.existentialDeposit.toString()}`);

  // Test 1: Relay chain token {parents: 1, interior: Here}
  await testWithdraw(api, alice, { parents: 1, interior: 'Here' }, '{parents:1, interior:Here} (relay token)');

  // Test 2: Native/self token {parents: 0, interior: Here}
  await testWithdraw(api, alice, { parents: 0, interior: 'Here' }, '{parents:0, interior:Here} (native token)');

  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
