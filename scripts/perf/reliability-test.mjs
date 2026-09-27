#!/usr/bin/env node
/**
 * Reliability test v2: uptime, recovery time and state persistence after the
 * collator process is killed.
 *
 * Per run:
 *   Phase 1  Baseline: record every new best block for BASELINE_SECS.
 *   Phase 2  Kill the collator (SIGKILL by default), wait for the process to
 *            exit, restart it with the same command line, then measure:
 *              - time until RPC answers
 *              - time until the first block AUTHORED AFTER THE KILL is seen
 *                (on-chain timestamp > kill time, so a block already in the
 *                database cannot count)
 *              - time until the first such block is finalized
 *   Phase 3  State checks: pre-kill finalized block still canonical, test
 *            content and subscription unchanged byte-for-byte, a new
 *            extrinsic is included.
 *   Phase 4  Recovery: record every new best block for RECOVERY_SECS.
 *
 * Changes from v1 (commit 2a81b45):
 *   - SIGKILL by default (--signal SIGTERM to compare with v1).
 *   - "First new block" is a block whose pallet-timestamp is later than the
 *     kill time. v1 read the best header already in the database.
 *   - RPC polled every 500 ms (v1: 2 s).
 *   - Records whether blocks authored before the kill were lost.
 *   - Writes the raw JSON and a console transcript; nothing is summarised
 *     by hand. Provenance (git commit, dirty flag, binary version) included.
 *
 * Clocks: pallet-timestamp is set by the collator from the host clock, and
 * this script runs on the same host, so on-chain timestamps and Date.now()
 * are directly comparable (to within the ~ms clock read skew).
 *
 * Usage (from repo root, with my-content-rights.toml running):
 *   node scripts/perf/reliability-test.mjs [ws-url] [--signal SIGKILL|SIGTERM]
 *        [--runs N] [--baseline-secs S] [--recovery-secs S]
 *
 * Output:
 *   scripts/perf/results/reliability/<runId>.json          raw results
 *   scripts/perf/results/reliability/<runId>.transcript.log console output
 *   /tmp/ccrms-reliability/<runId>-run<k>-collator.log      restarted collator
 *                                                           log (not committed)
 *
 * After the test the collator is a detached child of this script, not of
 * Zombienet. Stop Zombienet as usual, then kill the PID printed at the end.
 */

import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync, openSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join } from 'path';

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const PARA_WS = argv.find(a => a.startsWith('ws://') || a.startsWith('wss://')) || 'ws://127.0.0.1:9990';
const RPC_PORT = new URL(PARA_WS).port || '9990';
const SIGNAL = opt('signal', 'SIGKILL').toUpperCase();
const RUNS = parseInt(opt('runs', '1'), 10);
const BASELINE_MS = parseInt(opt('baseline-secs', '120'), 10) * 1000;
const RECOVERY_MS = parseInt(opt('recovery-secs', '120'), 10) * 1000;
const SLOT_MS = 6000;
const RPC_POLL_MS = 500;
const EXIT_TIMEOUT_MS = 60_000;
const NEW_BLOCK_TIMEOUT_MS = 300_000;

if (!['SIGKILL', 'SIGTERM'].includes(SIGNAL)) {
  console.error(`--signal must be SIGKILL or SIGTERM, got ${SIGNAL}`);
  process.exit(1);
}

