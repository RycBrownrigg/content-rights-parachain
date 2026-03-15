#!/usr/bin/env node
// XCM End-to-End Test Script
//
// Tests cross-chain content rights operations between two parachains
// running on a local Zombienet network.
//
// Prerequisites:
//   1. Build: cargo build --release -p parachain-template-node
//   2. Spawn: ./zombienet-spawn.sh zombienet-xcm-test.toml --provider native
//   3. Open HRMP: node scripts/open-hrmp-channels.mjs ws://127.0.0.1:<relay-port>
//   4. Wait ~30s for session change
//   5. Run: node scripts/xcm-e2e-test.mjs [paraA-ws] [paraB-ws] [relay-ws]
//
// Network layout:
//   - Relay chain (Rococo-local): alice, bob (ports assigned by Zombienet)
//   - ParaA (100): content-rights chain at ws://127.0.0.1:9990
//   - ParaB (200): consumer chain at ws://127.0.0.1:9991
//   - HRMP channels: 100 ↔ 200 (bidirectional, opened post-launch)

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const PARA_B_WS = process.argv[3] || 'ws://127.0.0.1:9991';
const RELAY_WS = process.argv[4] || 'ws://127.0.0.1:9944';

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

// Scan events in a range of blocks on a given api
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

async function main() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');
  const bob = keyring.addFromUri('//Bob');

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

  // Check what XCM version the runtime supports
  const xcmVersion = apiA.consts.polkadotXcm?.advertisedXcmVersion?.toNumber?.() ?? 'unknown';
  console.log(`  ParaA advertised XCM version: ${xcmVersion}`);

  console.log('\n=== Step 1: Register content on ParaA ===');
  const metadataHash = '0x' + '00'.repeat(32);
  const title = 'Cross-Chain Test Content';
  const registerTx = apiA.tx.contentRights.registerContent(
    metadataHash,
    title,
    1000,   // subscription_price
    100,    // ppv_price
    5000,   // ownership_price
    100,    // period_length
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

  console.log('\n=== Step 2: Fund ParaB sovereign account on ParaA ===');
  const sovereignHex = apiA.createType('AccountId',
    '0x' + Buffer.from('sibl').toString('hex') +
    apiA.createType('u32', 200).toHex(true).slice(2) +
    '00'.repeat(24)
  );
  console.log(`  Sovereign account of Para 200: ${sovereignHex.toString()}`);
  console.log(`  Sovereign hex raw: 0x${Buffer.from('sibl').toString('hex')}${apiA.createType('u32', 200).toHex(true).slice(2)}${'00'.repeat(24)}`);
  console.log(`  Existential deposit: ${apiA.consts.balances.existentialDeposit.toString()}`);

  // Fund using BOTH forceSetBalance AND a real transfer to guarantee account is alive
  const fundAmount = 10_000_000_000_000n; // 10T — plenty of headroom
  console.log(`  Funding with ${fundAmount} via forceSetBalance...`);
  const fundTx = apiA.tx.sudo.sudo(
    apiA.tx.balances.forceSetBalance(sovereignHex, fundAmount)
  );
  const { blockHash: fundBlockHash } = await sendAndWait(apiA, fundTx, alice);
  const fundHeader = await apiA.rpc.chain.getHeader(fundBlockHash);
  console.log(`  forceSetBalance included in ParaA block #${fundHeader.number.toNumber()}`);

  // Also do a real transfer to ensure providers is set via normal flow
  console.log('  Sending additional transferAllowDeath to ensure account is fully alive...');
  const transferTx = apiA.tx.balances.transferAllowDeath(sovereignHex, 1_000_000_000_000n);
  const { blockHash: transferBlockHash } = await sendAndWait(apiA, transferTx, alice);
  const transferHeader = await apiA.rpc.chain.getHeader(transferBlockHash);
  console.log(`  transfer included in ParaA block #${transferHeader.number.toNumber()}`);

  // Verify account state after funding
  const sovAccountInfo = await apiA.query.system.account(sovereignHex);
  console.log(`  Sovereign free: ${sovAccountInfo.data.free.toString()}`);
  console.log(`  Sovereign reserved: ${sovAccountInfo.data.reserved.toString()}`);
  console.log(`  Sovereign frozen: ${sovAccountInfo.data.frozen.toString()}`);
  console.log(`  Sovereign providers: ${sovAccountInfo.providers.toString()}`);
  console.log(`  Sovereign consumers: ${sovAccountInfo.consumers.toString()}`);
  console.log(`  Sovereign nonce: ${sovAccountInfo.nonce.toString()}`);

  if (sovAccountInfo.providers.toNumber() === 0) {
    console.error('  FATAL: Sovereign account has 0 providers after funding. Aborting.');
    process.exit(1);
  }

  // Wait 3 more blocks to ensure state is fully committed
  const fundedBlock = (await apiA.rpc.chain.getHeader()).number.toNumber();
  const safeBlock = fundedBlock + 3;
  console.log(`  Waiting for block ${safeBlock} to ensure state propagation...`);
  await waitForBlock(apiA, safeBlock);

  // Re-verify balance just before XCM send
  const preXcmBalance = await apiA.query.system.account(sovereignHex);
  console.log(`  Pre-XCM sovereign free: ${preXcmBalance.data.free.toString()} (block ~${safeBlock})`);
  if (preXcmBalance.data.free.toBigInt() === 0n) {
    console.error('  FATAL: Sovereign balance dropped to 0 before XCM send!');
    process.exit(1);
  }

  console.log('\n=== Step 3: Send XCM Transact from ParaB to ParaA ===');
  // Build the xcm_subscribe call to execute on ParaA
  const xcmSubscribeCall = apiA.tx.contentRights.xcmSubscribe(
    contentId,
    bob.address,  // beneficiary
  );
  const encodedCall = xcmSubscribeCall.method.toHex();
  console.log(`  Encoded call: ${encodedCall}`);
  console.log(`  Encoded call length: ${encodedCall.length / 2 - 1} bytes`);

  // Record the block BEFORE sending so we can scan for events after
  const blockBeforeSend = (await apiA.rpc.chain.getHeader()).number.toNumber();

  // Try multiple XCM versions to find what works
  // The runtime advertises XCM V5 but @polkadot/api may not support V4/V5 types.
  // Use V3 with correct Concrete asset format.
  // Asset: relay chain token {parents: 1, interior: Here} — matches IsConcrete<RelayLocation>
  // Fee calculation: FixedWeightBounds assigns UnitWeightCost per instruction:
  //   Weight::from_parts(1_000_000_000, 64*1024) = (1B refTime, 64KB proofSize)
  // 3 instructions = (3B refTime, ~192KB proofSize) + call_weight for Transact.
  // BlockRatioFee<1,1> scales proof_size by (max_ref_time / max_proof_size):
  //   MAXIMUM_BLOCK_WEIGHT = (2T refTime, 5.2M proofSize)
  //   ratio = 2T / 5.2M ≈ 381,470
  //   proof_size_fee = 381,470 × 196,608 ≈ 75B
  // fee = max(ref_time_fee, proof_size_fee) ≈ 75B. Use 100B for safety.
  const xcmFeeAmount = 100_000_000_000;
  const xcmMessage = {
    V3: [
      {
        WithdrawAsset: [
          { id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: xcmFeeAmount } }
        ]
      },
      {
        BuyExecution: {
          fees: { id: { Concrete: { parents: 1, interior: 'Here' } }, fun: { Fungible: xcmFeeAmount } },
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

  // Send XCM from ParaB to ParaA via pallet_xcm::send
  const dest = { V3: { parents: 1, interior: { X1: { Parachain: 100 } } } };
  const sendTx = apiB.tx.polkadotXcm.send(dest, xcmMessage);
  const sudoSendTx = apiB.tx.sudo.sudo(sendTx);

  console.log('  Sending XCM via sudo on ParaB...');
  const { events: sendEvents } = await sendAndWait(apiB, sudoSendTx, alice);
  console.log('  ParaB events from send tx:');
  for (const { event } of sendEvents) {
    if (event.section !== 'system' && event.section !== 'transactionPayment') {
      console.log(`    ${event.section}.${event.method}: ${JSON.stringify(event.toHuman().data)}`);
    }
  }

  console.log('\n=== Step 4: Wait for XCM to be processed ===');
  const currentBlock = (await apiA.rpc.chain.getHeader()).number.toNumber();
  console.log(`  Current ParaA block: ${currentBlock}`);
  const targetBlock = currentBlock + 10;
  console.log(`  Waiting until block ${targetBlock}...`);
  await waitForBlock(apiA, targetBlock);
  console.log(`  Reached block ${targetBlock}`);

  // Scan ParaA events for XCM processing (wider range)
  const scanStart = Math.max(1, blockBeforeSend - 2);
  console.log('\n  Scanning ParaA events from blocks', scanStart, 'to', targetBlock, '...');
  const xcmEvents = await scanEvents(apiA, scanStart, targetBlock,
    ['xcmpQueue', 'messageQueue', 'contentRights', 'polkadotXcm', 'cumulusXcm', 'balances']);
  if (xcmEvents.length > 0) {
    for (const ev of xcmEvents) {
      console.log(`  Block #${ev.block}: ${ev.section}.${ev.method}: ${JSON.stringify(ev.data)}`);
    }
  } else {
    console.log('  No XCM-related events found on ParaA');
  }

  // Check sovereign balance at each block in the scan range to find when it changes
  console.log('\n  Sovereign balance at each block in scan range:');
  for (let i = scanStart; i <= targetBlock; i++) {
    try {
      const hash = await apiA.rpc.chain.getBlockHash(i);
      const acct = await apiA.query.system.account.at(hash, sovereignHex);
      const free = acct.data.free.toBigInt();
      const providers = acct.providers.toNumber();
      if (free !== 0n || providers !== 0) {
        console.log(`    Block #${i}: free=${free} providers=${providers}`);
      }
    } catch {
      // state pruned
    }
  }

  console.log('\n=== Step 5: Verify subscription on ParaA ===');
  const subscription = await apiA.query.contentRights.subscriptions(contentId, bob.address);
  if (subscription.isSome) {
    const sub = subscription.unwrap();
    console.log(`  SUCCESS: Bob has subscription on ParaA!`);
    console.log(`    Expiry block: ${sub.expiryBlock.toString()}`);
    console.log(`    Auto-renew: ${sub.autoRenew.toString()}`);
  } else {
    console.log('  Subscription not found.');
    // Double-check sovereign balance to see if funds were withdrawn
    const balAfter = await apiA.query.system.account(sovereignHex);
    console.log(`  Sovereign balance after: ${balAfter.data.free.toString()}`);
    console.log('\n  FAIL: Cross-chain subscription was not created');
    process.exit(1);
  }

  console.log('\n=== All E2E checks passed! ===\n');

  await apiA.disconnect();
  await apiB.disconnect();
  await apiRelay.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E test failed:', e.message);
  process.exit(1);
});
