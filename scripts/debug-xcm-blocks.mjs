#!/usr/bin/env node
import { ApiPromise, WsProvider } from '@polkadot/api';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });

  // Check message queue book state
  const mqBookState = await api.query.messageQueue.bookStateFor.entries();
  console.log('Message queue book state:');
  mqBookState.forEach(([key, val]) => console.log(' ', key.args.toString(), val.toHuman()));

  // Check blocks 65-80 (around when the test ran)
  console.log('\nScanning blocks 65-80 for XCM events...');
  for (let i = 65; i <= 80; i++) {
    const hash = await api.rpc.chain.getBlockHash(i);
    const events = await api.query.system.events.at(hash);
    const interesting = events.filter(({ event }) =>
      event.section === 'xcmpQueue' || event.section === 'messageQueue' ||
      event.section === 'contentRights' || event.section === 'polkadotXcm' ||
      event.section === 'cumulusXcm'
    );
    if (interesting.length > 0) {
      console.log(`\nBlock #${i}:`);
      interesting.forEach(({ event }) => {
        console.log(`  ${event.section}.${event.method}: ${JSON.stringify(event.toHuman().data)}`);
      });
    }
  }

  // Also check a wider range in case HRMP activation was delayed
  console.log('\nScanning blocks 1-30 for HRMP/XCM events...');
  for (let i = 1; i <= 30; i++) {
    const hash = await api.rpc.chain.getBlockHash(i);
    const events = await api.query.system.events.at(hash);
    const interesting = events.filter(({ event }) =>
      event.section === 'xcmpQueue' || event.section === 'messageQueue' ||
      event.section === 'contentRights' || event.section === 'polkadotXcm' ||
      event.section === 'cumulusXcm'
    );
    if (interesting.length > 0) {
      console.log(`\nBlock #${i}:`);
      interesting.forEach(({ event }) => {
        console.log(`  ${event.section}.${event.method}: ${JSON.stringify(event.toHuman().data)}`);
      });
    }
  }

  console.log('\nDone.');
  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
