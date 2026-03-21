# Snowbridge Integration Session Log — 2026-03-21

## Starting State

After a machine reboot, the project had uncommitted Snowbridge work from a previous session:
- `runtime/src/configs/xcm_config.rs` modified with Ethereum origin converters, `GlobalConsensus` in `UniversalLocation`, and `HashedDescription` for Ethereum `AccountKey20` origins
- `zombienet-snowbridge.toml` created (4-chain topology: Relay, Bridge Hub 1013, AssetHub 1000, Content Rights 100)
- Several Snowbridge helper scripts in `scripts/` (configure-snowbridge, force-beacon-checkpoint, open-hrmp-snowbridge, verify-snowbridge-config, check-bh-pallets)
- All binaries pre-built from March 16-17 (polkadot, polkadot-parachain, workers, parachain-template-node)
- Setup plan documented in `docs/SNOWBRIDGE_SETUP.md` with 7 phases

Phases 1-3 (XCM config, binary builds, Zombienet config) were already complete.

---

## Work Performed

### 1. Launched 4-Chain Zombienet

Started `zombienet-snowbridge.toml` with native provider. All 4 chains came up:
- Relay chain (alice/bob) — port 51806
- Bridge Hub (para 1013) — port 8943
- AssetHub (para 1000) — port 9910
- Content Rights (para 100) — port 9990

Verified all chains producing blocks.

### 2. Opened HRMP Channels

Ran `scripts/open-hrmp-snowbridge.mjs` with the relay WS URL. Opened 4 bidirectional channels:
- Bridge Hub (1013) ↔ AssetHub (1000) — for Snowbridge message routing
- AssetHub (1000) ↔ Content Rights (100) — for forwarding bridged tokens

### 3. Configured Snowbridge on Substrate Side

