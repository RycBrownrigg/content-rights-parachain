#!/usr/bin/env node
/**
 * Open-loop throughput: offered load against achieved inclusion rate on CCRMS.
 *
 * The earlier throughput and stress harnesses are closed-loop: they wait for a
 * batch before sending the next, so the rate they report is bounded by the
 * harness (Section 7, construct validity). This script is open-loop. For each
 * offered rate r (tx/s) it pre-signs r x DURATION transactions and submits them
 * on a fixed schedule whatever the chain is doing, then counts what reaches a
 * FINALIZED block (blocks on the single-collator testnet can be discarded and
 * re-authored, Finding F). Raising r until the achieved rate stops following it
 * gives the chain's capacity for that operation, rather than the harness's.
 *
 * Each rate uses fresh accounts (//openloop/<op>/<run>/<r>/<i>), funded from
 * //Alice just before the rate starts, each sending PER_ACCOUNT transactions
 * with consecutive nonces, so a rate cannot inherit stuck nonces from the last.
 *
 * Operations (--op):
 *   purchase_views  purchaseViews(content, 1): a payment to the creator; the
 *                   first purchase by an account also mints its child NFT
 *   check_access    checkAccess(content): reads all three rights maps, emits an
 *                   event, no payment
 *
 * Per rate it records
 *   submitted / accepted / rejected   at author_submitExtrinsic (pool full etc.)
 *   included (ok / failed)            in finalized blocks, with dispatch errors
 *   lost                              accepted but not finalized by the end of drain
 *   windowTps    included txs in blocks whose timestamp lies in the send window,
 *                divided by the window length (the steady-state rate)
 *   overallTps   all included txs divided by (last block timestamp - send start)
 *   latency      inclusion = block timestamp - submit time; finality = time the
 *                finalized head was seen - submit time (p50/p95/p99/max, ms)
 *   blocks       block interval, our txs per block, normal-class ref_time and
 *                proof_size used as a share of the normal-class limit
 * and once, the capacity the benchmarked weights predict: the normal-class
 * limit divided by the per-transaction weight actually charged (from
 * ExtrinsicSuccess) and by the declared pre-dispatch weight, and the block
 * length limit divided by the transaction length.
 *
 * The sweep stops after the first rate at which more than 20% of submitted
 * transactions are rejected or lost (that rate is kept), unless --no-stop.
 *
 * Usage:
 *   node scripts/perf/open-loop-throughput.mjs [paraA-ws] [--op purchase_views|check_access]
 *        [--rates 10,20,40,80,120,160,240] [--duration 60] [--drain 120] [--per-account 10] [--no-stop]
 * Output: scripts/perf/results/open-loop-<op>.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const args = process.argv.slice(2);
const valueFlags = new Set(['--op', '--rates', '--duration', '--drain', '--per-account']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : dflt;
};
const WS = positional[0] || 'ws://127.0.0.1:9990';
const OP = flag('op', 'purchase_views');
const RATES = flag('rates', '10,20,40,80,120,160,240').split(',').map(Number);
const DURATION = Number(flag('duration', 60));
const DRAIN = Number(flag('drain', 120));
const PER_ACCOUNT = Number(flag('per-account', 10));
const NO_STOP = args.includes('--no-stop');
const STOP_LOSS = 0.2;

const UNIT = 10n ** 12n;
const FUND = 100n * UNIT;
const PRICE = UNIT / 100n; // 0.01 UNIT per view
const TICK_MS = 50;
const RUN_ID = Date.now().toString(36);
const OUTPUT_DIR = 'scripts/perf/results';
const OUTPUT = `${OUTPUT_DIR}/open-loop-${OP}.json`;

if (!['purchase_views', 'check_access'].includes(OP)) {
  console.error(`unknown --op ${OP}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: Math.round(mean), p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] };
};

// Resolves once the transaction is FINALIZED, with its dispatch error if any.
function send(api, tx, signer) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error('transaction not finalized after 180 s')), 180_000);
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (done) return;
      if (status.isInvalid || status.isDropped || status.isUsurped) return finish(reject, new Error(`transaction ${status.type}`));
      if (!status.isFinalized) return;
      if (dispatchError) {
        const msg = dispatchError.isModule
          ? (({ section, name }) => `${section}.${name}`)(api.registry.findMetaError(dispatchError.asModule))
          : dispatchError.toString();
        return finish(resolve, { error: msg, events, blockHash: status.asFinalized });
      }
      finish(resolve, { blockHash: status.asFinalized, events });
    }).catch((e) => finish(reject, e));
  });
}

// Fund `addresses` from `alice` with pre-signed transfers (consecutive nonces),
// then wait until every account holds FUND in the finalized state.
async function fund(api, alice, addresses) {
  let nonce = (await api.rpc.system.accountNextIndex(alice.address)).toNumber();
  const CHUNK = 500;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const part = addresses.slice(i, i + CHUNK);
    await Promise.all(part.map((addr) => {
      const tx = api.tx.balances.transferKeepAlive(addr, FUND)
        .sign(alice, { nonce: nonce++, era: 0, blockHash: api.genesisHash });
      return api.rpc.author.submitExtrinsic(tx.toHex());
    }));
  }
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const fin = await api.rpc.chain.getFinalizedHead();
    const at = await api.at(fin);
    const infos = await at.query.system.account.multi(addresses);
    const funded = infos.filter((a) => a.data.free.toBigInt() >= FUND).length;
    if (funded === addresses.length) return;
    if (Date.now() > deadline) throw new Error(`funding: only ${funded}/${addresses.length} finalized after 10 min`);
    await sleep(6000);
  }
}

// Follows finalized blocks from `fromNumber`, matching their extrinsics against
// `pending` (hash -> record). Processing is serialized; stop() unsubscribes.
async function follow(api, fromNumber, pending, blocks) {
  let next = fromNumber;
  let chain = Promise.resolve();
  const unsub = await api.rpc.chain.subscribeFinalizedHeads((head) => {
    const seenAt = Date.now();
    const target = head.number.toNumber();
    chain = chain.then(async () => {
      for (; next <= target; next++) {
        const hash = await api.rpc.chain.getBlockHash(next);
        const [block, at] = await Promise.all([api.rpc.chain.getBlock(hash), api.at(hash)]);
        const [events, ts, weight] = await Promise.all([
          at.query.system.events(), at.query.timestamp.now(), at.query.system.blockWeight(),
        ]);
        const tsMs = ts.toNumber();
        let ours = 0;
        block.block.extrinsics.forEach((xt, index) => {
          const rec = pending.get(xt.hash.toHex());
          if (!rec || rec.block !== undefined) return;
          ours++;
          rec.block = next;
          rec.blockTs = tsMs;
          rec.finalSeen = seenAt;
          const evs = events.filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.toNumber() === index);
          const ok = evs.find(({ event }) => event.section === 'system' && event.method === 'ExtrinsicSuccess');
          const bad = evs.find(({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed');
          if (ok) {
            rec.ok = true;
            rec.weight = ok.event.data[0].weight;
          } else if (bad) {
            rec.ok = false;
            const err = bad.event.data[0];
            rec.error = err.isModule
              ? (({ section, name }) => `${section}.${name}`)(api.registry.findMetaError(err.asModule))
              : err.toString();
          }
        });
        blocks.push({
          number: next,
          ts: tsMs,
          extrinsics: block.block.extrinsics.length,
          ours,
          normalRefTime: weight.normal.refTime.toBigInt(),
          normalProofSize: weight.normal.proofSize.toBigInt(),
          lengthBytes: block.block.encodedLength,
        });
      }
    }).catch((e) => console.error(`  follower: ${e.message}`));
  });
  return async () => { await chain; unsub(); };
}

function buildCall(api, contentId) {
  return OP === 'purchase_views'
    ? api.tx.contentRights.purchaseViews(contentId, 1)
    : api.tx.contentRights.checkAccess(contentId);
}

async function runRate(api, alice, keyring, contentId, rate, limits) {
  const total = Math.round(rate * DURATION);
  const nAccounts = Math.ceil(total / PER_ACCOUNT);
  console.log(`\n== ${rate} tx/s for ${DURATION} s: ${total} txs from ${nAccounts} accounts ==`);
  const pairs = Array.from({ length: nAccounts }, (_, i) => keyring.addFromUri(`//openloop/${OP}/${RUN_ID}/${rate}/${i}`));
  console.log('  funding...');
  await fund(api, alice, pairs.map((p) => p.address));

  // Transaction k: account k % nAccounts, nonce floor(k / nAccounts), so each
  // account's next nonce is sent DURATION / PER_ACCOUNT seconds after the last.
  console.log('  pre-signing...');
  const txs = [];
  for (let k = 0; k < total; k++) {
    const pair = pairs[k % nAccounts];
    const tx = buildCall(api, contentId).sign(pair, { nonce: Math.floor(k / nAccounts), era: 0, blockHash: api.genesisHash });
    txs.push({ hex: tx.toHex(), hash: tx.hash.toHex(), length: tx.encodedLength });
  }

  const pending = new Map();
  const blocks = [];
  const startNumber = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber() + 1;
  const stop = await follow(api, startNumber, pending, blocks);

  const rejections = new Map();
  let accepted = 0;
  let sent = 0;
  const inflight = [];
  const t0 = Date.now();
  console.log('  sending...');
  while (sent < total) {
    const due = Math.min(total, Math.floor(((Date.now() - t0) / 1000) * rate) + 1);
    for (; sent < due; sent++) {
      const t = txs[sent];
      const rec = { submit: Date.now() };
      pending.set(t.hash, rec);
      inflight.push(
        api.rpc.author.submitExtrinsic(t.hex).then(
          () => { accepted++; rec.accepted = true; },
          (e) => {
            rec.accepted = false;
            const key = (e.message || String(e)).slice(0, 120);
            rejections.set(key, (rejections.get(key) || 0) + 1);
          },
        ),
      );
    }
    await sleep(TICK_MS);
  }
  const sendEnd = Date.now();
  await Promise.all(inflight);
  const offeredActual = total / ((sendEnd - t0) / 1000);

  // Drain: wait until every accepted transaction is finalized, or DRAIN seconds.
  const deadline = sendEnd + DRAIN * 1000;
  for (;;) {
    const included = [...pending.values()].filter((r) => r.block !== undefined).length;
    if (included >= accepted || Date.now() > deadline) break;
    await sleep(3000);
  }
  await sleep(1000);
  await stop();

  const recs = [...pending.values()];
  const inc = recs.filter((r) => r.block !== undefined);
  const okRecs = inc.filter((r) => r.ok);
  const failed = inc.filter((r) => r.ok === false);
  const failReasons = {};
  for (const r of failed) failReasons[r.error] = (failReasons[r.error] || 0) + 1;
  const lost = recs.filter((r) => r.accepted && r.block === undefined).length;
  const rejected = recs.filter((r) => r.accepted === false).length;

  const windowEnd = t0 + DURATION * 1000;
  const inWindow = inc.filter((r) => r.blockTs >= t0 && r.blockTs <= windowEnd).length;
  const lastTs = inc.reduce((m, r) => Math.max(m, r.blockTs), t0);
  const ourBlocks = blocks.filter((b) => b.ours > 0);
  const intervals = [];
  for (let i = 1; i < blocks.length; i++) intervals.push(blocks[i].ts - blocks[i - 1].ts);

  const share = (x, max) => Number((x * 10000n) / max) / 100;
  const result = {
    offeredRate: rate,
    offeredActual: Number(offeredActual.toFixed(2)),
    submitted: total,
    accepted,
    rejected,
    rejections: Object.fromEntries(rejections),
    included: inc.length,
    includedOk: okRecs.length,
    includedFailed: failed.length,
    failReasons,
    lost,
    lossShare: Number(((rejected + lost) / total).toFixed(4)),
    windowTps: Number((inWindow / DURATION).toFixed(2)),
    overallTps: Number((inc.length / Math.max(1, (lastTs - t0) / 1000)).toFixed(2)),
    latencyInclusionMs: stats(inc.map((r) => r.blockTs - r.submit)),
    latencyFinalityMs: stats(inc.map((r) => r.finalSeen - r.submit)),
    blocks: {
      count: blocks.length,
      withOurs: ourBlocks.length,
      intervalMs: stats(intervals),
      oursPerBlock: stats(ourBlocks.map((b) => b.ours)),
      normalRefTimePct: stats(ourBlocks.map((b) => share(b.normalRefTime, limits.normalRefTime))),
      normalProofSizePct: stats(ourBlocks.map((b) => share(b.normalProofSize, limits.normalProofSize))),
      lengthBytes: stats(ourBlocks.map((b) => b.lengthBytes)),
    },
    perBlock: blocks.map((b) => ({ ...b, normalRefTime: b.normalRefTime.toString(), normalProofSize: b.normalProofSize.toString() })),
    sampleChargedWeight: okRecs[0]?.weight
      ? { refTime: okRecs[0].weight.refTime.toString(), proofSize: okRecs[0].weight.proofSize.toString() }
      : null,
    txLength: txs[0]?.length ?? null,
  };
  console.log(
    `  accepted ${accepted}/${total}, included ${inc.length} (ok ${okRecs.length}, failed ${failed.length}), lost ${lost}, rejected ${rejected}`,
  );
  console.log(
    `  window ${result.windowTps} tx/s, overall ${result.overallTps} tx/s; inclusion p50 ${result.latencyInclusionMs.p50} ms, p95 ${result.latencyInclusionMs.p95} ms; ` +
      `max ${result.blocks.oursPerBlock.max ?? 0}/block, ref_time p50 ${result.blocks.normalRefTimePct.p50 ?? 0}%, proof p50 ${result.blocks.normalProofSizePct.p50 ?? 0}%`,
  );
  if (rejected) console.log(`  rejections: ${JSON.stringify(result.rejections)}`);
  if (failed.length) console.log(`  dispatch failures: ${JSON.stringify(failReasons)}`);
  return result;
}

async function main() {
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');

  const bw = api.consts.system.blockWeights;
  const normal = bw.perClass.normal;
  const maxTotal = normal.maxTotal.isSome ? normal.maxTotal.unwrap() : bw.maxBlock;
  const limits = { normalRefTime: maxTotal.refTime.toBigInt(), normalProofSize: maxTotal.proofSize.toBigInt() };
  const maxLenNormal = api.consts.system.blockLength.max.normal.toNumber();
  console.log(`Open-loop ${OP} on ${WS}; rates ${RATES.join(', ')} tx/s; ${DURATION} s each; drain ${DRAIN} s`);
  console.log(`Normal-class limit: ref_time ${limits.normalRefTime}, proof_size ${limits.normalProofSize}, length ${maxLenNormal}`);

  // Content item with a non-zero view price and no royalty splits.
  const hash = '0x' + Buffer.from(`open-loop-${RUN_ID}`).toString('hex').slice(0, 64).padEnd(64, '0');
  const reg = await send(api, api.tx.contentRights.registerContent(hash, 'Open-loop', PRICE, PRICE, PRICE, 100), alice);
  if (reg.error) throw new Error(`registerContent: ${reg.error}`);
  const contentId = reg.events.find(({ event }) => event.method === 'ContentRegistered').event.data[0].toNumber();
  console.log(`Content ${contentId} registered`);

  // Declared (pre-dispatch) weight of one transaction, for the predicted capacity.
  const probe = keyring.addFromUri(`//openloop/${OP}/${RUN_ID}/probe`);
  const probeTx = buildCall(api, contentId).sign(probe, { nonce: 0, era: 0, blockHash: api.genesisHash });
  const info = await api.call.transactionPaymentApi.queryInfo(probeTx.toHex(), probeTx.encodedLength);
  const declared = { refTime: info.weight.refTime.toBigInt(), proofSize: info.weight.proofSize.toBigInt() };

  const results = [];
  for (const rate of RATES) {
    const r = await runRate(api, alice, keyring, contentId, rate, limits);
    results.push(r);
    if (!NO_STOP && r.lossShare > STOP_LOSS) {
      console.log(`\nStopping: ${(r.lossShare * 100).toFixed(1)}% rejected or lost at ${rate} tx/s`);
      break;
    }
  }

  const charged = results.find((r) => r.sampleChargedWeight)?.sampleChargedWeight;
  const per = (limit, w) => (w > 0n ? Number(limit / w) : null);
  const txLen = results[0]?.txLength ?? probeTx.encodedLength;
  const predicted = {
    declaredWeight: { refTime: declared.refTime.toString(), proofSize: declared.proofSize.toString() },
    chargedWeight: charged ?? null,
    perBlockByDeclaredRefTime: per(limits.normalRefTime, declared.refTime),
    perBlockByDeclaredProofSize: per(limits.normalProofSize, declared.proofSize),
    perBlockByChargedRefTime: charged ? per(limits.normalRefTime, BigInt(charged.refTime)) : null,
    perBlockByChargedProofSize: charged ? per(limits.normalProofSize, BigInt(charged.proofSize)) : null,
    perBlockByLength: Math.floor(maxLenNormal / txLen),
  };
  const best = results.reduce((m, r) => (r.windowTps > (m?.windowTps ?? -1) ? r : m), null);
  const summary = {
    op: OP,
    ws: WS,
    durationS: DURATION,
    perAccount: PER_ACCOUNT,
    limits: { ...Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v.toString()])), normalLength: maxLenNormal },
    predicted,
    peakWindowTps: best?.windowTps ?? null,
    peakAtOfferedRate: best?.offeredRate ?? null,
    results,
    generatedAt: new Date().toISOString(),
  };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(summary, null, 2));

  console.log('\n rate  offered  window  overall  ok/submitted  lost  rejected  incl p50/p95 ms  max/block');
  for (const r of results) {
    console.log(
      ` ${String(r.offeredRate).padStart(4)}  ${String(r.offeredActual).padStart(7)}  ${String(r.windowTps).padStart(6)}  ${String(r.overallTps).padStart(7)}` +
        `  ${`${r.includedOk}/${r.submitted}`.padStart(12)}  ${String(r.lost).padStart(4)}  ${String(r.rejected).padStart(8)}` +
        `  ${`${r.latencyInclusionMs.p50}/${r.latencyInclusionMs.p95}`.padStart(15)}  ${String(r.blocks.oursPerBlock.max ?? 0).padStart(9)}`,
    );
  }
  console.log(`\nPredicted per block (normal class): declared ref_time ${predicted.perBlockByDeclaredRefTime}, ` +
    `declared proof ${predicted.perBlockByDeclaredProofSize}, charged ref_time ${predicted.perBlockByChargedRefTime}, ` +
    `charged proof ${predicted.perBlockByChargedProofSize}, length ${predicted.perBlockByLength}`);
  console.log(`Written ${OUTPUT}`);
  await api.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
