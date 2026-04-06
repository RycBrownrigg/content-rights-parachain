/**
 * Monte Carlo creator revenue simulation (RO6 — ES-13).
 *
 * Simulates 1,000 creators over 10,000 iterations to quantify potential
 * creator savings under the CCRMS unified-rights-token model compared to
 * centralised platforms, existing Web3 marketplaces, and bridge-based solutions.
 *
 * Models four competing dynamics that create genuine trade-offs:
 *   1. Platform fees (centralised 30-45%, CCRMS 1-5%)
 *   2. Discovery/network effects (centralised algorithms boost audience)
 *   3. On-chain transaction costs (CCRMS cost per tx scales with volume)
 *   4. Subscriber churn (centralised has stickier UX, lower churn)
 *
 * @module monte-carlo-revenue
 *
 * Exports (CLI only):
 * - simulateCreatorRevenue — Runs the Monte Carlo simulation for all platforms.
 * - sensitivityAnalysis — Varies each parameter to measure output sensitivity.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

// ---------------------------------------------------------------------------
// Seeded PRNG (xoshiro128** — fast, reproducible, good quality)
// ---------------------------------------------------------------------------

function createRng(seed = 42) {
  let s = BigInt(seed);
  const next64 = () => {
    s = BigInt.asUintN(64, s + 0x9e3779b97f4a7c15n);
    let z = s;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
  let s0 = Number(BigInt.asUintN(32, next64()));
  let s1 = Number(BigInt.asUintN(32, next64()));
  let s2 = Number(BigInt.asUintN(32, next64()));
  let s3 = Number(BigInt.asUintN(32, next64()));

  function random() {
    const result = Math.imul(s1, 5);
    const r = (((result << 7) | (result >>> 25)) * 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t;
    s3 = ((s3 << 11) | (s3 >>> 21));
    return r / 4294967296;
  }

  return { random };
}

// ---------------------------------------------------------------------------
// Distribution samplers
// ---------------------------------------------------------------------------

function normalSample(rng) {
  const u1 = rng.random() || 1e-15;
  const u2 = rng.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function lognormalSample(rng, mu, sigma) {
  return Math.exp(Math.log(mu) + sigma * normalSample(rng));
}

function uniformSample(rng, low, high) {
  return low + (high - low) * rng.random();
}

function gammaSample(rng, alpha) {
  if (alpha < 1) {
    return gammaSample(rng, alpha + 1) * Math.pow(rng.random() || 1e-15, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = normalSample(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.random() || 1e-15;
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaSample(rng, a, b) {
  const x = gammaSample(rng, a);
  const y = gammaSample(rng, b);
  return x / (x + y);
}

function exponentialSample(rng, lambda) {
  return -Math.log(rng.random() || 1e-15) / lambda;
}

// ---------------------------------------------------------------------------
// Platform model parameters
// ---------------------------------------------------------------------------

const NUM_CREATORS = 1_000;
const NUM_ITERATIONS = 10_000;

/**
 * Each platform has:
 *   feeLow/feeHigh         — fraction taken by platform (uniform draw per iteration)
 *   discoveryAddLow/High   — additional audience gained via discovery (added, not multiplied)
 *                             Modelled as a flat bonus: small creators benefit proportionally
 *                             more than large ones (realistic: algorithm helps you get found,
 *                             but doesn't scale your existing fanbase)
 *   churnLow/High          — monthly subscriber churn rate (higher = worse retention)
 *   txCostPerUnit          — marginal cost per transaction in USD
 */
const PLATFORMS = {
  centralised: {
    feeLow: 0.30, feeHigh: 0.45,
    discoveryAddLow: 500, discoveryAddHigh: 3_000,  // algorithm adds 500-3k viewers
    churnLow: 0.02, churnHigh: 0.05,                // 2-5% monthly churn (sticky UX)
    txCostPerUnit: 0.0,                              // near-zero marginal cost
  },
  web3: {
    feeLow: 0.075, feeHigh: 0.15,
    discoveryAddLow: 100, discoveryAddHigh: 800,     // marketplace adds some discovery
    churnLow: 0.05, churnHigh: 0.10,                 // moderate churn
    txCostPerUnit: 0.005,                             // gas fees per tx (~$0.005 L2)
  },
  bridge_based: {
    feeLow: 0.08, feeHigh: 0.15,
    discoveryAddLow: 50, discoveryAddHigh: 400,      // minimal discovery
    churnLow: 0.06, churnHigh: 0.12,                 // higher churn (bridge friction)
    txCostPerUnit: 0.02,                              // bridge + gas fees
  },
  ccrms: {
    feeLow: 0.01, feeHigh: 0.05,
    discoveryAddLow: 0, discoveryAddHigh: 200,       // organic only, minimal
    churnLow: 0.04, churnHigh: 0.08,                 // self-custody friction adds churn
    txCostPerUnit: 0.001,                             // parachain tx fees (~$0.001)
  },
};

