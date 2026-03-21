#!/usr/bin/env node
/**
 * Configures Snowbridge on Bridge Hub and Asset Hub for local testnet.
 *
 * Sends sudo XCM messages from relay chain to:
 *   1. Set Gateway contract address on Bridge Hub
 *   2. Create Ether foreign asset on AssetHub
 *   3. Set Ether reserve on AssetHub
 *   4. Mint Ether to test accounts on AssetHub
 *
 * @module configureSnowbridge
 *
 * Usage: node scripts/configure-snowbridge.mjs [relay-ws-url]
 * Default relay URL: ws://127.0.0.1:50882
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const RELAY_WS = process.argv[2] || 'ws://127.0.0.1:50882';
const BRIDGE_HUB_PARAID = 1013;
const ASSET_HUB_PARAID = 1000;

// Gateway contract address deployed on local Ethereum
const GATEWAY_PROXY = '0xb1185ede04202fe62d38f5db72f71e38ff3e8305';
// Storage key for EthereumGatewayAddress on Bridge Hub
const GATEWAY_STORAGE_KEY = '0xaed97c7854d601808b98ae43079dafb3';

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

/** Sends a sudo XCM Transact to a parachain via UnpaidExecution from the relay. */
async function sendGovernanceTransact(api, alice, paraId, encodedCall, refTime = 2000000000, proofSize = 12000) {
  const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: paraId }] } } };
  const message = {
    V4: [
      { UnpaidExecution: { weight_limit: 'Unlimited' } },
      {
        Transact: {
          origin_kind: 'Superuser',
          require_weight_at_most: { ref_time: refTime, proof_size: proofSize },
          call: { encoded: encodedCall },
        },
      },
    ],
  };

  const tx = api.tx.sudo.sudo(api.tx.xcmPallet.send(dest, message));
  return sendAndWait(api, tx, alice);
}

/** Sends a sudo XCM Transact that pretends to come from Bridge Hub + Ethereum origin. */
async function sendTransactThroughBridge(api, alice, paraId, encodedCall, refTime = 2000000000, proofSize = 900000) {
  const dest = { V4: { parents: 0, interior: { X1: [{ Parachain: paraId }] } } };
  const message = {
    V4: [
      { UnpaidExecution: { weight_limit: 'Unlimited' } },
      { DescendOrigin: { X2: [{ Parachain: 1002 }, { PalletInstance: 91 }] } },
      { UniversalOrigin: { GlobalConsensus: { Ethereum: { chain_id: 11155111 } } } },
      {
        Transact: {
          origin_kind: 'SovereignAccount',
          require_weight_at_most: { ref_time: refTime, proof_size: proofSize },
          call: { encoded: encodedCall },
        },
      },
    ],
  };

  const tx = api.tx.sudo.sudo(api.tx.xcmPallet.send(dest, message));
  return sendAndWait(api, tx, alice);
}

async function main() {
  console.log(`Connecting to relay chain at ${RELAY_WS}...`);
  const provider = new WsProvider(RELAY_WS);
  const api = await ApiPromise.create({ provider });
  await api.isReady;

  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  // ──────────────────────────────────────────────────────────────────────
  // 1. Set Gateway address on Bridge Hub
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n1. Setting Gateway contract address on Bridge Hub...');
  {
    // Construct system.setStorage call for Bridge Hub
    // The call is: system.setStorage(items: Vec<(Key, Value)>)
    // system pallet = 0x00, setStorage = 0x04
    // Vec<1 item> = 0x04
    // Key: compact length + storage_key bytes
    // Value: compact length + gateway address bytes (20 bytes)
    const storageKey = GATEWAY_STORAGE_KEY.slice(2); // remove 0x
    const gateway = GATEWAY_PROXY.slice(2); // remove 0x
    // 0x00 04 = system.setStorage
    // 04 = Vec length 1
    // 40 = compact length 16 (storage key is 16 bytes)
    // [storage_key]
    // 50 = compact length 20 (gateway is 20 bytes)
    // [gateway]
    const transactCall = '0x00040440' + storageKey + '50' + gateway;
    console.log(`  Call: ${transactCall}`);
    await sendGovernanceTransact(api, alice, BRIDGE_HUB_PARAID, transactCall);
    console.log('  Gateway address set on Bridge Hub.');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. Create Ether foreign asset on AssetHub
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n2. Creating Ether foreign asset on AssetHub...');
  {
    // Pre-encoded batch call from Snowbridge configure-substrate.sh
    // Creates the Ether foreign asset with metadata (name: "Ether", symbol: "Ether", decimals: 18)
    const call =
      '0x28020c1f04020109079edaa802040000003501020109079edaa80200ce796ae65569a670d0c1cc1ac12515a3ce21b5fbf729d63d7b289baad070139d01043513020109079edaa8021445746865721445746865721200';
    console.log('  Sending create Ether asset call...');
    await sendGovernanceTransact(api, alice, ASSET_HUB_PARAID, call);
    console.log('  Ether foreign asset created on AssetHub.');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. Set reserve for Ether on AssetHub (via bridge origin)
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n3. Setting Ether reserve on AssetHub...');
  {
    const call = '0x3521020109079edaa80204020109079edaa80200';
    console.log('  Sending set reserve call (bridge origin)...');
    await sendTransactThroughBridge(api, alice, ASSET_HUB_PARAID, call);
    console.log('  Ether reserve set on AssetHub.');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. Mint Ether to Alice on AssetHub (via bridge origin)
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n4. Minting Ether to Alice on AssetHub...');
  {
    // Alice public key: 0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d
    const call =
      '0x3506020109079edaa80200d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d1300002cf61a24a229';
    console.log('  Sending mint Ether to Alice...');
    await sendTransactThroughBridge(api, alice, ASSET_HUB_PARAID, call);
    console.log('  Ether minted to Alice on AssetHub.');
  }

  // ──────────────────────────────────────────────────────────────────────
  // 5. Mint Ether to Ferdie on AssetHub (via bridge origin)
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n5. Minting Ether to Ferdie on AssetHub...');
  {
    // Ferdie public key: 0x1cbd2d43530a44705ad088af313e18f80b53ef16b36177cd4b77b846f2a5f07c
    const call =
      '0x3506020109079edaa802001cbd2d43530a44705ad088af313e18f80b53ef16b36177cd4b77b846f2a5f07c1300002cf61a24a229';
    console.log('  Sending mint Ether to Ferdie...');
    await sendTransactThroughBridge(api, alice, ASSET_HUB_PARAID, call);
    console.log('  Ether minted to Ferdie on AssetHub.');
  }

  console.log('\nAll Snowbridge substrate configuration complete.');
  console.log('Next steps:');
  console.log('  1. Generate beacon checkpoint: snowbridge-relay generate-beacon-checkpoint');
  console.log('  2. Force beacon checkpoint on Bridge Hub');
  console.log('  3. Start the relayer');

  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('Configuration failed:', e.message);
  process.exit(1);
});