const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${SIGNAL.toLowerCase()}`;
const OUT_DIR = 'scripts/perf/results/reliability';
const LOG_DIR = '/tmp/ccrms-reliability';
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
const TRANSCRIPT = join(OUT_DIR, `${RUN_ID}.transcript.log`);

function log(msg = '') {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(TRANSCRIPT, line + '\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

// ── Provenance ──────────────────────────────────────────────────────────────
function provenance(cmd) {
  const binary = cmd.argv[0];
  return {
    scriptVersion: 2,
    gitCommit: sh('git rev-parse HEAD'),
    // Untracked files (including this run's own output) do not count.
    gitDirty: (sh('git status --porcelain --untracked-files=no') || '').length > 0,
    collatorBinary: binary,
    collatorBinaryVersion: sh(`"${binary}" --version`),
    collatorBinaryMtime: sh(`date -r "${binary}" -u +%Y-%m-%dT%H:%M:%SZ`),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    host: sh('hostname'),
  };
}

// ── Collator process handling ───────────────────────────────────────────────
function findCollatorPid() {
  // Filter `ps` in JS: the executable must be parachain-template-node and the
  // arguments must contain --rpc-port <port>. (pgrep -f would also match any
  // shell whose command line merely contains the pattern text.)
  const rows = (sh('ps -eo pid=,args=') || '').split('\n');
  const portRe = new RegExp(`--rpc-port[ =]${RPC_PORT}(\\s|$)`);
  const pids = rows.map(r => r.trim().match(/^(\d+)\s+(\S+)(.*)$/))
    .filter(m => m && /(^|\/)parachain-template-node$/.test(m[2]) && portRe.test(m[3]))
    .map(m => parseInt(m[1], 10));
  if (pids.length === 0) throw new Error(`No parachain-template-node with --rpc-port ${RPC_PORT} found`);
  if (pids.length > 1) throw new Error(`Expected one collator process, found ${pids.join(', ')}`);
  return pids[0];
}

/** Exact argv and cwd of the running collator (Linux /proc, else ps/lsof). */
function collatorCommand(pid) {
  let args, cwd, exact = false;
  if (existsSync(`/proc/${pid}/cmdline`)) {
    args = readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
    cwd = sh(`readlink /proc/${pid}/cwd`);
    exact = true;
  } else {
    // macOS: ps loses quoting; fine as long as no argument contains a space.
    const ps = sh(`ps -o command= -p ${pid}`);
    if (!ps) throw new Error(`Could not read command line of PID ${pid}`);
    args = ps.split(/\s+/);
    cwd = (sh(`lsof -a -p ${pid} -d cwd -Fn`) || '').split('\n').find(l => l.startsWith('n'))?.slice(1);
  }
  if (!/parachain-template-node$/.test(args[0])) {
    throw new Error(`PID ${pid} is not the collator binary: ${args[0]}`);
  }
  if (!exact && args.some(a => a.includes('\\'))) {
    log('  WARNING: command line may contain escaped spaces; check the restart log.');
  }
  return { argv: args, cwd: cwd || process.cwd(), exact };
}

function isAlive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  // A killed process whose parent has not reaped it yet is a zombie: it has
  // stopped running (and released its ports and database) but kill(pid, 0)
  // still succeeds. Treat it as exited.
  const stat = sh(`ps -o stat= -p ${pid}`);
  return !!stat && !stat.startsWith('Z');
}

async function waitForExit(pid) {
  const t0 = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - t0 > EXIT_TIMEOUT_MS) throw new Error(`PID ${pid} still alive after ${EXIT_TIMEOUT_MS} ms`);
    await sleep(50);
  }
  return Date.now();
}

function restartCollator(cmd, runNo) {
  const logPath = join(LOG_DIR, `${RUN_ID}-run${runNo}-collator.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(cmd.argv[0], cmd.argv.slice(1), {
    cwd: cmd.cwd, stdio: ['ignore', fd, fd], detached: true,
  });
  child.unref();
  return { pid: child.pid, logPath };
}

