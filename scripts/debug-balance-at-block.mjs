#!/usr/bin/env node
// Debug: check sovereign account balance at specific blocks
// to see if forceSetBalance actually persisted.
import { ApiPromise, WsProvider } from '@polkadot/api';

const PARA_A_WS = process.argv[2] || 'ws://127.0.0.1:9990';

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();

  const sovereignHex = api.createType('AccountId',
    '0x' + Buffer.from('sibl').toString('hex') +
    api.createType('u32', 200).toHex(true).slice(2) +
    '00'.repeat(24)
  );

  // Also check the raw hex to make sure it matches the trace
  const rawHex = '0x' + Buffer.from('sibl').toString('hex') +
    api.createType('u32', 200).toHex(true).slice(2) +
    '00'.repeat(24);
  console.log(`Raw sovereign hex: ${rawHex}`);
  console.log(`Sovereign SS58: ${sovereignHex.toString()}`);
  console.log(`Current block: ${currentBlock}`);

  // Check last 20 blocks
  const startBlock = Math.max(1, currentBlock - 20);
  console.log(`\nSovereign account balance at each block (${startBlock} to ${currentBlock}):`);

  for (let i = startBlock; i <= currentBlock; i++) {
    try {
      const hash = await api.rpc.chain.getBlockHash(i);
      const acct = await api.query.system.account.at(hash, sovereignHex);
      const free = acct.data.free.toString();
      const providers = acct.providers.toString();
      const flags = acct.data.flags.toBigInt();
      const hasNewLogic = (flags & (1n << 127n)) !== 0n;
      if (free !== '0' || providers !== '0') {
        console.log(`  Block #${i}: free=${free} providers=${providers} newLogic=${hasNewLogic}`);
      }
    } catch {
      // state pruned
    }
  }

  // Also check current state
  console.log('\nCurrent state:');
  const acct = await api.query.system.account(sovereignHex);
  console.log(`  free: ${acct.data.free.toString()}`);
  console.log(`  reserved: ${acct.data.reserved.toString()}`);
  console.log(`  frozen: ${acct.data.frozen.toString()}`);
  console.log(`  providers: ${acct.providers.toString()}`);
  console.log(`  flags raw: ${acct.data.flags.toString()}`);
  const flags = acct.data.flags.toBigInt();
  console.log(`  NEW_LOGIC flag: ${(flags & (1n << 127n)) !== 0n}`);

  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
