#!/usr/bin/env node
// Debug: check total issuance and other balance state that could affect burn_from
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';

async function main() {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // Check total issuance
  const totalIssuance = await api.query.balances.totalIssuance();
  console.log(`Total issuance: ${totalIssuance.toString()}`);

  // Sovereign account
  const sovereignHex = api.createType('AccountId',
    '0x' + Buffer.from('sibl').toString('hex') +
    api.createType('u32', 200).toHex(true).slice(2) +
    '00'.repeat(24)
  );
  const sovInfo = await api.query.system.account(sovereignHex);
  console.log(`\nSovereign account: ${sovereignHex.toString()}`);
  console.log(`  free: ${sovInfo.data.free.toString()}`);
  console.log(`  reserved: ${sovInfo.data.reserved.toString()}`);
  console.log(`  frozen: ${sovInfo.data.frozen.toString()}`);
  console.log(`  flags: ${sovInfo.data.flags.toString()}`);
  console.log(`  providers: ${sovInfo.providers.toString()}`);
  console.log(`  consumers: ${sovInfo.consumers.toString()}`);

  // Alice account for comparison
  const aliceInfo = await api.query.system.account(alice.address);
  console.log(`\nAlice account: ${alice.address}`);
  console.log(`  free: ${aliceInfo.data.free.toString()}`);
  console.log(`  reserved: ${aliceInfo.data.reserved.toString()}`);
  console.log(`  frozen: ${aliceInfo.data.frozen.toString()}`);
  console.log(`  flags: ${aliceInfo.data.flags.toString()}`);

  // Check ED
  console.log(`\nExistential deposit: ${api.consts.balances.existentialDeposit.toString()}`);

  // Check if XcmExecuteFilter allows local execution
  console.log(`\nXcmExecuteFilter: (check runtime config — currently Nothing)`);

  // Try to use polkadotXcm.execute to test WithdrawAsset locally
  // This requires XcmExecuteFilter = Everything
  console.log('\n=== Attempting polkadotXcm.execute (will fail if filter is Nothing) ===');
  try {
    const xcmMsg = {
      V3: [
        {
          WithdrawAsset: [
            { id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: 1000 } }
          ]
        },
        {
          DepositAsset: {
            assets: { Wild: 'All' },
            beneficiary: { parents: 0, interior: { X1: { AccountId32: { network: null, id: alice.publicKey } } } },
          }
        },
      ]
    };
    const maxWeight = { refTime: 1_000_000_000, proofSize: 100_000 };
    const executeTx = api.tx.polkadotXcm.execute(xcmMsg, maxWeight);
    const result = await new Promise((resolve, reject) => {
      executeTx.signAndSend(alice, ({ status, dispatchError, events }) => {
        if (dispatchError) {
          if (dispatchError.isModule) {
            const decoded = api.registry.findMetaError(dispatchError.asModule);
            reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`));
          } else {
            reject(new Error(dispatchError.toString()));
          }
        }
        if (status.isInBlock) {
          resolve({ events });
        }
      });
    });
    console.log('polkadotXcm.execute events:');
    for (const { event } of result.events) {
      if (event.section !== 'system' && event.section !== 'transactionPayment') {
        console.log(`  ${event.section}.${event.method}: ${JSON.stringify(event.toHuman().data)}`);
      }
    }
  } catch (e) {
    console.log(`  Expected failure: ${e.message}`);
    console.log('  (Need to change XcmExecuteFilter to Everything and rebuild to test locally)');
  }

  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
