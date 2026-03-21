# Snowbridge Local Bridge Simulation (Two-Step v1 Demo)

## Context

The thesis needs to demonstrate content rights management across **heterogeneous blockchain networks**. XCM parachain-to-parachain flows are already working. The remaining gap is **Ethereum → Polkadot** via Snowbridge.

**Approach:** Full Snowbridge v1 local setup with a two-step demo:
1. Ethereum user bridges tokens to their account on the content-rights parachain
2. User calls `ContentRights::subscribe()` locally using bridged funds

Snowbridge v2 (which enables single-step `Transact` from Ethereum) is documented as future work.

**Timeline:** 5+ weeks available. Estimated effort: ~8-13 days.

---

## Phase 1: XCM Config Changes for Ethereum Origins (1-2 days)

**File:** `runtime/src/configs/xcm_config.rs`

1. Set `RelayNetwork` to `Some(NetworkId::Rococo)` (currently `None`)
2. Update `UniversalLocation` to include `GlobalConsensus`:
   ```rust
   [GlobalConsensus(NetworkId::Rococo), Parachain(ParachainInfo::parachain_id().into())].into()
   ```
3. Add Ethereum location converter to `LocationToAccountId` — map Ethereum `AccountKey20` origins to local AccountId32 via hashing (`HashedDescription<AccountId, DescribeFamily<DescribeAllTerminal>>`)
4. Configure `AssetTransactor` to handle bridged Ethereum tokens (WETH) as fee asset or accept reserve transfers from AssetHub
5. Build + test runtime compiles

## Phase 2: Build Required Binaries (1-2 days, mostly compile time)

All built from the `polkadot-sdk/` directory in the repo:

1. **`polkadot`** + worker binaries (with `--features fast-runtime` for short epochs):
   ```bash
   cargo build --release -p polkadot --features fast-runtime
   cargo build --release -p polkadot-prepare-worker
   cargo build --release -p polkadot-execute-worker
   ```
2. **`polkadot-parachain`** (includes Bridge Hub + AssetHub runtimes):
   ```bash
   cargo build --release -p polkadot-parachain-bin
   ```
3. **`parachain-template-node`** — already built

Start all builds on Day 1 in background.

## Phase 3: Multi-Chain Zombienet Config (2-3 days)

**File to create:** `zombienet-snowbridge.toml`

**Network topology:**
```
Relay Chain (Rococo-local): alice, bob
├── Bridge Hub (para 1013): polkadot-parachain, chain=bridge-hub-rococo-local
├── AssetHub (para 1000): polkadot-parachain, chain=asset-hub-rococo-local
└── Content Rights (para 100): parachain-template-node, chain=local
```

**Based on:** `polkadot-sdk/bridges/testing/environments/rococo-westend/bridge_hub_rococo_local_network.toml`

**HRMP channels to open post-launch:**
- Bridge Hub (1013) ↔ AssetHub (1000) — Snowbridge message routing
- AssetHub (1000) ↔ Content Rights (100) — forwarding to destination

## Phase 4: Ethereum Side Setup (2-3 days)

**External repo:** Clone `github.com/Snowfork/snowbridge`

**Components:**
1. **Foundry** — install via `curl -L https://foundry.paradigm.xyz | bash && foundryup`
2. **Anvil** — local Ethereum execution layer (`localhost:8545`)
3. **Lodestar** (or Snowfork mock beacon) — local Ethereum consensus layer
4. **Gateway contract** — deploy via Foundry's `forge script`
   - Gateway address must match Bridge Hub config `EthereumGatewayAddress`

**Beacon client initialization:**
- Bridge Hub's `snowbridge-pallet-ethereum-client` needs a checkpoint from the local beacon chain
- Snowfork test scripts extract checkpoint → submit to Bridge Hub via sudo

## Phase 5: Relayer Setup (1-2 days)

**From Snowfork/snowbridge repo:**
1. Install Go 1.21+
2. Build relayer: `cd relayer && go build -o snowbridge-relay .`
3. Configure with Ethereum RPC, Bridge Hub RPC, beacon node endpoint, relayer keys
4. Start relayer — watches Gateway events → submits proofs to Bridge Hub

## Phase 6: End-to-End Demo (1-2 days)

**Demo flow:**
```
Step 1: Register content on para 100 (content_id=0, subscription price)
Step 2: From Ethereum (via cast): Gateway.sendToken(
          token, ForeignAccountId32{para_id:100, id:alice_bytes, fee:X}, amount)
Step 3: Relayer submits proof to Bridge Hub
Step 4: Bridge Hub → XCM → AssetHub → reserve transfer → para 100
Step 5: Alice's account on para 100 receives bridged tokens
Step 6: Alice calls ContentRights::subscribe(0) using bridged funds
Step 7: Verify subscription via storage query
```

**Create:** `scripts/snowbridge-e2e-test.mjs` — automated demo script

## Phase 7: Documentation (1 day)

- Update `Implementation Decisions & Design Rationale.md` — new Step 7: Snowbridge Bridge Integration
- Architecture diagram: Ethereum → Gateway → Relayer → Bridge Hub → AssetHub → Content Rights
- Document v1 limitations and v2 `Transact` as future work path
- Record XCM config changes and rationale

---

## Verification Checklist

1. All 4 chains start and produce blocks in Zombienet
2. HRMP channels open (Bridge Hub ↔ AssetHub, AssetHub ↔ para 100)
3. Ethereum beacon client initialized on Bridge Hub
4. Relayer running, connected to Ethereum + Bridge Hub
5. `Gateway.sendToken()` from Ethereum → tokens arrive on para 100
6. Alice calls `ContentRights::subscribe()` with bridged funds → subscription created
7. Subscription verifiable via `pallet-rights-verifier` storage proof

## Key Files

| File | Purpose |
|------|---------|
| `runtime/src/configs/xcm_config.rs` | Add Ethereum origin converters, update UniversalLocation |
| `zombienet-snowbridge.toml` | New 4-chain Zombienet config |
| `scripts/snowbridge-e2e-test.mjs` | Automated E2E demo script |
| `polkadot-sdk/bridges/snowbridge/primitives/inbound-queue/src/v1.rs` | Reference: v1 message format |
| `polkadot-sdk/cumulus/.../bridge-hub-rococo/src/bridge_to_ethereum_config.rs` | Reference: Snowbridge pallet config |
| `polkadot-sdk/bridges/snowbridge/docs/v2.md` | Reference: v2 architecture (future Transact support) |
