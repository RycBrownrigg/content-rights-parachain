# Content Rights Parachain

A Polkadot parachain implementing a cross-chain content rights management system supporting subscriptions, pay-per-view, and permanent ownership. Built as part of a master's thesis at the University of Malta.

## Overview

This parachain provides a unified rights token model where a single on-chain pallet manages three content monetization models, subscription access, pay-per-view consumption, and permanent ownership, with cross-chain interoperability via Polkadot's XCM messaging and Ethereum bridging via Snowbridge.

**Key features:**
- 17 extrinsics covering all content rights operations (local + cross-chain)
- Automatic royalty distribution to up to 10 collaborators with basis-point precision
- Scheduled auto-renewal via `on_initialize` hook
- Rich metadata query for cross-chain consumers
- Cross-chain operations via paid XCM execution (WithdrawAsset + BuyExecution + Transact)
- Ethereum interoperability via Snowbridge v1 (token bridging demonstrated E2E)
- Custom pallet-revive precompile for efficient contract-to-pallet calls
- Merkle storage proof verification for trustless cross-chain rights checking

## Architecture

```
content-rights-parachain/
├── pallets/
│   ├── content-rights/       # Core pallet: 17 extrinsics, 56 unit tests
│   │   ├── src/lib.rs        # Pallet logic, storage, events, errors
│   │   ├── src/types.rs      # RightsType, RoyaltySplit, RightsMetadata, etc.
│   │   ├── src/tests.rs      # 56 tests (functional, security, XCM, royalty, auto-renewal, metadata)
│   │   ├── src/mock.rs       # Mock runtime for testing
│   │   └── src/weights.rs    # Placeholder weight definitions
│   ├── rights-verifier/      # Cross-chain Merkle storage proof verification
│   └── template/             # Original Polkadot SDK template pallet (unused)
├── runtime/
│   └── src/
│       ├── lib.rs            # Runtime definition, pallet composition
│       ├── configs/
│       │   ├── mod.rs        # Pallet configurations (revive, nfts, balances, etc.)
│       │   └── xcm_config.rs # XCM executor, router, barriers, Snowbridge origins
│       └── precompiles.rs    # Custom pallet-revive precompile at 0x0000...0400
├── contracts/
│   └── rights_manager/       # ink! 6 contract (thin API layer over pallet)
├── node/                     # Collator binary (parachain-template-node)
├── scripts/
│   ├── perf/                 # 7 performance benchmark scripts + results
│   ├── start-ethereum.sh     # Start local Geth + Lodestar
│   ├── deploy-gateway.sh     # Deploy 16 Snowbridge Gateway contracts
│   ├── snowbridge-full-setup.sh  # Full automated Ethereum bridge setup
│   ├── open-hrmp-channels.mjs    # HRMP channel setup (2-chain)
│   ├── open-hrmp-snowbridge.mjs  # HRMP channel setup (4-chain)
│   ├── configure-snowbridge.mjs  # Substrate-side Snowbridge configuration
│   └── xcm-e2e-test.mjs     # XCM end-to-end test script
├── integration-tests/        # XCM simulator integration tests
├── docs/
│   ├── DEPLOY_AND_CALL.md    # How to deploy and call ink! contracts
│   ├── SNOWBRIDGE_SETUP.md   # Snowbridge setup plan (7 phases)
│   └── SNOWBRIDGE_SESSION_LOG.md  # Detailed bridge session log with lessons
├── zombienet-xcm-test.toml   # 2-chain topology (performance testing)
├── zombienet-snowbridge.toml # 4-chain topology (Ethereum bridge testing)
├── my-content-rights.toml    # Single-parachain topology (development)
└── zombienet.toml            # Default Zombienet config
```

## Pallet Extrinsics

| Index | Extrinsic | Description |
|-------|-----------|-------------|
| 0 | `register_content` | Register new content with metadata, pricing, and period length |
| 1 | `subscribe` | Subscribe to content (payment to creator with royalty distribution) |
| 2 | `renew_subscription` | Renew an expired subscription |
| 3 | `purchase_views` | Purchase a PPV view pack (additive if pack exists) |
| 4 | `consume_view` | Consume one prepaid view |
| 5 | `purchase_ownership` | Purchase permanent ownership |
| 6 | `check_access` | Check caller's access rights for content |
| 7–10 | `xcm_subscribe`, `xcm_renew_subscription`, `xcm_purchase_views`, `xcm_purchase_ownership` | Cross-chain variants via XCM Transact |
| 11 | `transfer_ownership` | Transfer ownership to another account |
| 12 | `xcm_transfer_ownership` | Cross-chain ownership transfer (caller must be owner) |
| 13 | `set_royalty_splits` | Configure royalty distribution (creator only, up to 10 collaborators) |
| 14 | `enable_auto_renew` | Enable automatic subscription renewal |
| 15 | `disable_auto_renew` | Disable automatic subscription renewal |
| 16 | `query_rights_metadata` | Emit RightsMetadata struct for cross-chain consumption |

## Build

```bash
# Build the parachain node (release, ~5-10 min incremental)
cargo build --release -p parachain-template-node

# Run unit tests (no WASM build needed)
SKIP_WASM_BUILD=1 cargo test -p pallet-content-rights
```

