#!/usr/bin/env node
// Debug: check recent events on ParaA for XCM processing results
import { ApiPromise, WsProvider } from '@polkadot/api';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();
  console.log(`Current block: ${currentBlock}`);

  // Check last 20 blocks for any XCM/message queue events
  const startBlock = Math.max(0, currentBlock - 20);
  for (let i = startBlock; i <= currentBlock; i++) {
    const hash = await api.rpc.chain.getBlockHash(i);
    const events = await api.query.system.events.at(hash);
    const interesting = events.filter(({ event }) =>
      event.section === 'xcmpQueue' ||
      event.section === 'messageQueue' ||
      event.section === 'contentRights' ||
      event.section === 'polkadotXcm' ||
      event.section === 'cumulusXcm' ||
      (event.section === 'system' && event.method === 'ExtrinsicFailed')
    );
    if (interesting.length > 0) {
      console.log(`\n--- Block #${i} ---`);
      for (const { event } of interesting) {
        console.log(`  ${event.section}.${event.method}`);
        try {
          console.log(`    ${JSON.stringify(event.toHuman().data, null, 2)}`);
        } catch {
          console.log(`    ${event.data.toString()}`);
        }
      }
    }
  }

  console.log('\nDone.');
  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
