#!/usr/bin/env node
/**
 * XCM End-to-End Test Script — Full cross-chain content rights flow.
 *
 * Tests all four cross-chain operations between two parachains on a local
 * Zombienet network: subscribe, renew, purchase views, purchase ownership.
 *
 * @module xcm-e2e-test
 *
 * Exports: (none — CLI entry point)
 *
 * Prerequisites:
 *   1. Build: cargo build --release -p parachain-template-node
 *   2. Spawn: ./zombienet-spawn.sh zombienet-xcm-test.toml --provider native
 *   3. Open HRMP: node scripts/open-hrmp-channels.mjs ws://127.0.0.1:<relay-port>
 *   4. Wait ~30s for session change
 *   5. Run: node scripts/xcm-e2e-test.mjs [paraA-ws] [paraB-ws] [relay-ws]
 *
 * Network layout:
 *   - Relay chain (Rococo-local): alice, bob (ports assigned by Zombienet)
 *   - ParaA (100): content-rights chain at ws://127.0.0.1:9990
 *   - ParaB (200): consumer chain at ws://127.0.0.1:9991
 *   - HRMP channels: 100 ↔ 200 (bidirectional, opened post-launch)
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const PARA_B_WS = process.argv[3] || 'ws://127.0.0.1:9991';
const RELAY_WS = process.argv[4] || 'ws://127.0.0.1:9944';

// XCM fee: 100B tokens (covers ~75B proof_size cost from BlockRatioFee<1,1>).
// See project memory project_xcm_fee_calculation.md for derivation.
const XCM_FEE_AMOUNT = 100_000_000_000;

// Sections to scan for XCM-related events on ParaA
const XCM_EVENT_SECTIONS = [
  'xcmpQueue', 'messageQueue', 'contentRights',
  'polkadotXcm', 'cumulusXcm', 'balances',
];

async function connect(url, label) {
  console.log(`Connecting to ${label} at ${url}...`);
  const provider = new WsProvider(url);
  const api = await ApiPromise.create({ provider });
  await api.isReady;
  const chain = await api.rpc.system.chain();
  console.log(`  Connected to ${chain} (${label})`);
  return api;
}

async function waitForBlock(api, minBlock) {
  return new Promise((resolve) => {
    const unsub = api.rpc.chain.subscribeNewHeads(async (header) => {
      const blockNum = header.number.toNumber();
      if (blockNum >= minBlock) {
        (await unsub)();
        resolve(blockNum);
      }
    });
  });
}

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

/** Scans events in a range of blocks on a given api. */
async function scanEvents(api, startBlock, endBlock, sections) {
  const found = [];
  for (let i = startBlock; i <= endBlock; i++) {
    try {
      const hash = await api.rpc.chain.getBlockHash(i);
      const events = await api.query.system.events.at(hash);
      for (const { event } of events) {
        if (sections.includes(event.section)) {
          found.push({ block: i, section: event.section, method: event.method, data: event.toHuman().data });
        }
      }
    } catch {
      // State pruned, skip
    }
  }
  return found;
}

/**
 * Sends an XCM Transact from ParaB to ParaA and waits for processing.
 * Returns the events found on ParaA during the processing window.
 */
async function sendXcmTransact(apiA, apiB, encodedCall, signer, label) {
  const blockBeforeSend = (await apiA.rpc.chain.getHeader()).number.toNumber();

  const xcmMessage = {
    V3: [
      {
        WithdrawAsset: [
          { id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: XCM_FEE_AMOUNT } }
        ]
      },
      {
        BuyExecution: {
          fees: { id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: XCM_FEE_AMOUNT } },
          weightLimit: 'Unlimited',
        }
      },
      {
        Transact: {
          originKind: 'SovereignAccount',
          requireWeightAtMost: { refTime: 1_000_000_000, proofSize: 100_000 },
          call: { encoded: encodedCall },
        }
      },
    ]
  };

  const dest = { V3: { parents: 1, interior: { X1: { Parachain: 100 } } } };
  const sendTx = apiB.tx.polkadotXcm.send(dest, xcmMessage);
  const sudoSendTx = apiB.tx.sudo.sudo(sendTx);

  console.log(`  Sending XCM (${label}) via sudo on ParaB...`);
  const { events: sendEvents } = await sendAndWait(apiB, sudoSendTx, signer);
  for (const { event } of sendEvents) {
    if (event.section !== 'system' && event.section !== 'transactionPayment') {
      console.log(`    ${event.section}.${event.method}: ${JSON.stringify(event.toHuman().data)}`);
    }
  }

  // Wait for XCM to be relayed and processed on ParaA
  const currentBlock = (await apiA.rpc.chain.getHeader()).number.toNumber();
  const targetBlock = currentBlock + 10;
  console.log(`  Waiting for ParaA block ${targetBlock}...`);
  await waitForBlock(apiA, targetBlock);

  // Scan ParaA events
  const scanStart = Math.max(1, blockBeforeSend - 2);
  const events = await scanEvents(apiA, scanStart, targetBlock, XCM_EVENT_SECTIONS);
  if (events.length > 0) {
    for (const ev of events) {
      console.log(`  Block #${ev.block}: ${ev.section}.${ev.method}: ${JSON.stringify(ev.data)}`);
    }
  } else {
    console.log('  No XCM-related events found on ParaA');
  }

  return events;
}