## Local Testnet

### 2-Chain Topology (Development & Performance Testing)

```bash
# Spawn relay (alice, bob) + ParaA (100) at ws://9990 + ParaB (200) at ws://9991
zombienet/javascript/packages/cli/dist/cli.js spawn zombienet-xcm-test.toml --provider native

# Open HRMP channels (required for XCM tests)
node scripts/open-hrmp-channels.mjs ws://127.0.0.1:<relay-port>
```

### 4-Chain Topology (Snowbridge / Ethereum Bridge Testing)

```bash
# Spawn relay + Bridge Hub (1013) + AssetHub (1000) + Content Rights (100)
zombienet/javascript/packages/cli/dist/cli.js spawn zombienet-snowbridge.toml --provider native

# Start local Ethereum (Geth + Lodestar)
./scripts/start-ethereum.sh

# Deploy Gateway contracts and start relayers
./scripts/snowbridge-full-setup.sh
```

### Single-Chain Topology (Simple Development)

```bash
zombienet/javascript/packages/cli/dist/cli.js spawn my-content-rights.toml --provider native
```

## Performance Benchmarks

Seven benchmark scripts in `scripts/perf/`:

| Script | Purpose | Key Result |
|--------|---------|------------|
| `local-throughput.mjs` | TPS and latency for all 11 local extrinsics | 16.6 TPS peak, ~6s latency |
| `block-utilization.mjs` | Block weight saturation | 300 txs at 12.9% weight |
| `storage-growth.mjs` | Per-item storage costs | 191 bytes/content, 112 bytes/sub |
| `xcm-latency.mjs` | Cross-chain operation latency | 3–5 blocks, 100% success |
| `stress-test.mjs` | Sustained load (200 accounts, 3 min) | 26.2 TPS sustained |
| `resource-monitor.mjs` | Collator resource utilization | 62ms block construction |
| `reliability-test.mjs` | Uptime and MTTR | 90% uptime, 15s MTTR |

Run all benchmarks (requires Zombienet with 2-chain topology):

```bash
node scripts/perf/local-throughput.mjs
node scripts/perf/block-utilization.mjs
node scripts/perf/storage-growth.mjs
node scripts/perf/xcm-latency.mjs ws://127.0.0.1:9990 ws://127.0.0.1:9991 ws://127.0.0.1:<relay-port>
node scripts/perf/stress-test.mjs
node scripts/perf/resource-monitor.mjs http://127.0.0.1:<prometheus-port>/metrics ws://127.0.0.1:9990
node scripts/perf/reliability-test.mjs
```

Results are saved to `scripts/perf/results/*.json`.

## Security

The pallet underwent a security audit during development:

- **0 Critical, 0 High, 0 unresolved Medium** findings
- 1 Medium finding (xcm_transfer_ownership auth gap) identified and fixed
- 1 Low finding (view pack overwrite) identified and fixed
- 3 Low findings acknowledged as design decisions
- `cargo clippy` zero warnings
- `cargo audit`: 8 advisories, all in polkadot-sdk transitive dependencies
- 56 unit tests covering functional, security, XCM, royalty, auto-renewal, and metadata paths

## Testing

```bash
# Unit tests (56 tests)
SKIP_WASM_BUILD=1 cargo test -p pallet-content-rights

# All workspace tests
SKIP_WASM_BUILD=1 cargo test --workspace

# XCM E2E test (requires running Zombienet with HRMP channels)
node scripts/xcm-e2e-test.mjs
```

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| FRAME pallet over pure ink! contracts | Direct storage access, native weight system, simpler XCM integration |
| `pallet-nfts` over RMRK 2.0 | RMRK pallets abandoned (frozen at polkadot-v0.9.36) |
| `on_initialize` over XCM `Schedule` | XCM v5 Schedule not production-ready; on-chain scheduler achieves same result |
| Event-based metadata over XCM payload embedding | XCM ~4KB payload limit too small for rich metadata |
| Paid XCM execution | WithdrawAsset + BuyExecution reflects realistic cross-chain fee model |

## Configuration

Key runtime constants in `runtime/src/configs/mod.rs`:

| Constant | Value | Effect |
|----------|-------|--------|
| `MaxChildrenPerNft` | 50 | Max subscribers/owners per content item (configurable) |
| Para ID | 100 | Local development parachain ID |
| Parachain RPC | ws://127.0.0.1:9990 | Fixed in Zombienet configs |

## Thesis Context

This implementation supports the research question: *"How can a shared-security, multi-chain framework built on Polkadot's XCM and ink! smart contracts deliver a unified rights token that natively supports recurring subscriptions, pay-per-view micro-transactions, and permanent ownership transfers across heterogeneous blockchain networks?"*

The system achieves 26.2 TPS sustained throughput with ~6s deterministic latency, 100% XCM success rate across chains, and 100% creator revenue retention via a self-publishing model. Block weight utilization at 300 transactions is only 12.9%, meaning scaling to higher TPS is achievable via shorter block times or Elastic Scaling (multiple cores per parachain), without any pallet-level changes.

## License

MIT-0