const STREAM_WEIGHTS = {
  subscription: 0.50,
  ppv:          0.30,
  secondary:    0.20,
};

const DEFAULT_PARAMS = {
  // Creator base audience (before discovery multiplier)
  audienceMu:   1_000,
  audienceSigma: 2.0,
  // Content price per unit
  priceLow:     1.0,
  priceHigh:    50.0,
  // Subscription adoption rate: beta(a, b)
  subAlpha:     2.0,
  subBeta:      5.0,
  // PPV conversion rate: beta(a, b)
  ppvAlpha:     1.0,
  ppvBeta:      10.0,
  // Secondary-sale probability: exponential(lambda)
  resaleLambda: 0.1,
  // Subscription period (months) — churn compounds over this duration
  subMonths:    12,
  // Simulation dimensions
  nCreators:    NUM_CREATORS,
  nIterations:  NUM_ITERATIONS,
};

// ---------------------------------------------------------------------------
// Core simulation
// ---------------------------------------------------------------------------

/**
 * Runs the Monte Carlo simulation for all platform types.
 *
 * For each (iteration, creator) pair, draws base audience, price, conversion
 * rates, then applies platform-specific discovery, churn, fees, and tx costs.
 *
 * @returns Object mapping platform name to a flat Float64Array of shape
 *          (nIterations × nCreators) with net creator revenue in USD.
 */
