#!/usr/bin/env node
/**
 * Pre-flight check for the measurement campaign: is the network healthy enough
 * to measure? Every measurement waits for finalized blocks, so a network whose
 * finality has stalled (for example after hours of running, or after the host
 * slept) produces failures and "lost" transactions that are not CCRMS results.
 *
 * Checks, on the relay chain and both parachains:
 *   1. the finalized head advances within 60 s;
 *   2. the gap between best and finalized head is at most 10 blocks;
 * and on both parachains:
 *   3. a system.remark from //Alice is finalized within 120 s. A remark can come
 *      back Invalid when the collator discards the block holding it (Finding F,
 *      once a minute); it is then sent again, up to three attempts in all. A
 *      repeated remark is harmless.
 *
 * Usage: node scripts/perf/preflight.mjs <relay-ws> [paraA-ws] [paraB-ws]
 * Exits 0 if every check passes, 1 otherwise.
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const [RELAY_WS, PARA_A_WS = 'ws://127.0.0.1:9990', PARA_B_WS = 'ws://127.0.0.1:9991'] = process.argv.slice(2);
if (!RELAY_WS) {
  console.error('Usage: node scripts/perf/preflight.mjs <relay-ws> [paraA-ws] [paraB-ws]');
  process.exit(2);
}
const MAX_LAG = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finalized(api) {
  return (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
}

async function checkFinality(name, api) {
  const start = await finalized(api);
  const deadline = Date.now() + 60_000;
  let now = start;
  while (now <= start && Date.now() < deadline) {
    await sleep(3000);
    now = await finalized(api);
  }
  const best = (await api.rpc.chain.getHeader()).number.toNumber();
  const lag = best - now;
  const ok = now > start && lag <= MAX_LAG;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: finalized ${start} -> ${now}, best ${best} (lag ${lag})`);
  return ok;
}

async function remarkFinalized(name, api, alice) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleep(12_000);
    const r = await remarkOnce(name, api, alice, attempt);
    if (r.ok || !r.retry) return r.ok;
  }
  return false;
}

function remarkOnce(name, api, alice, attempt) {
  return new Promise((resolve) => {
    let done = false;
    const t0 = Date.now();
    const finish = (ok, msg, retry = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const tag = ok ? 'OK  ' : retry && attempt < 3 ? 'RETRY' : 'FAIL';
      console.log(`${tag} ${name}: remark ${msg}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      resolve({ ok, retry });
    };
    const timer = setTimeout(() => finish(false, 'not finalized within 120 s'), 120_000);
    api.tx.system.remark('0x' + Buffer.from(`preflight ${Date.now()}`).toString('hex'))
      .signAndSend(alice, ({ status, dispatchError }) => {
        if (status.isInvalid || status.isDropped || status.isUsurped) return finish(false, `rejected: ${status.type}`, true);
        if (status.isFinalized) {
          if (dispatchError) return finish(false, `failed: ${dispatchError.toString()}`);
          finish(true, `finalized in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        }
      })
      .catch((e) => finish(false, `submit error: ${e.message}`));
  });
}

async function main() {
  await cryptoWaitReady();
  const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
  const apis = {
    relay: await ApiPromise.create({ provider: new WsProvider(RELAY_WS) }),
    paraA: await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) }),
    paraB: await ApiPromise.create({ provider: new WsProvider(PARA_B_WS) }),
  };
  const results = await Promise.all([
    ...Object.entries(apis).map(([n, api]) => checkFinality(n, api)),
    remarkFinalized('paraA', apis.paraA, alice),
    remarkFinalized('paraB', apis.paraB, alice),
  ]);
  const ok = results.every(Boolean);
  console.log(ok ? 'Pre-flight passed.' : 'Pre-flight FAILED: restart the network before measuring.');
  await Promise.all(Object.values(apis).map((a) => a.disconnect()));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
