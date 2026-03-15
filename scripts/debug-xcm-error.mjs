#!/usr/bin/env node
// Debug: scan ParaA for the exact XCM error from ProcessXcmError event
// Run this AFTER running xcm-e2e-test.mjs to see what went wrong.
//
// Usage: node scripts/debug-xcm-error.mjs [paraA-ws] [startBlock]

import { ApiPromise, WsProvider } from '@polkadot/api';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';
const START_BLOCK = parseInt(process.argv[3]) || 0;

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  const startBlock = START_BLOCK || Math.max(1, currentBlock - 30);

  console.log(`Scanning blocks ${startBlock} to ${currentBlock} for XCM errors...`);

  for (let i = startBlock; i <= currentBlock; i++) {
    try {
      const hash = await api.rpc.chain.getBlockHash(i);
      const events = await api.query.system.events.at(hash);
      for (const { event } of events) {
        // Look for ProcessXcmError specifically
        if (event.section === 'polkadotXcm' && event.method === 'ProcessXcmError') {
          console.log(`\n=== Block #${i}: polkadotXcm.ProcessXcmError ===`);
          console.log(JSON.stringify(event.toHuman().data, null, 2));
        }
        // Also show any XCM-related events
        if (['xcmpQueue', 'messageQueue', 'polkadotXcm', 'cumulusXcm'].includes(event.section)) {
          console.log(`  Block #${i}: ${event.section}.${event.method}: ${JSON.stringify(event.toHuman().data)}`);
        }
      }
    } catch {
      // State pruned
    }
  }

  console.log('\nDone.');
  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
