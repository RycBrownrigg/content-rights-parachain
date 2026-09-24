#!/usr/bin/env node
/**
 * Read-only XCM diagnostic for the two-chain Zombienet topology.
 *
 * Lists, block by block, every polkadotXcm.Sent on ParaB and every
 * CrossChain* rights event, messageQueue.Processed / ProcessingFailed and
 * xcmpQueue event on ParaA, plus rights-record counts per content item and
 * whether each chain is still producing blocks. Use it to tell whether
 * "missing" XCM messages arrived late, failed on arrival, or never arrived.
 *
 * Usage:
 *   node scripts/perf/xcm-diagnose.mjs [paraA-ws] [paraB-ws] [--blocks N]
 *   (scans the last N blocks of each chain; default 400)
 */

import { ApiPromise, WsProvider } from '@polkadot/api';

const positional = process.argv.slice(2).filter((a, i, arr) =>
  !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
const bi = process.argv.indexOf('--blocks');
const BLOCKS = bi > -1 ? Number(process.argv[bi + 1]) : 400;
const PARA_A_WS = positional[0] || 'ws://127.0.0.1:9990';
const PARA_B_WS = positional[1] || 'ws://127.0.0.1:9991';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function head(api) {
  return (await api.rpc.chain.getHeader()).number.toNumber();
}

function field(event, name) {
  const idx = event.meta.fields.findIndex((f) => f.name.toString() === name);
  return idx > -1 ? event.data[idx] : undefined;
}

async function scan(api, from, to, pick) {
  const rows = [];
  for (let n = from; n <= to; n++) {
    let hash, events, ts;
    try {
      hash = await api.rpc.chain.getBlockHash(n);
      [events, ts] = await Promise.all([
        api.query.system.events.at(hash),
        api.query.timestamp.now.at(hash),
      ]);
    } catch { continue; } // state pruned (non-archive node keeps ~256 blocks)
    for (const { event } of events) {
      const row = pick(event);
      if (row) rows.push({ block: n, time: new Date(ts.toNumber()).toISOString().slice(11, 19), ...row });
    }
  }
  return rows;
}

async function main() {
  const apiA = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS) });
  const apiB = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS) });

  // 1. Liveness
  const a0 = await head(apiA), b0 = await head(apiB);
  await sleep(15_000);
  const a1 = await head(apiA), b1 = await head(apiB);
  console.log(`\nLiveness over 15 s: ParaA ${a0} -> ${a1} (${a1 - a0} blocks), ParaB ${b0} -> ${b1} (${b1 - b0} blocks)`);
  if (a1 === a0) console.log('  !! ParaA is NOT producing blocks');
  if (b1 === b0) console.log('  !! ParaB is NOT producing blocks');

  // 2. ParaB sends
  const sent = await scan(apiB, Math.max(1, b1 - BLOCKS), b1, (e) =>
    e.section === 'polkadotXcm' && e.method === 'Sent' ? { event: 'Sent' } : null);
  console.log(`\nParaB polkadotXcm.Sent (last ${BLOCKS} blocks): ${sent.length}`);
  for (const r of sent) console.log(`  B#${r.block} ${r.time}`);

  // 3. ParaA arrivals
  const arrivals = await scan(apiA, Math.max(1, a1 - BLOCKS), a1, (e) => {
    if (e.section === 'contentRights' && e.method.startsWith('CrossChain')) {
      const b = field(e, 'beneficiary');
      return { event: e.method, beneficiary: b ? b.toString().slice(0, 10) + '…' : '' };
    }
    if (e.section === 'messageQueue') {
      const s = field(e, 'success');
      return { event: `messageQueue.${e.method}`, detail: s !== undefined ? `success=${s.toString()}` : e.data.toString().slice(0, 80) };
    }
    if (e.section === 'xcmpQueue' || e.section === 'polkadotXcm') {
      return { event: `${e.section}.${e.method}`, detail: e.data.toString().slice(0, 80) };
    }
    return null;
  });
  console.log(`\nParaA XCM-related events (last ${BLOCKS} blocks): ${arrivals.length}`);
  for (const r of arrivals) {
    console.log(`  A#${r.block} ${r.time} ${r.event} ${r.beneficiary || ''} ${r.detail || ''}`);
  }

  // 4. Rights records per content item (content IDs 0..9)
  console.log('\nRights records on ParaA:');
  for (let cid = 0; cid < 10; cid++) {
    const [subs, packs, owns] = await Promise.all([
      apiA.query.contentRights.subscriptions.keys(cid),
      apiA.query.contentRights.viewPacks.keys(cid),
      apiA.query.contentRights.ownership.keys(cid),
    ]);
    if (subs.length + packs.length + owns.length > 0) {
      console.log(`  content ${cid}: ${subs.length} subscriptions, ${packs.length} view packs, ${owns.length} ownerships`);
    }
  }

  await apiA.disconnect();
  await apiB.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error('Diagnostic failed:', e.message); process.exit(1); });
