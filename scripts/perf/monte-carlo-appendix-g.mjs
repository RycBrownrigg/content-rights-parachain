#!/usr/bin/env node
/**
 * Reproduces the Appendix G sweeps (fee, discovery, fine-grained crossover,
 * mean-revenue crossover, Web3 sensitivity) from the model in
 * monte-carlo-revenue.mjs. Uses the sensitivity grid (200 creators x 2,000
 * iterations, seed 42), matching sensitivityAnalysis().
 *
 * Usage:
 *   node monte-carlo-appendix-g.mjs                 # model as published
 *   node monte-carlo-appendix-g.mjs --no-secondary  # prototype as built
 *
 * Writes results/monte-carlo-appendix-g[-no-secondary].json.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  simulateCreatorRevenue, DEFAULT_PARAMS, PLATFORMS, STREAM_WEIGHTS, createRng,
  lognormalSample, uniformSample, betaSample, exponentialSample,
} from './monte-carlo-revenue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

const noSecondary = process.argv.includes('--no-secondary');
if (noSecondary) STREAM_WEIGHTS.secondary = 0;

const GRID = { ...DEFAULT_PARAMS, nCreators: 200, nIterations: 2_000 };
const BASE_PLATFORMS = JSON.parse(JSON.stringify(PLATFORMS));

function resetPlatforms() {
  for (const [k, v] of Object.entries(BASE_PLATFORMS)) Object.assign(PLATFORMS[k], v);
}

// Base audiences in the same RNG order as simulateCreatorRevenue().
function baseAudiences(params) {
  const rng = createRng(42);
  const len = params.nCreators * params.nIterations;
  const a = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    a[i] = lognormalSample(rng, params.audienceMu, params.audienceSigma);
    uniformSample(rng, params.priceLow, params.priceHigh);
    betaSample(rng, params.subAlpha, params.subBeta);
    betaSample(rng, params.ppvAlpha, params.ppvBeta);
    Math.min(exponentialSample(rng, params.resaleLambda), 1.0);
  }
  return a;
}

function compare(res, other = 'centralised') {
  const x = res.ccrms, y = res[other];
  let sx = 0, sy = 0, wins = 0;
  for (let i = 0; i < x.length; i++) { sx += x[i]; sy += y[i]; if (x[i] > y[i]) wins++; }
  return { advantagePct: (sx / sy - 1) * 100, winRatePct: (wins / x.length) * 100 };
}

function run() {
  return simulateCreatorRevenue(GRID, createRng(42));
}

const out = { noSecondary, grid: { nCreators: GRID.nCreators, nIterations: GRID.nIterations, seed: 42 } };

// Baseline
resetPlatforms();
const baseRes = run();
out.baseline = compare(baseRes);

// G.3 fee sweep (CCRMS fee fixed)
out.feeSweep = [];
for (const fee of [0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.15]) {
  resetPlatforms();
  PLATFORMS.ccrms.feeLow = fee; PLATFORMS.ccrms.feeHigh = fee;
  out.feeSweep.push({ feePct: fee * 100, ...compare(run()) });
}

// G.4 centralized discovery sweep
out.discoverySweep = [];
for (const f of [0, 0.25, 0.5, 0.75, 1, 1.5, 2]) {
  resetPlatforms();
  PLATFORMS.centralised.discoveryAddLow = BASE_PLATFORMS.centralised.discoveryAddLow * f;
  PLATFORMS.centralised.discoveryAddHigh = BASE_PLATFORMS.centralised.discoveryAddHigh * f;
  out.discoverySweep.push({ factor: f, ...compare(run()) });
}

// G.5 fine-grained crossover buckets (win rate and mean revenue by audience)
resetPlatforms();
const aud = baseAudiences(GRID);
const edges = [1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 6_000, 7_000,
  8_000, 9_000, 10_000, 12_500, 15_000, 20_000, 30_000, 50_000, 100_000];
out.crossoverBuckets = [];
for (let b = 0; b < edges.length - 1; b++) {
  const lo = edges[b], hi = edges[b + 1];
  let n = 0, wins = 0, sx = 0, sy = 0;
  for (let i = 0; i < aud.length; i++) {
    if (aud[i] >= lo && aud[i] < hi) {
      n++; sx += baseRes.ccrms[i]; sy += baseRes.centralised[i];
      if (baseRes.ccrms[i] > baseRes.centralised[i]) wins++;
    }
  }
  out.crossoverBuckets.push({
    lo, hi, scenarios: n,
    winRatePct: n ? (wins / n) * 100 : null,
    meanAdvantagePct: sy ? (sx / sy - 1) * 100 : null,
  });
}

// G.7 Web3 marketplace sensitivity (CCRMS vs Web3)
const w = BASE_PLATFORMS.web3, c = BASE_PLATFORMS.ccrms;
const web3Cases = [
  ['Baseline', {}],
  ['Discovery same as CCRMS', { discoveryAddLow: c.discoveryAddLow, discoveryAddHigh: c.discoveryAddHigh }],
  ['Discovery doubled', { discoveryAddLow: w.discoveryAddLow * 2, discoveryAddHigh: w.discoveryAddHigh * 2 }],
  ['Churn same as CCRMS', { churnLow: c.churnLow, churnHigh: c.churnHigh }],
  ['Churn 8-15%', { churnLow: 0.08, churnHigh: 0.15 }],
  ['Cost/tx same as CCRMS', { txCostPerUnit: c.txCostPerUnit }],
  ['All non-fee dynamics same as CCRMS', {
    discoveryAddLow: c.discoveryAddLow, discoveryAddHigh: c.discoveryAddHigh,
    churnLow: c.churnLow, churnHigh: c.churnHigh, txCostPerUnit: c.txCostPerUnit,
  }],
];
out.web3Sensitivity = [];
for (const [label, patch] of web3Cases) {
  resetPlatforms();
  Object.assign(PLATFORMS.web3, patch);
  out.web3Sensitivity.push({ case: label, ...compare(run(), 'web3') });
}
resetPlatforms();

mkdirSync(RESULTS_DIR, { recursive: true });
const file = join(RESULTS_DIR, `monte-carlo-appendix-g${noSecondary ? '-no-secondary' : ''}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log(`Written: ${file}`);