function simulateCreatorRevenue(params = DEFAULT_PARAMS, rng = createRng(42)) {
  const n = params.nCreators;
  const iters = params.nIterations;
  const len = iters * n;

  // Pre-compute base creator attributes per (iteration, creator)
  const baseAudience = new Float64Array(len);
  const price        = new Float64Array(len);
  const subRate      = new Float64Array(len);
  const ppvRate      = new Float64Array(len);
  const resaleProb   = new Float64Array(len);

  for (let i = 0; i < len; i++) {
    baseAudience[i] = lognormalSample(rng, params.audienceMu, params.audienceSigma);
    price[i]        = uniformSample(rng, params.priceLow, params.priceHigh);
    subRate[i]      = betaSample(rng, params.subAlpha, params.subBeta);
    ppvRate[i]      = betaSample(rng, params.ppvAlpha, params.ppvBeta);
    resaleProb[i]   = Math.min(exponentialSample(rng, params.resaleLambda), 1.0);
  }

  const results = {};

  for (const [platform, cfg] of Object.entries(PLATFORMS)) {
    const net = new Float64Array(len);

    for (let i = 0; i < iters; i++) {
      // Per-iteration platform draws
      const feeRate      = uniformSample(rng, cfg.feeLow, cfg.feeHigh);
      const discoveryAdd = uniformSample(rng, cfg.discoveryAddLow, cfg.discoveryAddHigh);
      const churnRate    = uniformSample(rng, cfg.churnLow, cfg.churnHigh);
      const retention    = 1.0 - feeRate;

      // Subscriber retention over the subscription period (compounding monthly churn)
      const retainedFraction = Math.pow(1 - churnRate, params.subMonths);

      const base = i * n;
      for (let c = 0; c < n; c++) {
        const idx = base + c;

        // Effective audience = base organic audience + discovery bonus
        // Additive model: a creator with 50 followers gains more proportionally
        // from +2000 discovery than a creator with 50,000 followers
        const audience = baseAudience[idx] + discoveryAdd;

        // Subscription revenue (affected by churn — only retained subscribers pay full period)
        const subRevGross = audience * subRate[idx] * price[idx]
          * STREAM_WEIGHTS.subscription * retainedFraction;

        // PPV revenue (one-time, not affected by churn)
        const ppvRevGross = audience * ppvRate[idx] * price[idx]
          * STREAM_WEIGHTS.ppv;

        // Secondary sales (one-time, not affected by churn)
        const secRevGross = audience * resaleProb[idx] * price[idx]
          * STREAM_WEIGHTS.secondary;

        const grossRevenue = subRevGross + ppvRevGross + secRevGross;

        // Total transactions = subscribers + PPV buyers + secondary buyers
        const totalTx = audience * (subRate[idx] + ppvRate[idx] + resaleProb[idx]);

        // Net = gross × (1 - platform fee) − transaction costs
        net[idx] = Math.max(0, grossRevenue * retention - totalTx * cfg.txCostPerUnit);
      }
    }

    results[platform] = net;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function percentile(arr, p) {
  const sorted = Float64Array.from(arr).sort();
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarisePlatform(name, net, nCreators, nIterations) {
  const meanPerCreator = new Float64Array(nCreators);
  for (let c = 0; c < nCreators; c++) {
    let sum = 0;
    for (let i = 0; i < nIterations; i++) sum += net[i * nCreators + c];
    meanPerCreator[c] = sum / nIterations;
  }

  const totalPerIter = new Float64Array(nIterations);
  for (let i = 0; i < nIterations; i++) {
    let sum = 0;
    const base = i * nCreators;
    for (let c = 0; c < nCreators; c++) sum += net[base + c];
    totalPerIter[i] = sum;
  }

  const mean = meanPerCreator.reduce((a, b) => a + b, 0) / nCreators;
  const sorted = Float64Array.from(meanPerCreator).sort();
  const median = sorted[Math.floor(nCreators / 2)];
  const variance = meanPerCreator.reduce((a, v) => a + (v - mean) ** 2, 0) / nCreators;

  return {
    platform: name,
    meanCreatorRevenue: mean,
    medianCreatorRevenue: median,
    stdCreatorRevenue: Math.sqrt(variance),
    p5CreatorRevenue: percentile(meanPerCreator, 5),
    p95CreatorRevenue: percentile(meanPerCreator, 95),
    meanTotalRevenue: totalPerIter.reduce((a, b) => a + b, 0) / nIterations,
    ci95Low: percentile(totalPerIter, 2.5),
    ci95High: percentile(totalPerIter, 97.5),
  };
}

function computeSavings(summaries) {
  const ccrms = summaries.find(s => s.platform === 'ccrms');
  return summaries
    .filter(s => s.platform !== 'ccrms')
    .map(s => {
      const absSaving = ccrms.meanCreatorRevenue - s.meanCreatorRevenue;
      const pctSaving = s.meanCreatorRevenue ? (absSaving / s.meanCreatorRevenue) * 100 : 0;
      return { vsPlatform: s.platform, absoluteSavingUsd: absSaving, percentageSaving: pctSaving };
    });
}

/** Fraction of (iteration, creator) pairs where CCRMS beats the alternative. */
function breakEvenAnalysis(results, nCreators, nIterations) {
  const ccrms = results.ccrms;
  const len = nCreators * nIterations;
  const breakEven = {};
  for (const [platform, net] of Object.entries(results)) {
    if (platform === 'ccrms') continue;
    let wins = 0;
    for (let i = 0; i < len; i++) {
      if (ccrms[i] > net[i]) wins++;
    }
    breakEven[platform] = wins / len;
  }
  return breakEven;
}

/**
 * Analyses which creator audience sizes favour CCRMS vs centralised.
 * Buckets creators by base audience size and reports win rate per bucket.
 */
function creatorSizeAnalysis(results, params, rng) {
  // Re-run with a fresh RNG to get matched base audiences
  const analysisRng = createRng(42);
  const n = params.nCreators;
  const iters = params.nIterations;
  const len = iters * n;

  // Regenerate base audiences (same seed = same draws)
  const baseAudience = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    baseAudience[i] = lognormalSample(analysisRng, params.audienceMu, params.audienceSigma);
    // consume the other draws to stay in sync
    uniformSample(analysisRng, params.priceLow, params.priceHigh);
    betaSample(analysisRng, params.subAlpha, params.subBeta);
    betaSample(analysisRng, params.ppvAlpha, params.ppvBeta);
    Math.min(exponentialSample(analysisRng, params.resaleLambda), 1.0);
  }

  const buckets = [
    { label: 'tiny (<100)',       lo: 0,      hi: 100 },
    { label: 'small (100-500)',   lo: 100,    hi: 500 },
    { label: 'medium (500-2k)',   lo: 500,    hi: 2_000 },
    { label: 'large (2k-10k)',    lo: 2_000,  hi: 10_000 },
    { label: 'huge (10k-100k)',   lo: 10_000, hi: 100_000 },
    { label: 'mega (100k+)',      lo: 100_000, hi: Infinity },
  ];

  const ccrms = results.ccrms;
  const cent  = results.centralised;

  return buckets.map(({ label, lo, hi }) => {
    let wins = 0, total = 0;
    let ccrmsMean = 0, centMean = 0;
    for (let i = 0; i < len; i++) {
      if (baseAudience[i] >= lo && baseAudience[i] < hi) {
        total++;
        if (ccrms[i] > cent[i]) wins++;
        ccrmsMean += ccrms[i];
        centMean += cent[i];
      }
    }
    return {
      bucket: label,
      count: total,
      ccrmsWinRate: total ? wins / total : 0,
      ccrmsMeanRev: total ? ccrmsMean / total : 0,
      centMeanRev: total ? centMean / total : 0,
    };
  }).filter(b => b.count > 0);
}

// ---------------------------------------------------------------------------
// Sensitivity analysis
// ---------------------------------------------------------------------------

const SENSITIVITY_PARAMS = {
  audienceMu:    [500, 1_000, 2_000, 5_000],
  audienceSigma: [1.0, 1.5, 2.0, 3.0],
  priceLow:      [0.50, 1.0, 2.0, 5.0],
  priceHigh:     [20.0, 50.0, 100.0, 200.0],
  subAlpha:      [1.0, 2.0, 3.0, 5.0],
  ppvAlpha:      [0.5, 1.0, 2.0, 3.0],
  resaleLambda:  [0.05, 0.1, 0.2, 0.5],
  subMonths:     [1, 6, 12, 24],
};

function sensitivityAnalysis() {
  const rows = [];
  for (const [paramName, values] of Object.entries(SENSITIVITY_PARAMS)) {
    for (const val of values) {
      const p = { ...DEFAULT_PARAMS, nCreators: 200, nIterations: 2_000, [paramName]: val };
      const rng = createRng(42);
      const res = simulateCreatorRevenue(p, rng);

      const len = p.nCreators * p.nIterations;
      let ccrmsMean = 0, centMean = 0;
      let ccrmsWins = 0;
      for (let i = 0; i < len; i++) {
        ccrmsMean += res.ccrms[i];
        centMean += res.centralised[i];
        if (res.ccrms[i] > res.centralised[i]) ccrmsWins++;
      }
      ccrmsMean /= len;
      centMean /= len;

      rows.push({
        parameter: paramName,
        value: val,
        ccrmsMeanRevenue: ccrmsMean,
        centralisedMeanRevenue: centMean,
        savingPctVsCentralised: centMean ? ((ccrmsMean - centMean) / centMean) * 100 : 0,
        ccrmsWinRate: ccrmsWins / len,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function fmt(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pad(s, w) { return String(s).padStart(w); }
function padEnd(s, w) { return String(s).padEnd(w); }

function printSummary(summaries, savings, breakEven, sizeAnalysis) {
  console.log('\n' + '='.repeat(78));
  console.log('MONTE CARLO CREATOR REVENUE SIMULATION — RESULTS (with competing dynamics)');
  console.log(`  Creators: ${NUM_CREATORS.toLocaleString()}  |  Iterations: ${NUM_ITERATIONS.toLocaleString()}`);
  console.log('  Dynamics: discovery effects, churn, tx costs, platform fees');
  console.log('='.repeat(78));

  console.log(`\n${padEnd('Platform', 16)} ${padEnd('Mean Rev ($)', 14)} ${padEnd('Median ($)', 12)} ${padEnd('Std ($)', 12)} ${padEnd('P5 ($)', 12)} ${padEnd('P95 ($)', 12)}`);
  console.log('-'.repeat(78));
  for (const s of summaries) {
    console.log(`${padEnd(s.platform, 16)} ${pad(fmt(s.meanCreatorRevenue), 12)} ${pad(fmt(s.medianCreatorRevenue), 10)} ${pad(fmt(s.stdCreatorRevenue), 10)} ${pad(fmt(s.p5CreatorRevenue), 10)} ${pad(fmt(s.p95CreatorRevenue), 10)}`);
  }

  console.log(`\n${padEnd('Platform', 16)} ${padEnd('95% CI Low ($)', 16)} ${padEnd('95% CI High ($)', 16)}`);
  console.log('-'.repeat(48));
  for (const s of summaries) {
    console.log(`${padEnd(s.platform, 16)} ${pad(fmt(s.ci95Low), 14)} ${pad(fmt(s.ci95High), 14)}`);
  }

  console.log('\n--- CCRMS Savings vs Other Platforms ---');
  for (const sv of savings) {
    const sign = sv.percentageSaving >= 0 ? '+' : '';
    console.log(`  vs ${padEnd(sv.vsPlatform, 14)}: ${sign}$${pad(fmt(sv.absoluteSavingUsd), 12)}/creator  (${sign}${sv.percentageSaving.toFixed(1)}%)`);
  }

  console.log('\n--- Break-Even Analysis (fraction where CCRMS > alternative) ---');
  for (const [platform, frac] of Object.entries(breakEven)) {
    console.log(`  vs ${padEnd(platform, 14)}: ${(frac * 100).toFixed(1)}% of scenarios`);
  }

  console.log('\n--- Creator Size Analysis (CCRMS vs Centralised by audience bucket) ---');
  console.log(`  ${padEnd('Bucket', 22)} ${padEnd('Scenarios', 12)} ${padEnd('CCRMS Win%', 12)} ${padEnd('CCRMS Mean ($)', 16)} ${padEnd('Cent. Mean ($)', 16)}`);
  console.log('  ' + '-'.repeat(76));
  for (const b of sizeAnalysis) {
    console.log(`  ${padEnd(b.bucket, 22)} ${pad(b.count.toLocaleString(), 10)} ${pad((b.ccrmsWinRate * 100).toFixed(1) + '%', 10)} ${pad(fmt(b.ccrmsMeanRev), 14)} ${pad(fmt(b.centMeanRev), 14)}`);
  }

  console.log('='.repeat(78));
}

function toCsvRow(obj) {
  return Object.values(obj).map(v => typeof v === 'string' ? v : String(v)).join(',');
}

function writeCsv(filename, rows) {
  if (!rows.length) return;
  const header = Object.keys(rows[0]).join(',');
  const body = rows.map(toCsvRow).join('\n');
  const path = join(RESULTS_DIR, filename);
  writeFileSync(path, header + '\n' + body + '\n');
  console.log(`  Written: ${path}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const seed = parseInt(args.find((_, i, a) => a[i - 1] === '--seed') || '42', 10);
  const noSensitivity = args.includes('--no-sensitivity');
  const noCsv = args.includes('--no-csv');

  const rng = createRng(seed);
  const params = { ...DEFAULT_PARAMS };

  console.log('Running main simulation (with discovery, churn, tx costs)...');
  const results = simulateCreatorRevenue(params, rng);

  const summaries = Object.entries(results).map(
    ([name, net]) => summarisePlatform(name, net, params.nCreators, params.nIterations)
  );
  const savings = computeSavings(summaries);
  const breakEven = breakEvenAnalysis(results, params.nCreators, params.nIterations);
  const sizeAnalysis = creatorSizeAnalysis(results, params, rng);
  printSummary(summaries, savings, breakEven, sizeAnalysis);

  let sensitivity = [];
  if (!noSensitivity) {
    console.log('\nRunning sensitivity analysis...');
    sensitivity = sensitivityAnalysis();
    console.log(`  ${sensitivity.length} parameter combinations evaluated.`);
  }

  if (!noCsv) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeCsv('monte-carlo-summary.csv', summaries.map(s => ({
      platform: s.platform,
      mean_creator_revenue: s.meanCreatorRevenue,
      median_creator_revenue: s.medianCreatorRevenue,
      std_creator_revenue: s.stdCreatorRevenue,
      p5_creator_revenue: s.p5CreatorRevenue,
      p95_creator_revenue: s.p95CreatorRevenue,
      mean_total_revenue: s.meanTotalRevenue,
      ci_95_low: s.ci95Low,
      ci_95_high: s.ci95High,
    })));
    writeCsv('monte-carlo-savings.csv', savings.map(s => ({
      vs_platform: s.vsPlatform,
      absolute_saving_usd: s.absoluteSavingUsd,
      percentage_saving: s.percentageSaving,
    })));
    writeCsv('monte-carlo-size-analysis.csv', sizeAnalysis.map(b => ({
      bucket: b.bucket,
      scenario_count: b.count,
      ccrms_win_rate: b.ccrmsWinRate,
      ccrms_mean_revenue: b.ccrmsMeanRev,
      centralised_mean_revenue: b.centMeanRev,
    })));
    if (sensitivity.length) {
      writeCsv('monte-carlo-sensitivity.csv', sensitivity.map(s => ({
        parameter: s.parameter,
        value: s.value,
        ccrms_mean_revenue: s.ccrmsMeanRevenue,
        centralised_mean_revenue: s.centralisedMeanRevenue,
        saving_pct_vs_centralised: s.savingPctVsCentralised,
        ccrms_win_rate: s.ccrmsWinRate,
      })));
    }
  }

  console.log('\nDone.');
}

main();
