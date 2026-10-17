// Print the relay chain's session length and the wall-clock times of its last
// session changes (session.NewSession events), from the last N relay blocks.
// Usage: node scripts/perf/session-times.mjs <relay-ws> [blocks=150]
import { ApiPromise, WsProvider } from '@polkadot/api';
const [ws, nArg] = process.argv.slice(2);
const N = Number(nArg || 150);
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const epoch = api.consts.babe?.epochDuration?.toNumber();
const slot = api.consts.babe?.expectedBlockTime?.toNumber();
console.log(`relay epoch ${epoch} slots x ${slot} ms = ${(epoch * slot) / 1000} s per session`);
const best = (await api.rpc.chain.getHeader()).number.toNumber();
for (let n = Math.max(1, best - N); n <= best; n++) {
  const hash = await api.rpc.chain.getBlockHash(n);
  const at = await api.at(hash);
  const events = await at.query.system.events();
  const ns = events.find(({ event }) => event.section === 'session' && event.method === 'NewSession');
  if (ns) {
    const ts = new Date((await at.query.timestamp.now()).toNumber());
    console.log(`session ${ns.event.data[0].toString()} began at relay block ${n}, ${ts.toTimeString().slice(0, 8)}`);
  }
}
await api.disconnect();
