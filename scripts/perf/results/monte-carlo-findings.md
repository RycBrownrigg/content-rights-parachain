# Monte Carlo Creator Revenue Simulation — Findings (RO6 / ES-13)

## Overview

A Monte Carlo simulation involving 1,000 creators across 10,000 iterations (equating to 10 million scenarios) was performed to quantify potential creator revenue under four platform models: centralized (YouTube/Spotify), existing Web3 marketplaces (OpenSea-style), bridge-based cross-chain solutions, and the Cross-Chain Content Rights Management Service (CCRMS). Unlike a basic fee comparison, the simulation models four competing dynamics that inherently involve trade-offs platforms.

## Competing Dynamics Modelled

| Dynamic | Description | Effect |
|---|---|---|
| **Platform fees** | Fraction of gross revenue taken by the platform | Centralised: 30–45%; Web3: 7.5–15%; Bridge-based: 8–15%; CCRMS: 1–5% |
| **Discovery/network effects** | Additional audience gained via algorithmic recommendation | Centralised adds 500–3,000 viewers; CCRMS adds 0–200 (organic only) |
| **Subscriber churn** | Monthly subscriber attrition rate, compounded over 12 months | Centralised: 2–5% (sticky UX); CCRMS: 4–8% (self-custody friction) |
| **Transaction costs** | Marginal cost per on-chain transaction | Centralised: ~$0; CCRMS: ~$0.001; Bridge-based: ~$0.02 |

Discovery is modeled as an additive bonus rather than a multiplier, reflecting the reality that platform algorithms help creators be *found* by new audiences but do not scale an existing fanbase. This implies that smaller creators benefit proportionally more from discovery than larger ones.

## Stochastic Parameters

Five per-creator parameters are drawn independently per (iteration, creator) pair:

| Parameter | Distribution | Values |
|---|---|---|
| Base audience size | Log-normal (μ = 1,000, σ = 2) | Realistic long-tail creator distribution |
| Content price | Uniform ($1–$50) | Per-unit pricing |
| Subscription adoption rate | Beta (α = 2, β = 5) | Mean ≈ 28.6% |
| Pay-per-view conversion rate | Beta (α = 1, β = 10) | Mean ≈ 9.1% (low baseline) |
| Secondary sale probability | Exponential (λ = 0.1), capped at 1.0 | Resale market dynamics |

Revenue is computed across three streams weighted as: subscriptions (50%), pay-per-view (30%), and secondary sales (20%).

## Key Findings

### 1. CCRMS Outperforms on Average, but Not Universally

| Platform | Mean Revenue/Creator | vs CCRMS |
|---|---|---|
| Centralised | $45,417 | CCRMS earns +16.8% more |
| Web3 | $48,711 | CCRMS earns +8.9% more |
| Bridge-based | $45,369 | CCRMS earns +16.9% more |
| **CCRMS** | **$53,053** | — |

On average, CCRMS yields the highest net creator revenue. However, the break-even analysis indicates that this benefit is not consistent across all creators profiles.

### 2. Creator Size Determines Platform Advantage

The most significant finding is a clear crossover point based on organic audience size:

| Creator Audience Size | CCRMS Win Rate vs Centralised | Interpretation |
|---|---|---|
| Tiny (<100 followers) | **0.0%** | Centralised discovery dominates; small creators need algorithmic reach |
| Small (100–500) | **0.0%** | Fee savings insufficient to offset discovery advantage |
| Medium (500–2,000) | **6.6%** | Crossover zone begins; CCRMS wins in rare high-conversion scenarios |
| Large (2,000–10,000) | **57.6%** | Inflection point — CCRMS begins to outperform as discovery bonus becomes marginal relative to organic audience |
| Huge (10,000–100,000) | **99.0%** | CCRMS strongly dominant; 30–45% fee savings far outweigh discovery |
| Mega (100,000+) | **99.9%** | Near-certain CCRMS advantage |

* The crossover point occurs at approximately 2,000 organic followers. Below this threshold, the audience acquired through centralized platform discovery (ranging from 500 to 3,000 additional viewers) constitutes a substantial proportion relative to the creator's organic base, thereby rendering the 30–45% fee a justifiable expense. Beyond this threshold, the discovery bonus diminishes in relative significance, and the differential in fees subsequently becomes the primary factor influencing the overall evaluation outcome.

### 3. Break-Even Across All Scenarios

| Comparison | CCRMS Win Rate |
|---|---|
| CCRMS vs Centralised | 28.0% |
| CCRMS vs Web3 | 38.6% |
| CCRMS vs Bridge-based | 66.5% |

CCRMS wins only 28% of individual (iteration, creator) scenarios against centralized platforms because most creators in the log-normal distribution fall below the 2,000-follower crossover. This accurately reflects the creator economy, where most creators have small audiences.

### 4. Confidence Intervals (95%)

| Platform | 95% CI — Total Revenue (all 1,000 creators) |
|---|---|
| Centralised | $30.9M – $69.1M |
| Web3 | $33.7M – $76.2M |
| Bridge-based | $31.4M – $71.7M |
| CCRMS | $36.7M – $84.1M |

CCRMS exhibits the broadest confidence interval, indicating greater variability in outcomes — in accordance with the elimination of platform-mediated smoothing effects.

## Sensitivity Analysis

Seven parameters were varied independently across 32 configurations to identify which factors most influence the CCRMS advantage:

| Parameter Varied | Range Tested | CCRMS Saving vs Centralised | CCRMS Win Rate | Sensitivity |
|---|---|---|---|---|
| Audience mean (μ) | 500 – 5,000 | -0.2% to +36.3% | 18.3% – 57.2% | **High** — larger audiences strongly favour CCRMS |
| Audience variance (σ) | 1.0 – 3.0 | -26.3% to +39.1% | 15.6% – 34.5% | **Very high** — low variance (uniform small creators) reverses the advantage |
| Subscription length | 1 – 24 months | +14.4% to +26.0% | 26.5% – 32.3% | **Moderate** — shorter subscriptions favour CCRMS (less churn impact) |
| Subscription rate (α) | 1.0 – 5.0 | +12.3% to +20.2% | 25.3% – 29.9% | **Moderate** — higher subscription adoption slightly favours centralised |
| PPV conversion (α) | 0.5 – 3.0 | +16.8% to +18.2% | 28.1% – 29.0% | **Low** — PPV rate has minimal impact on relative advantage |
| Price range | $0.50–$200 | +17.0% (stable) | 28.1% (stable) | **Negligible** — price level scales both platforms equally |
| Resale probability (λ) | 0.05 – 0.5 | +15.8% to +17.1% | 27.0% – 28.3% | **Low** — secondary market dynamics have minimal differential impact |

**Key sensitivity findings:**

- **Audience variance (σ)** is the single most influential parameter. When σ = 1.0 (most creators have similar, moderate-sized audiences), CCRMS *loses* by 26% because discovery bonuses are large relative to uniform base audiences. When σ = 3.0 (highly skewed distribution with some very large creators), CCRMS gains +39%.
- **Audience mean (μ)** directly controls the crossover: at μ = 500, CCRMS breaks even; at μ = 5,000, CCRMS wins 57% of scenarios.
- **Subscription length** matters because churn compounds monthly — CCRMS's higher churn rate (4–8% vs 2–5%) hurts more over 24 months than over 1 month.
- **Price and resale parameters** have negligible impact on the *relative* advantage because they scale gross revenue equally across platforms.

## Implications for the Thesis

1. **CCRMS is not a universal replacement for centralized platforms.** It is highly beneficial for creators with established audiences (≥2,000 followers) who are not reliant on algorithmic discovery to reach their market.

2. **A natural migration path exists.** Creators may prudently initiate their endeavors on centralized platforms to cultivate an audience via algorithmic discovery. Subsequently, upon surpassing the crossover threshold of their organic following, they may transition to CCRMS. This "graduation model" amalgamates the discovery advantages inherent to centralized platforms with the cost efficiency characteristic of decentralized systems infrastructure.

3. **The self-publishing model achieves near-100% creator retention** for creators above the crossover point, consistent with the direct measurement of 100% retention in the CCRMS architecture (no intermediary commissions).

4. **The creator economy's long-tail distribution is the key variable.** Policy decisions regarding creator onboarding, discovery partnerships, or hybrid models should be guided by the audience distribution of the target creator population.

## Reproducibility

```bash
# Run the full simulation (requires Node.js 18+)
node scripts/perf/monte-carlo-revenue.mjs

# Custom seed for verification
node scripts/perf/monte-carlo-revenue.mjs --seed 123

# Skip sensitivity analysis for faster execution
node scripts/perf/monte-carlo-revenue.mjs --no-sensitivity
```

Simulation uses a deterministic xoshiro128** PRNG seeded at 42 (default). All distribution samplers (log-normal, beta, gamma, exponential) are implemented from first principles with no external dependencies.

## Raw Data

CSV outputs in `scripts/perf/results/`:
- `monte-carlo-summary.csv` — per-platform summary statistics with 95% confidence intervals
- `monte-carlo-savings.csv` — CCRMS savings relative to each platform
- `monte-carlo-size-analysis.csv` — win rates and mean revenues by creator audience bucket
- `monte-carlo-sensitivity.csv` — 32 parameter variation results with win rates
