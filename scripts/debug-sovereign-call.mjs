#!/usr/bin/env node
// Debug: test if the sovereign account can call xcmSubscribe directly
// This bypasses XCM entirely to verify the pallet works from the sovereign account.
//
// Usage: node scripts/debug-sovereign-call.mjs [paraA-ws]

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';

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
      }
    });
  });
}

async function main() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');
  const bob = keyring.addFromUri('//Bob');

  console.log('Connecting to ParaA...');
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  await api.isReady;

  // Derive sovereign account for Para 200
  const sovereignHex = api.createType('AccountId',
    '0x' + Buffer.from('sibl').toString('hex') +
    api.createType('u32', 200).toHex(true).slice(2) +
    '00'.repeat(24)
  );
  console.log(`Sovereign account of Para 200: ${sovereignHex.toString()}`);

  // Check sovereign balance
  const sovInfo = await api.query.system.account(sovereignHex);
  console.log(`Sovereign free: ${sovInfo.data.free.toString()}`);
  console.log(`Sovereign providers: ${sovInfo.providers.toString()}`);

  // Step 1: Register content first
  console.log('\n=== Register content ===');
  const metadataHash = '0x' + '01'.repeat(32);
  const registerTx = api.tx.contentRights.registerContent(
    metadataHash, 'Diagnostic Test', 1000, 100, 5000, 100
  );
  const { events: regEvents } = await sendAndWait(api, registerTx, alice);
  let contentId = null;
  for (const { event } of regEvents) {
    if (event.section === 'contentRights' && event.method === 'ContentRegistered') {
      contentId = event.data[0].toNumber();
      console.log(`Content registered with ID: ${contentId}`);
    }
  }
  if (contentId === null) {
    console.error('FAIL: ContentRegistered event not found');
    process.exit(1);
  }

  // Step 2: Try sudoAs sovereign → xcmSubscribe
  console.log('\n=== Test sudoAs sovereign → xcmSubscribe ===');
  try {
    const xcmSubCall = api.tx.contentRights.xcmSubscribe(contentId, bob.address);
    const sudoAsTx = api.tx.sudo.sudoAs(sovereignHex, xcmSubCall);
    const { events: sudoEvents } = await sendAndWait(api, sudoAsTx, alice);
    console.log('sudoAs events:');
    for (const { event } of sudoEvents) {
      if (event.section !== 'system' && event.section !== 'transactionPayment') {
        console.log(`  ${event.section}.${event.method}: ${JSON.stringify(event.toHuman().data)}`);
      }
    }
  } catch (e) {
    console.error(`sudoAs failed: ${e.message}`);
  }

  // Step 3: Check subscription
  console.log('\n=== Check subscription ===');
  const subscription = await api.query.contentRights.subscriptions(contentId, bob.address);
  if (subscription.isSome) {
    console.log('SUCCESS: Subscription exists!');
  } else {
    console.log('Subscription not found');
  }

  // Step 4: Also test what the XCM executor would do by examining the
  // Junctions format. Build the location as the executor would see it.
  console.log('\n=== Location conversion diagnostics ===');
  // Print what @polkadot/api thinks the sovereign should be using SovereignAccountOf
  // We can check pallet_xcm storage for this
  try {
    const parachainId = await api.query.parachainInfo.parachainId();
    console.log(`This chain's ParaId: ${parachainId.toString()}`);
  } catch {}

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Diagnostic failed:', e.message);
  process.exit(1);
});