Ran `scripts/configure-snowbridge.mjs`:
1. Set Gateway contract address (`0xb1185ede04202fe62d38f5db72f71e38ff3e8305`) on Bridge Hub via relay sudo XCM
2. Created Ether foreign asset on AssetHub (location: `GlobalConsensus(Ethereum{chain_id:11155111})`)
3. Attempted to set Ether reserve and mint via bridge-origin simulation — **failed silently** (the simulated bridge origin wasn't accepted by AssetHub for minting)

### 4. Fixed Ether Minting on AssetHub

The initial configure-snowbridge mint failed because `foreignAssets.mint` requires the issuer's signed origin, not root. Resolved in 3 steps:
1. Used `forceAssetStatus` via relay sudo XCM (Superuser origin → root on AssetHub) to change the Ether asset's issuer from the bridge sovereign account to Alice
2. Verified Alice was set as issuer
3. Alice called `foreignAssets.mint` directly on AssetHub (connecting to port 9910), minting 10 ETH each to Alice and Ferdie

**Result:** Alice and Ferdie each have 10,000,000,000,000,000,000 wei (10 ETH) of bridged Ether on AssetHub. Supply confirmed at 20 ETH.

### 5. Installed Ethereum Infrastructure

#### Geth (Execution Layer)
- Installed via Homebrew: `brew install ethereum` → Geth v1.17.1
- Note: `/usr/local/bin/geth` was discovered to be just a bash autocomplete script, not the actual binary. Homebrew installed the real binary at `/opt/homebrew/bin/geth`.

#### Lodestar (Consensus/Beacon Layer)
- `npm install -g @chainsafe/lodestar` failed (catalog: protocol unsupported)
- `pnpm add -g @chainsafe/lodestar` succeeded → installed v1.41.0 at `~/.local/share/pnpm/lodestar`
- Later discovered the pre-existing Lodestar v1.35.0 repo already cloned and built at `../lodestar/` (the exact version Snowbridge expects)

#### Snowbridge Relayer
- Built from source: `mage build` in `../snowbridge/relayer/`
- Required installing `mage` first: `go install github.com/magefile/mage@latest`
- Output: `../snowbridge/relayer/build/snowbridge-relay`

#### Other Prerequisites Verified
- Foundry/Forge: already installed (nightly)
- Go: v1.22.3
- coreutils (gdate): already installed

### 6. Created Setup Scripts

#### `scripts/start-ethereum.sh`
Starts local Ethereum execution + consensus layers:
- Initializes Geth with Snowbridge genesis config (chain ID 11155111, all forks at block 0)
- Starts Geth with HTTP/WS/Engine API
- Starts Lodestar beacon node connected to Geth
- Waits for both to be ready, saves PIDs
- Output dir: `/tmp/snowbridge-local/`

#### `scripts/deploy-gateway.sh`
Deploys Snowbridge Gateway contracts on local Ethereum:
- Generates BEEFY checkpoint from relay chain (queries `mmrLeaf.beefyAuthorities` for keyset commitment Merkle roots)
- Copies checkpoint to Snowbridge contracts dir
- Runs `forge script DeployLocal.sol` with all required env vars
- Extracts deployed contract addresses to `/tmp/snowbridge-local/contracts.json`

### 7. Started Ethereum Nodes

Started Geth + Lodestar successfully:
- Geth: initialized with Snowbridge genesis, running on ports 8545 (HTTP), 8546 (WS), 8551 (Engine API)
- Lodestar: multiple iterations to find working configuration (see Lodestar struggles below)

### 8. Deployed Gateway Contracts

Ran `scripts/deploy-gateway.sh` against relay chain and local Ethereum:

**BEEFY checkpoint generation required fixes:**
- First attempt used `beefyMmrLeaf` (pallet name from Snowbridge reference) — doesn't exist on our relay; actual name is `mmrLeaf`
- Second attempt queried block 1 — state already pruned on live chain
- Third attempt used current finalized block — succeeded

**Contract deployment:** Successfully deployed 16 contracts via Forge:
| Contract | Address |
|----------|---------|
| BeefyClient | 0x83428c7db9815f482a39a1715684dcf755021997 |
| Gateway (logic) | 0xee9170abfbf9421ad6dd07f6bdec9d89f2b581e0 |
| **GatewayProxy** | **0xb1185ede04202fe62d38f5db72f71e38ff3e8305** |
| WETH9 | 0xb8ea8cb425d85536b158d661da1ef0895bb92f1d |
| AgentExecutor | 0xf8f7758fbcefd546eaeff7de24aff666b6228e73 |
| Token | 0x54d6643762e46036b3448659791adaf554225541 |
| + 10 others | (libraries, mocks, helpers) |

The GatewayProxy address (`0xb1185…8305`) matches what was already configured on Bridge Hub — this is the canonical Snowbridge test address from the deployer key.

### 9. Lodestar Configuration Struggles

Getting the beacon chain to work with the correct preset was the most time-consuming part:

#### Problem: Bridge Hub requires mainnet sync committee size (512)
The `ethereumBeaconClient` pallet on Bridge Hub has `pubkeys: [PublicKey; 512]` hardcoded. This means the beacon checkpoint must come from a chain with 512 sync committee members (mainnet preset).

#### Attempts:
1. **Lodestar v1.41 (pnpm) + minimal preset**: Worked, finalized quickly, but sync committee size = 32 → incompatible with Bridge Hub
2. **Lodestar v1.41 + mainnet preset via `LODESTAR_PRESET=mainnet`**: v1.41's `lodestar dev` ignores the env var, always uses minimal
3. **Lodestar v1.41 + explicit `--params.SYNC_COMMITTEE_SIZE 512`**: Error — these params can't be overridden in dev mode
4. **Lodestar v1.35.0 (from source) + `LODESTAR_PRESET=mainnet`**: **Works!** v1.35.0 respects the env var. Confirmed: SYNC_COMMITTEE_SIZE=512, SLOTS_PER_EPOCH=32, SECONDS_PER_SLOT=12
5. **v1.35.0 mainnet + mock execution**: Failed — Engine mock doesn't produce valid execution payloads with mainnet preset
6. **v1.35.0 mainnet + real Geth**: **Works!** Produces blocks, publishes attestations and sync committee messages

#### Finalization issue with 8 validators on mainnet preset:
- Mainnet has 32 committees per epoch, but only 8 validators → ~0.25 validators per committee
- Only 1 attestation published every 4 slots (when a committee happens to have a validator)
- Justification achieved (epoch 2) after ~5 epochs, but chain stalled at slot 167 before finalization
- Epoch 2 was justified with `count=1` attestation per eligible slot

### 10. Generated Beacon Checkpoint

Despite the chain stalling before finalization, the beacon state service successfully cached states:
1. Started beacon state service (`snowbridge-relay run beacon-state-service`) — downloaded finalized (slot 96) and attested (slot 162) states
2. Ran `snowbridge-relay generate-beacon-checkpoint` — produced 50KB SCALE-encoded checkpoint hex
3. Saved to `/tmp/snowbridge-local/beacon-checkpoint.hex`

### 11. Attempted to Force Checkpoint on Bridge Hub

Submitted the checkpoint via relay sudo XCM → Bridge Hub `ethereumBeaconClient.forceCheckpoint`:
- XCM `Transact` with `Superuser` origin_kind
- Message processed with `success: true` in Bridge Hub's message queue
- Weight used: 101.6B refTime, 3,501 proofSize
- **But all beacon client storage remained at zero**

**Root cause identified:** The pallet's `process_checkpoint_update()` function:
1. Computes hash tree root of sync committee ✓
2. Computes `current_sync_committee_gindex_at_slot()` based on fork versions
3. Verifies Merkle proof of sync committee against beacon state root — **fails here**
4. The `#[transactional]` attribute rolls back all storage writes
5. XCM `Transact` reports success regardless of inner dispatch errors

The likely cause is a **generalized index (gindex) mismatch**: the Electra fork introduces new fields in the beacon state, shifting the position of `current_sync_committee` in the state Merkle tree. The relayer generates proofs with one gindex, but the pallet calculates a different one.

---

## Current State Summary

### What's Running
- Zombienet: 4 chains producing blocks (relay, Bridge Hub, AssetHub, Content Rights)
- Geth: running on localhost:8545
- Lodestar v1.35.0: stalled at slot 167 but state is cached

### What's Deployed
- Gateway contracts on Ethereum (16 contracts)
- HRMP channels open (BH↔AH, AH↔CR)
- Ether foreign asset on AssetHub (Alice + Ferdie have 10 ETH each)
- Gateway address configured on Bridge Hub

### What's Blocked
- Beacon checkpoint on Bridge Hub (gindex/Electra Merkle proof mismatch)
- Relayer startup (depends on checkpoint)
- E2E demo: Ethereum → Bridge Hub → AssetHub → Content Rights (depends on relayer)

### Files Created/Modified This Session
| File | Purpose |
|------|---------|
| `scripts/start-ethereum.sh` | Start Geth + Lodestar for local Ethereum |
| `scripts/deploy-gateway.sh` | Deploy Gateway contracts + generate BEEFY checkpoint |
| `/tmp/snowbridge-local/contracts.json` | Deployed contract addresses |
| `/tmp/snowbridge-local/beefy-state.json` | BEEFY validator checkpoint |
| `/tmp/snowbridge-local/beacon-checkpoint.hex` | 50KB beacon checkpoint (SCALE) |
| `/tmp/snowbridge-local/beacon-relay.json` | Relayer config for our topology |
| `/tmp/snowbridge-local/beacon-state-service.json` | State service config |
| `/tmp/snowbridge-local/*.log` | Geth, Lodestar, state service logs |

### Next Steps
1. **Debug gindex mismatch**: Compare `current_sync_committee_gindex_at_slot()` in the pallet source with the relayer's proof generation. Check if Electra fork epoch config affects the gindex.
2. **Alternative**: Try running Snowbridge's own `start-services.sh` from `web/packages/test/scripts/` which orchestrates everything together (replaces our Zombienet).
3. **Alternative**: Generate checkpoint at a pre-Electra slot if possible, or adjust fork version configuration.
