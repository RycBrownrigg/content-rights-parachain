#!/usr/bin/env node
/**
 * Verifies Snowbridge configuration on Bridge Hub and Asset Hub.
 *
 * Checks:
 *   1. Gateway address is set on Bridge Hub
 *   2. Beacon client is initialized on Bridge Hub
 *   3. Ether foreign asset exists on AssetHub
 *
 * @module verifySnowbridgeConfig
 *
 * Usage: node scripts/verify-snowbridge-config.mjs
 */

import { ApiPromise, WsProvider } from '@polkadot/api';

const BRIDGE_HUB_WS = 'ws://127.0.0.1:8943';
const ASSET_HUB_WS = 'ws://127.0.0.1:9910';

async function main() {
  // 1. Check Bridge Hub
  console.log('=== Bridge Hub (port 8943) ===');
  const bhProvider = new WsProvider(BRIDGE_HUB_WS);
  const bhApi = await ApiPromise.create({ provider: bhProvider });
  await bhApi.isReady;

  // Check gateway address in storage
  const gatewayStorageKey = '0xaed97c7854d601808b98ae43079dafb3';
  const gatewayValue = await bhApi.rpc.state.getStorage(gatewayStorageKey);
  console.log(`Gateway address storage: ${gatewayValue}`);

  // Check ethereum beacon client
  const pallets = Object.keys(bhApi.query);
  const hasBeaconClient = pallets.includes('ethereumBeaconClient');
  console.log(`Has ethereumBeaconClient pallet: ${hasBeaconClient}`);

  if (hasBeaconClient) {
    try {
      const latestFinalizedBlockRoot = await bhApi.query.ethereumBeaconClient.latestFinalizedBlockRoot();
      console.log(`Latest finalized block root: ${latestFinalizedBlockRoot}`);

      const initialCheckpointRoot = await bhApi.query.ethereumBeaconClient.initialCheckpointRoot();
      console.log(`Initial checkpoint root: ${initialCheckpointRoot}`);
    } catch (e) {
      console.log(`Error querying beacon client: ${e.message}`);
    }
  }

  await bhApi.disconnect();

  // 2. Check Asset Hub
  console.log('\n=== Asset Hub (port 9910) ===');
  const ahProvider = new WsProvider(ASSET_HUB_WS);
  const ahApi = await ApiPromise.create({ provider: ahProvider });
  await ahApi.isReady;

  // Check if foreignAssets pallet exists
  const ahPallets = Object.keys(ahApi.query);
  const hasForeignAssets = ahPallets.includes('foreignAssets');
  console.log(`Has foreignAssets pallet: ${hasForeignAssets}`);

  if (hasForeignAssets) {
    try {
      // Ether location: { parents: 2, interior: { X1: [{ GlobalConsensus: { Ethereum: { chain_id: 11155111 } } }] } }
      const etherLocation = {
        parents: 2,
        interior: { X1: [{ GlobalConsensus: { Ethereum: { chainId: 11155111 } } }] },
      };
      const assetDetails = await ahApi.query.foreignAssets.asset(etherLocation);
      console.log(`Ether asset details: ${assetDetails}`);

      // Check Alice's Ether balance
      const aliceId = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
      const aliceBalance = await ahApi.query.foreignAssets.account(etherLocation, aliceId);
      console.log(`Alice Ether balance: ${aliceBalance}`);
    } catch (e) {
      console.log(`Error querying foreign assets: ${e.message}`);
    }
  }

  await ahApi.disconnect();
  console.log('\nVerification complete.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Verification failed:', e.message);
  process.exit(1);
});