// ── Chain helpers ───────────────────────────────────────────────────────────
function sendAndWait(api, tx, signer, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for inclusion')), timeoutMs);
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        clearTimeout(timer);
        if (dispatchError.isModule) {
          const d = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${d.section}.${d.name}`));
        } else reject(new Error(dispatchError.toString()));
      } else if (status.isInBlock) {
        clearTimeout(timer);
        resolve({ blockHash: status.asInBlock.toHex(), events });
      }
    }).catch(e => { clearTimeout(timer); reject(e); });
  });
}

async function onChainTimestamp(api, hash) {
  const at = await api.at(hash);
  return (await at.query.timestamp.now()).toNumber();
}

async function connect(timeoutMs = 30_000) {
  const provider = new WsProvider(PARA_WS, false);
  await provider.connect();
  const api = await Promise.race([
    ApiPromise.create({ provider, throwOnConnect: true }),
    sleep(timeoutMs).then(() => { throw new Error('connect timeout'); }),
  ]);
  await api.isReady;
  return api;
}

/** Record every new best block for durationMs, with on-chain timestamps. */
async function monitorBlocks(api, durationMs, label) {
  const blocks = [];
  const seen = new Set();
  const startBest = (await api.rpc.chain.getHeader()).number.toNumber();
  const t0 = Date.now();
  const unsub = await api.rpc.chain.subscribeNewHeads(async header => {
    const number = header.number.toNumber();
    if (number <= startBest || seen.has(number)) return;
    seen.add(number);
    const hash = header.hash.toHex();
    const observedAt = Date.now();
    let timestamp = null;
    try { timestamp = await onChainTimestamp(api, hash); } catch { /* pruned or reorged */ }
    blocks.push({ number, hash, timestamp, observedAt });
    process.stdout.write(`\r  [${label}] ${Math.round((observedAt - t0) / 1000)}s — block ${number}   `);
  });
  await sleep(durationMs);
  unsub();
  process.stdout.write('\n');
  const endBest = (await api.rpc.chain.getHeader()).number.toNumber();

  blocks.sort((a, b) => a.number - b.number);
  const intervals = [];
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1], b = blocks[i];
    if (a.timestamp && b.timestamp && b.number === a.number + 1) intervals.push(b.timestamp - a.timestamp);
  }
  const sorted = [...intervals].sort((x, y) => x - y);
  const expected = Math.floor(durationMs / SLOT_MS);
  const produced = endBest - startBest;
  return {
    durationMs, startBest, endBest,
    blocksProduced: produced,
    expectedBlocks: expected,
    uptimePct: Math.min(100, (produced / expected) * 100),
    blockIntervalMs: sorted.length ? {
      n: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)],
      mean: sorted.reduce((s, x) => s + x, 0) / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
    } : null,
    blocks,
  };
}

// ── One kill/restart run ────────────────────────────────────────────────────
async function oneRun(runNo, keyring, alice) {
  log(`\n════ Run ${runNo}/${RUNS} (${SIGNAL}) ════`);
  const pid = findCollatorPid();
  const cmd = collatorCommand(pid);
  log(`  Collator PID ${pid}; argv captured ${cmd.exact ? 'exactly (/proc)' : 'via ps'}; cwd ${cmd.cwd}`);

  // Test state, unique per run so repeated runs never collide.
  let api = await connect();
  const tag = `reliability-${RUN_ID}-run${runNo}`;
  const hash = '0x' + Buffer.from(tag).toString('hex').slice(0, 64).padEnd(64, '0');
  const reg = await sendAndWait(api, api.tx.contentRights.registerContent(hash, 'Reliability Test', 100, 10, 500, 100), alice);
  const ev = reg.events.find(({ event }) => event.section === 'contentRights' && event.method === 'ContentRegistered');
  const contentId = ev.event.data[0].toNumber();
  await sendAndWait(api, api.tx.contentRights.subscribe(contentId), alice);
  const contentBefore = (await api.query.contentRights.contents(contentId)).toHex();
  const subBefore = (await api.query.contentRights.subscriptions(contentId, alice.address)).toHex();
  log(`  Test content ${contentId} registered and subscribed.`);

  // Phase 1
  log('── Phase 1: baseline ──');
  const baseline = await monitorBlocks(api, BASELINE_MS, 'baseline');
  log(`  Blocks ${baseline.blocksProduced}/${baseline.expectedBlocks} (${baseline.uptimePct.toFixed(1)}%), ` +
      `median interval ${baseline.blockIntervalMs?.median ?? 'n/a'} ms`);

  // Phase 2
  log('── Phase 2: kill and restart ──');
  const preBest = await api.rpc.chain.getHeader();
  const preFinHash = (await api.rpc.chain.getFinalizedHead()).toHex();
  const preFin = await api.rpc.chain.getHeader(preFinHash);
  const preKill = {
    bestNumber: preBest.number.toNumber(), bestHash: preBest.hash.toHex(),
    finalizedNumber: preFin.number.toNumber(), finalizedHash: preFinHash,
  };
  await api.disconnect();

  const killTime = Date.now();
  process.kill(pid, SIGNAL);
  log(`  ${SIGNAL} sent to ${pid} at ${new Date(killTime).toISOString()} (best #${preKill.bestNumber}, finalized #${preKill.finalizedNumber})`);
  const exitTime = await waitForExit(pid);
  log(`  Process exited after ${exitTime - killTime} ms`);

  const restartTime = Date.now();
  const restarted = restartCollator(cmd, runNo);
  log(`  Restarted as PID ${restarted.pid}; log ${restarted.logPath}`);

  let rpcReadyTime = null;
  const deadline = Date.now() + NEW_BLOCK_TIMEOUT_MS;
  while (!rpcReadyTime && Date.now() < deadline) {
    try { api = await connect(5_000); rpcReadyTime = Date.now(); }
    catch { await sleep(RPC_POLL_MS); }
  }
  if (!rpcReadyTime) throw new Error('RPC did not come back');
  log(`  RPC ready ${rpcReadyTime - killTime} ms after kill`);

  // First block authored after the kill (best and finalized).
  const firstNew = await new Promise(async resolve => {
    const result = { best: null, finalized: null };
    const unsubs = [];
    const done = () => { if (result.best && result.finalized) { unsubs.forEach(u => u()); resolve(result); } };
    const watch = kind => async header => {
      if (result[kind]) return;
      const h = header.hash.toHex();
      const observedAt = Date.now();
      let ts;
      try { ts = await onChainTimestamp(api, h); } catch { return; }
      if (ts > killTime && !result[kind]) {
        result[kind] = { number: header.number.toNumber(), hash: h, timestamp: ts, observedAt };
        log(`  First ${kind} block authored after kill: #${result[kind].number}, ` +
            `seen ${observedAt - killTime} ms after kill (on-chain timestamp +${ts - killTime} ms)`);
        done();
      }
    };
    unsubs.push(await api.rpc.chain.subscribeNewHeads(watch('best')));
    unsubs.push(await api.rpc.chain.subscribeFinalizedHeads(watch('finalized')));
    setTimeout(() => { unsubs.forEach(u => u()); resolve(result); }, NEW_BLOCK_TIMEOUT_MS);
  });

  // Blocks authored before the kill that are no longer canonical.
  let lostPreKillBlocks = 0;
  for (let n = preKill.bestNumber; n > preKill.finalizedNumber; n--) {
    const h = (await api.rpc.chain.getBlockHash(n)).toHex();
    const isZero = /^0x0+$/.test(h);
    let ts = null;
    if (!isZero) { try { ts = await onChainTimestamp(api, h); } catch { /* ignore */ } }
    if (isZero || ts === null || ts > killTime) lostPreKillBlocks++;
    else break;
  }

  // Phase 3
  log('── Phase 3: state checks ──');
  const finalizedStillCanonical =
    (await api.rpc.chain.getBlockHash(preKill.finalizedNumber)).toHex() === preKill.finalizedHash;
  const contentAfter = (await api.query.contentRights.contents(contentId)).toHex();
  const subAfter = (await api.query.contentRights.subscriptions(contentId, alice.address)).toHex();
  let newTxIncluded = false, newTxError = null;
  try {
    const h2 = '0x' + Buffer.from(`${tag}-post`).toString('hex').slice(0, 64).padEnd(64, '0');
    await sendAndWait(api, api.tx.contentRights.registerContent(h2, 'Post Restart', 100, 10, 500, 100), alice);
    newTxIncluded = true;
  } catch (e) { newTxError = e.message; }
  const state = {
    contentId,
    finalizedStillCanonical,
    contentUnchanged: contentAfter === contentBefore,
    subscriptionUnchanged: subAfter === subBefore,
    newTxIncluded, newTxError,
  };
  state.intact = state.finalizedStillCanonical && state.contentUnchanged && state.subscriptionUnchanged && state.newTxIncluded;
  log(`  ${JSON.stringify(state)}`);

  // Phase 4
  log('── Phase 4: recovery ──');
  const recovery = await monitorBlocks(api, RECOVERY_MS, 'recovery');
  log(`  Blocks ${recovery.blocksProduced}/${recovery.expectedBlocks} (${recovery.uptimePct.toFixed(1)}%), ` +
      `median interval ${recovery.blockIntervalMs?.median ?? 'n/a'} ms`);
  await api.disconnect();

  return {
    run: runNo,
    provenance: provenance(cmd),
    signal: SIGNAL,
    collator: { pidBefore: pid, pidAfter: restarted.pid, argv: cmd.argv, argvExact: cmd.exact, cwd: cmd.cwd, restartLog: restarted.logPath },
    preKill,
    timesMs: {
      killToExit: exitTime - killTime,
      killToRestart: restartTime - killTime,
      killToRpcReady: rpcReadyTime - killTime,
      killToFirstNewBestSeen: firstNew.best ? firstNew.best.observedAt - killTime : null,
      killToFirstNewBestTimestamp: firstNew.best ? firstNew.best.timestamp - killTime : null,
      killToFirstNewFinalizedSeen: firstNew.finalized ? firstNew.finalized.observedAt - killTime : null,
    },
    firstNewBlock: firstNew,
    lostPreKillBlocks,
    state,
    baseline,
    recovery,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519' });
  const alice = keyring.addFromUri('//Alice');
  log(`Reliability test v2: ${RUNS} run(s), ${SIGNAL}, endpoint ${PARA_WS}`);

  const runs = [];
  for (let k = 1; k <= RUNS; k++) {
    try { runs.push(await oneRun(k, keyring, alice)); }
    catch (e) { log(`  Run ${k} FAILED: ${e.stack || e.message}`); runs.push({ run: k, error: e.message }); break; }
    // Save after every run so a later failure does not lose earlier data.
    writeFileSync(join(OUT_DIR, `${RUN_ID}.json`), JSON.stringify({
      runId: RUN_ID, startedFrom: PARA_WS, signal: SIGNAL,
      config: { BASELINE_MS, RECOVERY_MS, SLOT_MS, RPC_POLL_MS }, runs,
    }, null, 2));
  }

  log('\n═══ Summary ═══');
  for (const r of runs) {
    if (r.error) { log(`  Run ${r.run}: FAILED (${r.error})`); continue; }
    const t = r.timesMs;
    log(`  Run ${r.run}: exit ${t.killToExit} ms | RPC ${t.killToRpcReady} ms | first new block ${t.killToFirstNewBestSeen} ms | ` +
        `first new finalized ${t.killToFirstNewFinalizedSeen} ms | lost pre-kill blocks ${r.lostPreKillBlocks} | ` +
        `state ${r.state.intact ? 'intact' : 'NOT intact'} | uptime ${r.baseline.uptimePct.toFixed(0)}% → ${r.recovery.uptimePct.toFixed(0)}%`);
  }
  const last = runs.filter(r => !r.error).pop();
  if (last) log(`\n  Collator now runs as PID ${last.collator.pidAfter} (detached). Kill it after stopping Zombienet.`);
  log(`  Results: ${join(OUT_DIR, `${RUN_ID}.json`)}`);
  process.exit(0);
}

main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });
