# Monte Carlo Creator Revenue Simulation: Findings

This document describes the method and current results of `monte-carlo-revenue.mjs` and `monte-carlo-appendix-g.mjs`. It matches Section 7.2 and Appendix G of the dissertation.

## Correction (commit 52454ea)

Earlier versions set the secondary-sale rate to `resaleLambda: 0.1`. The sampler draws `-ln(u) / lambda`, so that value gives a mean of 10; about 90% of draws hit the cap of 1.0, and the model assumed that roughly 95% of each creator's audience made a secondary purchase every year. The rate is now `lambda = 10` (mean about 0.1). The correction reduced the mean CCRMS advantage over the centralized configuration from 16.8% to 4.4%. All figures below use the corrected value. Results produced before 52454ea, including earlier versions of this file, should not be used.

## Method

The simulation draws 1,000 creators in each of 10,000 iterations (seed 42, xoshiro128**). Creator attributes are redrawn in every iteration, so each platform is evaluated on the same ten million independent creator-scenarios. For each scenario:

- effective audience = base audience + platform discovery bonus (additive)
- gross revenue = audience x price x (0.5 x subscription rate x retention + 0.3 x PPV rate + 0.2 x secondary-sale rate)
- retention = (1 - monthly churn) ^ 12, applied to subscriptions only
- net revenue = gross x (1 - platform fee) - transactions x cost per transaction

A scenario is a CCRMS "win" when CCRMS net revenue exceeds the comparator's for the same creator draw.

### Creator parameters (per creator, per iteration)

| Parameter | Distribution |
|---|---|
| Base audience | Log-normal, median 1,000, sigma 2 |
| Content price | Uniform $1-$50 |
| Subscription adoption | Beta(2, 5), mean about 28.6% |
| PPV conversion | Beta(1, 10), mean about 9.1% |
| Secondary-sale probability | Exponential, rate 10 (mean about 0.1), capped at 1.0 |
| Stream weights | Subscription 50%, PPV 30%, secondary 20% |

### Platform parameters (drawn uniformly once per iteration)

| Platform | Fee | Discovery added | Monthly churn | Cost/tx |
|---|---|---|---|---|
| Centralized | 30-45% | +500-3,000* | 2-5%* | $0.000* |
| Web3 marketplace | 0-2.5% | +100-800* | 5-10%* | $0.005* |
| Bridge-based (illustrative) | 8-15%* | +50-400* | 6-12%* | $0.020* |
| CCRMS | 1-5%* | +0-200* | 4-8%* | $0.001* |

\* Modeling assumption with no published source. Centralized fees follow platform documentation; Web3 fees follow Binance Research (2023) and The Block (2024). The CCRMS fee is an allowance for protocol or treasury fees, not a measured cost.

## Results (headline run, 1,000 x 10,000)

| Platform | Mean revenue per creator | Median scenario revenue | Central 95% range of total revenue |
|---|---|---|---|
| Centralized | $20,546 | $5,903 | $13.5M-$31.9M |
| Web3 marketplace | $20,545 | $3,268 | $13.4M-$33.2M |
| Bridge-based (illustrative) | $16,183 | $2,058 | $10.4M-$26.8M |
| CCRMS | $21,443 | $2,377 | $14.0M-$34.5M |

The 95% ranges are the 2.5th-97.5th percentiles of simulated total revenue across iterations. They describe spread in the simulation, not confidence intervals for a real-world quantity.

| Comparison | CCRMS mean advantage | CCRMS win rate |
|---|---|---|
| vs centralized | +4.4% | 20.6% |
| vs Web3 marketplace | +4.4% | 28.6% |
| vs bridge-based (illustrative) | +32.5% | 74.3% |

The mean advantage comes from large creators. The median creator earns less under CCRMS, because the median simulated audience (about 1,000 followers) lies below the crossover.

### Win rate against centralized, by base audience

| Audience | Scenarios | Win rate |
|---|---|---|
| < 100 | 1,247,899 | 0.0% |
| 100-500 | 2,396,089 | 0.0% |
| 500-2,000 | 2,710,464 | 3.5% |
| 2,000-10,000 | 2,397,739 | 37.5% |
| 10,000-100,000 | 1,141,040 | 84.5% |
| 100,000+ | 106,769 | 93.0% |

The 50% win-rate crossover and the mean-revenue crossover both fall near 6,000 followers (fine-grained buckets in `monte-carlo-appendix-g.json`).

## Prototype as built (`--no-secondary`)

The model credits every platform with a secondary-sale stream. The prototype's `transfer_ownership` pays creators no resale royalty, and centralized streaming platforms have no resale market. Without that stream:

| Comparison | CCRMS mean advantage | CCRMS win rate |
|---|---|---|
| vs centralized | +0.6% | 18.1% |
| vs Web3 marketplace | +6.9% | 32.2% |

The win-rate crossover rises to about 7,000 followers.

## Sensitivity (200 x 2,000 grid, seed 42)

- **Price:** no effect, by construction; price multiplies every platform's revenue equally.
- **CCRMS fee:** the advantage disappears at a fixed fee of about 7%.
- **Centralized discovery:** the advantage reverses at about 1.25 times the assumed bonus. With no discovery bonus on either platform, CCRMS wins in 97.1% of scenarios, so the audience-size crossover is produced by the discovery assumption.
- **Audience distribution:** a median of 500 followers gives -10.8%; 5,000 gives +21.9%.
- **Subscription period:** 24 months gives -5.7%, because the higher assumed CCRMS churn compounds for longer.
- **Web3 comparison:** across varied Web3 parameters, CCRMS ranges from -6.0% to +33.9%; the sign depends mainly on the unsourced churn difference. With identical non-fee dynamics, the fee difference alone leaves CCRMS 1.8% behind.

Full tables are in `monte-carlo-sensitivity.csv` and `monte-carlo-appendix-g.json`.

## What the simulation does not show

- It is a design-level model, not a measurement of the prototype. The prototype's fifty-holder bound per content item prevents it from serving the audience sizes where CCRMS wins.
- The discovery, churn and per-transaction parameters have no published source, and the result is sensitive to discovery and fee assumptions.
- Creator behavior (switching costs, risk aversion, network effects) and consumer onboarding friction are not modeled.

## Reproduction

From `scripts/perf/`:

```
node monte-carlo-revenue.mjs                                # headline results and sensitivity grid
node monte-carlo-revenue.mjs --no-secondary --no-sensitivity   # prototype as built
node monte-carlo-appendix-g.mjs                             # fee, discovery, crossover and Web3 sweeps
node monte-carlo-appendix-g.mjs --no-secondary              # the same sweeps without the secondary stream
```
