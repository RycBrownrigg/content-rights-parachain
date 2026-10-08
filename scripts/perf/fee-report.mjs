#!/usr/bin/env node
/**
 * Fee report: what each CCRMS operation costs under the benchmarked weights.
 *
 * For every extrinsic it records
 *   declared   the pre-dispatch weight (ref_time, proof_size) and fee from
 *              payment_queryInfo; payment extrinsics declare the worst case of
 *              10 royalty splits and are refunded after dispatch;
 *   blockShare the declared weight as a share of the normal-class block limit,
 *              and the implied maximum per block;
 * and, for the user-facing operations, executes them on the chain (content
 * with 0 and with 10 royalty splits) and reads the fee actually paid from
 * transactionPayment.TransactionFeePaid. Fees are also given as a percentage of
 * the content price used here (10 UNIT), for comparison with the 1-5% fee the
 * Monte Carlo model assumes.
 *
 * Usage: node scripts/perf/fee-report.mjs [paraA-ws]
 * Output: scripts/perf/results/fee-report.json
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync } from 'fs';

const WS = process.argv[2] || 'ws://127.0.0.1:9990';
const UNIT = 10n ** 12n;
const PRICE = 10n * UNIT;
const OUTPUT = 'scripts/perf/results/fee-report.json';

function send(api, tx, signer) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(t); fn(v); } };
    const t = setTimeout(() => finish(reject, new Error('not finalized after 180 s')), 180_000);
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (status.isInvalid || status.isDropped || status.isUsurped) return finish(reject, new Error(status.type));
      if (!status.isFinalized) return;
      if (dispatchError) {
        const e = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return finish(reject, new Error(e ? `${e.section}.${e.name}` : dispatchError.toString()));
      }
      finish(resolve, { events, blockHash: status.asFinalized });
    }).catch((e) => finish(reject, e));
  });
}
const feePaid = (events) => {
  const ev = events.find(({ event }) => event.section === 'transactionPayment' && event.method === 'TransactionFeePaid');
  return ev ? ev.event.data[1].toBigInt() : null;
};
const units = (x) => Number(x) / Number(UNIT);

async function main() {
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });
  await cryptoWaitReady();
  const k = new Keyring({ type: 'sr25519' });
  const alice = k.addFromUri('//Alice');
  const stamp = Date.now();
  const user = (n) => k.addFromUri(`//Fee/${stamp}/${n}`);

  const maxBlock = api.consts.system.blockWeights.perClass.normal.maxExtrinsic.unwrap();
  const limitRef = maxBlock.refTime.toBigInt(), limitPov = maxBlock.proofSize.toBigInt();

  // Content with 0 and with 10 royalty splits; register and fund users first.
  const register = async (label) => {
    const hash = '0x' + Buffer.from(`fee-${label}-${stamp}`).toString('hex').slice(0, 64).padEnd(64, '0');
    const r = await send(api, api.tx.contentRights.registerContent(hash, `Fee ${label}`, PRICE, PRICE / 10n, PRICE, 14_400), alice);
    return { id: r.events.find(({ event }) => event.method === 'ContentRegistered').event.data[0].toNumber(), fee: feePaid(r.events) };
  };
  const c0 = await register('s0');
  const c10 = await register('s10');
  const splits = Array.from({ length: 10 }, (_, i) => ({ recipient: user(`split${i}`).publicKey, basisPoints: 1000 }));
  const setSplits = await send(api, api.tx.contentRights.setRoyaltySplits(c10.id, splits), alice);
  // Six funded users (three per content item) and one unfunded transfer recipient.
  const users = Array.from({ length: 7 }, (_, i) => user(i));
  for (const u of users.slice(0, 6)) await send(api, api.tx.balances.transferKeepAlive(u.address, 1000n * UNIT), alice);

  // Declared (pre-dispatch) weight and fee for every extrinsic.
  const bob = k.addFromUri('//Bob').address;
  const calls = {
    register_content: api.tx.contentRights.registerContent('0x' + '07'.repeat(32), 'x'.repeat(128), PRICE, PRICE, PRICE, 14_400),
    subscribe: api.tx.contentRights.subscribe(c0.id),
    renew_subscription: api.tx.contentRights.renewSubscription(c0.id),
    purchase_views: api.tx.contentRights.purchaseViews(c0.id, 10),
    consume_view: api.tx.contentRights.consumeView(c0.id),
    purchase_ownership: api.tx.contentRights.purchaseOwnership(c0.id),
    check_access: api.tx.contentRights.checkAccess(c0.id),
    transfer_ownership: api.tx.contentRights.transferOwnership(c0.id, bob),
    set_royalty_splits: api.tx.contentRights.setRoyaltySplits(c10.id, splits),
    enable_auto_renew: api.tx.contentRights.enableAutoRenew(c0.id),
    disable_auto_renew: api.tx.contentRights.disableAutoRenew(c0.id),
    query_rights_metadata: api.tx.contentRights.queryRightsMetadata(c0.id),
    set_meter: api.tx.contentRights.setMeter(c0.id, bob),
    consume_view_for: api.tx.contentRights.consumeViewFor(c0.id, bob),
    xcm_subscribe: api.tx.contentRights.xcmSubscribe(c0.id, bob),
    xcm_purchase_views: api.tx.contentRights.xcmPurchaseViews(c0.id, bob, 10),
    xcm_purchase_ownership: api.tx.contentRights.xcmPurchaseOwnership(c0.id, bob),
  };
  const declared = {};
  for (const [name, tx] of Object.entries(calls)) {
    const info = await tx.paymentInfo(alice);
    const ref = info.weight.refTime.toBigInt(), pov = info.weight.proofSize.toBigInt();
    const share = Math.max(Number(ref) / Number(limitRef), Number(pov) / Number(limitPov));
    declared[name] = { refTime: ref.toString(), proofSize: pov.toString(), feeUnits: units(info.partialFee.toBigInt()),
      blockSharePct: +(share * 100).toFixed(4), maxPerBlock: Math.floor(1 / share) };
    console.log(`declared ${name.padEnd(24)} ref ${ref} pov ${pov} fee ${declared[name].feeUnits.toFixed(6)} UNIT  ${declared[name].blockSharePct}% of block`);
  }

  // Actual fees paid, executing each user-facing operation on 0- and 10-split content.
  const actual = { register_content: units(c0.fee), set_royalty_splits_10: units(feePaid(setSplits.events)) };
  let u = 0;
  for (const [label, c] of [['s0', c0.id], ['s10', c10.id]]) {
    const a = users[u++], b = users[u++], v = users[u++];
    const run = async (name, tx, who) => {
      const r = await send(api, tx, who);
      actual[`${name}_${label}`] = units(feePaid(r.events));
      console.log(`paid     ${`${name} (${label})`.padEnd(30)} ${actual[`${name}_${label}`].toFixed(6)} UNIT  (${(actual[`${name}_${label}`] / 10 * 100).toFixed(4)}% of a 10 UNIT price)`);
    };
    await run('subscribe', api.tx.contentRights.subscribe(c), a);
    await run('purchase_views', api.tx.contentRights.purchaseViews(c, 10), v);
    await run('consume_view', api.tx.contentRights.consumeView(c), v);
    await run('check_access', api.tx.contentRights.checkAccess(c), v);
    await run('purchase_ownership', api.tx.contentRights.purchaseOwnership(c), b);
    await run('transfer_ownership', api.tx.contentRights.transferOwnership(c, users[6].address), b);
  }

  const out = { timestamp: new Date().toISOString(), ws: WS, priceUnits: 10,
    blockLimit: { refTime: limitRef.toString(), proofSize: limitPov.toString() }, declared, actualFeeUnits: actual };
  mkdirSync('scripts/perf/results', { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${OUTPUT}`);
  await api.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error('Fee report failed:', e.message); process.exit(1); });