async function main() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');
  const bob = keyring.addFromUri('//Bob');
  const charlie = keyring.addFromUri('//Charlie');

  // Connect to all chains
  let apiA, apiB, apiRelay;
  try {
    [apiA, apiB, apiRelay] = await Promise.all([
      connect(PARA_A_WS, 'ParaA (100)'),
      connect(PARA_B_WS, 'ParaB (200)'),
      connect(RELAY_WS, 'Relay'),
    ]);
  } catch (e) {
    console.error('Failed to connect. Is the Zombienet network running?');
    console.error('  ./zombienet-spawn.sh zombienet-xcm-test.toml --provider native');
    process.exit(1);
  }

  const xcmVersion = apiA.consts.polkadotXcm?.advertisedXcmVersion?.toNumber?.() ?? 'unknown';
  console.log(`  ParaA advertised XCM version: ${xcmVersion}`);

  // =========================================================================
  // Step 1: Register content on ParaA
  // =========================================================================
  console.log('\n=== Step 1: Register content on ParaA ===');
  const metadataHash = '0x' + '00'.repeat(32);
  const title = 'Cross-Chain Test Content';
  const registerTx = apiA.tx.contentRights.registerContent(
    metadataHash,
    title,
    1000,   // subscription_price
    100,    // ppv_price (per view)
    5000,   // ownership_price
    10,     // period_length (10 blocks — short for fast renewal testing)
  );

  const { events: regEvents } = await sendAndWait(apiA, registerTx, alice);
  let contentId = null;
  for (const { event } of regEvents) {
    if (event.section === 'contentRights' && event.method === 'ContentRegistered') {
      contentId = event.data[0].toNumber();
      console.log(`  Content registered with ID: ${contentId}`);
    }
  }
  if (contentId === null) {
    console.error('  FAIL: ContentRegistered event not found');
    process.exit(1);
  }

  // =========================================================================
  // Step 2: Fund ParaB sovereign account on ParaA
  // =========================================================================
  console.log('\n=== Step 2: Fund ParaB sovereign account on ParaA ===');
  // Sovereign account: b"sibl" (4 bytes) + para_id u32 LE (4 bytes) + 24 zero bytes
  // CRITICAL: toHex(true) for little-endian — see feedback_sovereign_endianness.md
  const sovereignHex = apiA.createType('AccountId',
    '0x' + Buffer.from('sibl').toString('hex') +
    apiA.createType('u32', 200).toHex(true).slice(2) +
    '00'.repeat(24)
  );
  console.log(`  Sovereign account of Para 200: ${sovereignHex.toString()}`);
  console.log(`  Existential deposit: ${apiA.consts.balances.existentialDeposit.toString()}`);

  // Fund using BOTH forceSetBalance AND a real transfer to guarantee account is alive
  const fundAmount = 10_000_000_000_000n; // 10T — covers ~100 XCM operations
  console.log(`  Funding with ${fundAmount} via forceSetBalance...`);
  const fundTx = apiA.tx.sudo.sudo(
    apiA.tx.balances.forceSetBalance(sovereignHex, fundAmount)
  );
  await sendAndWait(apiA, fundTx, alice);

  // Real transfer to ensure providers > 0
  console.log('  Sending transferAllowDeath to ensure account is fully alive...');
  const transferTx = apiA.tx.balances.transferAllowDeath(sovereignHex, 1_000_000_000_000n);
  await sendAndWait(apiA, transferTx, alice);

  // Verify account state
  const sovAccountInfo = await apiA.query.system.account(sovereignHex);
  console.log(`  Sovereign free: ${sovAccountInfo.data.free.toString()}`);
  console.log(`  Sovereign providers: ${sovAccountInfo.providers.toString()}`);
  if (sovAccountInfo.providers.toNumber() === 0) {
    console.error('  FATAL: Sovereign account has 0 providers after funding. Aborting.');
    process.exit(1);
  }

  // Wait 3 blocks for state propagation
  const fundedBlock = (await apiA.rpc.chain.getHeader()).number.toNumber();
  const safeBlock = fundedBlock + 3;
  console.log(`  Waiting for block ${safeBlock} to ensure state propagation...`);
  await waitForBlock(apiA, safeBlock);

  const preXcmBalance = await apiA.query.system.account(sovereignHex);
  console.log(`  Pre-XCM sovereign free: ${preXcmBalance.data.free.toString()}`);

  // =========================================================================
  // Step 3: XCM Subscribe — Bob gets subscription via cross-chain
  // =========================================================================
  console.log('\n=== Step 3: XCM Subscribe (ParaB → ParaA, beneficiary: Bob) ===');
  const xcmSubscribeCall = apiA.tx.contentRights.xcmSubscribe(contentId, bob.address);
  await sendXcmTransact(apiA, apiB, xcmSubscribeCall.method.toHex(), alice, 'xcmSubscribe');

  // Verify subscription
  console.log('\n  Verifying subscription...');
  const subscription = await apiA.query.contentRights.subscriptions(contentId, bob.address);
  if (!subscription.isSome) {
    console.error('  FAIL: Cross-chain subscription was not created');
    process.exit(1);
  }
  const sub = subscription.unwrap();
  const expiryBlock = sub.expiryBlock.toNumber();
  console.log(`  SUCCESS: Bob has subscription on ParaA! Expiry block: ${expiryBlock}`);

  // =========================================================================
  // Step 4: XCM Renew — Wait for expiry, then renew Bob's subscription
  // =========================================================================
  console.log('\n=== Step 4: XCM Renew Subscription (ParaB → ParaA, beneficiary: Bob) ===');
  console.log(`  Subscription expires at block ${expiryBlock}. Waiting...`);
  await waitForBlock(apiA, expiryBlock);
  console.log(`  Subscription expired. Sending renewal XCM...`);

  const xcmRenewCall = apiA.tx.contentRights.xcmRenewSubscription(contentId, bob.address);
  await sendXcmTransact(apiA, apiB, xcmRenewCall.method.toHex(), alice, 'xcmRenewSubscription');

  // Verify renewal
  console.log('\n  Verifying renewal...');
  const renewed = await apiA.query.contentRights.subscriptions(contentId, bob.address);
  if (!renewed.isSome) {
    console.error('  FAIL: Subscription not found after renewal');
    process.exit(1);
  }
  const renewedSub = renewed.unwrap();
  const newExpiry = renewedSub.expiryBlock.toNumber();
  if (newExpiry <= expiryBlock) {
    console.error(`  FAIL: New expiry ${newExpiry} not greater than old expiry ${expiryBlock}`);
    process.exit(1);
  }
  console.log(`  SUCCESS: Subscription renewed! New expiry block: ${newExpiry} (was ${expiryBlock})`);

  // =========================================================================
  // Step 5: XCM Purchase Views — Charlie gets PPV views via cross-chain
  // =========================================================================
  console.log('\n=== Step 5: XCM Purchase Views (ParaB → ParaA, beneficiary: Charlie) ===');
  const numViews = 5;
  const xcmPpvCall = apiA.tx.contentRights.xcmPurchaseViews(contentId, charlie.address, numViews);
  await sendXcmTransact(apiA, apiB, xcmPpvCall.method.toHex(), alice, 'xcmPurchaseViews');

  // Verify view pack
  console.log('\n  Verifying view pack...');
  const viewPack = await apiA.query.contentRights.viewPacks(contentId, charlie.address);
  if (!viewPack.isSome) {
    console.error('  FAIL: Cross-chain view pack was not created');
    process.exit(1);
  }
  const pack = viewPack.unwrap();
  const viewsRemaining = pack.viewsRemaining.toNumber();
  if (viewsRemaining !== numViews) {
    console.error(`  FAIL: Expected ${numViews} views, got ${viewsRemaining}`);
    process.exit(1);
  }
  console.log(`  SUCCESS: Charlie has ${viewsRemaining} views on ParaA!`);

  // =========================================================================
  // Step 6: XCM Purchase Ownership — Charlie gets permanent ownership
  // =========================================================================
  console.log('\n=== Step 6: XCM Purchase Ownership (ParaB → ParaA, beneficiary: Charlie) ===');
  const xcmOwnershipCall = apiA.tx.contentRights.xcmPurchaseOwnership(contentId, charlie.address);
  await sendXcmTransact(apiA, apiB, xcmOwnershipCall.method.toHex(), alice, 'xcmPurchaseOwnership');

  // Verify ownership
  console.log('\n  Verifying ownership...');
  const owned = await apiA.query.contentRights.ownership(contentId, charlie.address);
  // Ownership is a ValueQuery (bool), so it returns true/false directly
  const isOwned = owned.toPrimitive();
  if (!isOwned) {
    console.error('  FAIL: Cross-chain ownership was not granted');
    process.exit(1);
  }
  console.log(`  SUCCESS: Charlie owns content ${contentId} on ParaA!`);

  // =========================================================================
  // Final summary
  // =========================================================================
  console.log('\n=== All E2E checks passed! ===');
  console.log('  [x] Cross-chain subscription (xcmSubscribe)');
  console.log('  [x] Cross-chain renewal (xcmRenewSubscription)');
  console.log('  [x] Cross-chain PPV purchase (xcmPurchaseViews)');
  console.log('  [x] Cross-chain ownership purchase (xcmPurchaseOwnership)');
  console.log('');

  // Print final sovereign balance for cost analysis
  const finalBalance = await apiA.query.system.account(sovereignHex);
  console.log(`  Sovereign balance: started with 11T, ended with ${finalBalance.data.free.toString()}`);
  console.log(`  Total XCM cost: ~${(11_000_000_000_000n - finalBalance.data.free.toBigInt()).toString()} tokens across 4 operations\n`);

  await apiA.disconnect();
  await apiB.disconnect();
  await apiRelay.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E test failed:', e.message);
  process.exit(1);
});
