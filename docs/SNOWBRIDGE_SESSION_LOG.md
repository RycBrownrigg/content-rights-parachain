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

The cause was a **generalized index (gindex) mismatch**: the Electra fork introduces new fields in the beacon state, shifting the position of `current_sync_committee` in the state Merkle tree (Altair gindex = 54, Electra gindex = 86). The relayer was generating proofs with the wrong gindex because of a config format error (see step 12).

### 12. Diagnosed and Fixed the Gindex Mismatch

**Root cause:** The beacon-relay.json `forkVersions` field was set to 4-byte hex version IDs (`"electra": "0x05000000"`) but the relayer interprets these as **fork epoch numbers**. The relayer's `ForkVersion(slot)` method compares `epoch >= forkVersions.Electra` — with `0x05000000` parsed as integer 83,886,080, the relayer always thought it was in Deneb (gindex 54), while Bridge Hub (with `electra.epoch = 0`) expected Electra (gindex 86).

**The fix:** Changed relay config from hex version bytes to epoch numbers:
```json
// BEFORE (wrong — these are version bytes, not epochs):
"forkVersions": { "deneb": "0x04000000", "electra": "0x05000000", "fulu": "0x06000000" }

// AFTER (correct — these are fork activation epochs):
"forkVersions": { "deneb": 0, "electra": 0, "fulu": 5000000 }
```

**Verification:** Both the relayer and pallet now agree:
- Pallet: `current_sync_committee_gindex_at_slot()` returns `config::electra::CURRENT_SYNC_COMMITTEE_INDEX = 86`
- Relayer: `CurrentSyncCommitteeGeneralizedIndex()` returns `ElectraCurrentSyncCommitteeGeneralizedIndex = 86`

### 13. Successfully Forced Beacon Checkpoint on Bridge Hub

After fixing the config, regenerated the checkpoint and submitted via relay sudo XCM:

```
latestFinalizedBlockRoot: 0xb2a55448bb9be2987d52b73fbf53bd02240c8973f0af9da2c3564b190e971492
initialCheckpointRoot:    0xb2a55448bb9be2987d52b73fbf53bd02240c8973f0af9da2c3564b190e971492
validatorsRoot:           0x270d43e74ce340de4bca2b1936beca0f4f5408d9e78aec4850920baf659d5b69
```

The Ethereum beacon light client on Bridge Hub is now initialized. This means Bridge Hub can verify Ethereum beacon chain state, which is the foundation for trustless Ethereum → Polkadot message passing.

### 14. Relayer Initial Sync Failure (Stale Proof Cache)

After the checkpoint was set, the beacon relay failed to start with "newer finalized header available, abandoning current request". The relay needs to sync the initial sync committee for period 0, which requires proofs at historical beacon slots (64, 128). But the state service only caches proofs for the latest finalized slot — historical slots return "proof not ready".

**Root cause:** The state service was started after the chain had already advanced past those slots. It only downloads and caches the latest finalized/attested pair, not historical states. The relay's defensive check then abandons old-slot requests when it detects a newer finalized slot exists.

**Attempted fixes:**
- Imported historical states via `snowbridge-relay import-beacon-state` — states saved to disk but state service doesn't generate proofs from imports
- Restarted state service — it re-downloads the latest, ignores older imported states

**Solution:** The relay must be started immediately after the checkpoint is set, before the chain advances, so the state service has proofs for the slots the relay needs. This requires tight sequencing of: beacon finalization → state service start → checkpoint generation → checkpoint submission → relay start.

### 15. Created `scripts/snowbridge-full-setup.sh`

Automated the entire Ethereum-side setup into a single script that handles the timing-critical sequencing:

1. Kills any old processes, reinitializes Geth
2. Starts Geth + Lodestar v1.35.0 (mainnet preset)
3. Deploys Gateway contracts via Forge
4. Waits for beacon finalization (~39 minutes with 8 validators on mainnet preset)
5. Immediately starts beacon state service (caches proofs at current finalized slot)
6. Generates beacon checkpoint from the freshly-cached state
7. Forces checkpoint on Bridge Hub via relay sudo XCM
8. Funds relayer accounts on Bridge Hub (`//BeaconRelay`, `//ExecutionRelayAssetHub`)
9. Starts beacon relay and ethereum relay

**Usage:** `./scripts/snowbridge-full-setup.sh <relay-ws-url>`

The script runs end-to-end unattended. The tight sequencing between steps 4-9 ensures the relay starts while the state service still has proofs for the slots the relay needs.

### 16. Full System Running

The complete setup ran successfully:

**Beacon relay:** Submitted `EthereumBeaconClient.submit` extrinsic to Bridge Hub. Synced sync committee for period 0. Now tracking finalized headers.

```
extrinsic finalized: EthereumBeaconClient.submit
syncing sync committee for period 0
starting to sync finalized headers
```

**Ethereum relay:** Connected to both Ethereum (ws://127.0.0.1:8546) and Bridge Hub (ws://127.0.0.1:8943). Polling Gateway contract nonces — ready to relay inbound messages.

```
Polled Nonces: ethNonce=0, paraNonce=0
```

**Bridge Hub state:**
- `latestFinalizedBlockRoot`: set (non-zero)
- `currentSyncCommittee`: set with 512 pubkeys
- `latestSyncCommitteeUpdatePeriod`: 0
- `validatorsRoot`: set

### 17. E2E Demo: Ethereum → AssetHub Token Bridge (COMPLETE)

After the relay infrastructure was running, three additional issues were resolved to complete the E2E flow:

#### Issue 1: Chain reorg lost the sendToken transaction
When Lodestar was restarted with a fresh genesis, the new beacon chain created a fork that replaced the old blocks. The sendToken transaction (originally in block 12) was lost. **Fix:** Resend the transaction on the current chain.

#### Issue 2: `Token::FundsUnavailable` on Bridge Hub
The `EthereumInboundQueue.submit` extrinsic failed with `Token::FundsUnavailable`. The relayer account had sufficient balance for transaction fees, but the inbound queue pallet needs the **Snowbridge sovereign account** and **checking account** to be funded on Bridge Hub — they pay for XCM execution that routes tokens to AssetHub.

**Fix:** Fund via relay sudo XCM:
- Snowbridge sovereign (`0xce796ae65569a670...`) — 10^20 on Bridge Hub and AssetHub
- Checking account (`0x6d6f646c70792f78636d6368...`) — 10^20 on Bridge Hub
- AssetHub sovereign on Bridge Hub (`0x7369626ce8030000...`) — 10^20

#### Issue 3: Relay abandoned old-slot proof requests
The beacon relay's `retryWithBackoff` function abandoned proof requests when it detected a newer finalized slot. This prevented initial sync committee synchronisation.

**Fix:** Patched `snowbridge/relayer/relays/beacon/header/syncer/syncer.go` to disable the "newer finalized header" abandonment check. The relay now retries instead of giving up.

#### Successful E2E Result

Two `Gateway.sendToken()` transactions were sent (1 ETH each to Alice on AssetHub):

```
Transaction 1: block 5157, nonce 1 — relayed and executed successfully
Transaction 2: block 5300, nonce 2 — relayed and executed successfully
```

**Relay log confirmation:**
```
inbound message executed successfully  msgNonce=2  ethNonce=2
Polled Nonces: ethNonce=2, paraNonce=2
```

**AssetHub verification:**
```
Alice Ether balance: 22,000,000,000,000,000,000 (22 ETH)
  = 20 ETH (manually minted) + 2 ETH (bridged from Ethereum)
Total Ether supply: 42,000,000,000,000,000,000 (42 ETH)
  = 40 ETH (manual) + 2 ETH (bridged)
```

**Complete message path verified:**
```
Ethereum (Gateway.sendToken 1 ETH)
  → Geth execution layer (block 5157/5300)
  → Lodestar beacon chain (finalized at epoch 162+)
  → Ethereum relay generates inclusion proof
    (receipt proof + execution proof + ancestry proof)
  → Bridge Hub: EthereumBeaconClient.submit (beacon header update)
  → Bridge Hub: EthereumInboundQueue.submit (message + proof verified)
  → XCM to AssetHub
  → AssetHub: foreignAssets.mint (Ether credited to Alice) ✅
```

---

## Final State Summary

### Complete Working System
- **Zombienet:** 4 chains (Relay, Bridge Hub 1013, AssetHub 1000, Content Rights 100)
- **Geth v1.17.1:** Local Ethereum execution layer
- **Lodestar v1.35.0:** Mainnet preset beacon chain (512 sync committee)
- **Beacon state service:** Proof caching for relay
- **Beacon relay:** Syncing Ethereum finality to Bridge Hub
- **Ethereum relay:** Relaying Gateway events to Bridge Hub
- **Gateway contracts:** 16 contracts deployed (GatewayProxy: `0xb1185...8305`)
- **HRMP channels:** Bridge Hub ↔ AssetHub, AssetHub ↔ Content Rights
- **Beacon light client:** Initialized on Bridge Hub with checkpoint
- **E2E bridge:** 2 ETH successfully bridged from Ethereum to AssetHub via Snowbridge

### Files Created/Modified
| File | Purpose |
|------|---------|
| `scripts/start-ethereum.sh` | Start Geth + Lodestar for local Ethereum |
| `scripts/deploy-gateway.sh` | Deploy Gateway contracts + generate BEEFY checkpoint |
| `scripts/snowbridge-full-setup.sh` | Full automated setup (Geth, Lodestar, contracts, checkpoint, relayers) |
| `docs/SNOWBRIDGE_SESSION_LOG.md` | This document |

### Key Lessons Learned

1. **Lodestar dev mode always uses minimal preset** in v1.41.0 — must use v1.35.0 (from source at `../lodestar/`) with `LODESTAR_PRESET=mainnet` env var to get 512 sync committee size
2. **Bridge Hub's beacon client is compiled for mainnet** — `pubkeys: [PublicKey; 512]` is hardcoded, minimal preset (32) will never work
3. **Lodestar mainnet with 8 validators** takes ~39 minutes to reach finalization due to sparse committee assignments (8 validators across 32 committees)
4. **Relayer `forkVersions` config expects epoch numbers**, not 4-byte version hex — this mismatch causes the relayer to generate Merkle proofs at the wrong tree position (gindex 54 vs 86)
5. **XCM `Transact` with `#[transactional]` pallets** — inner dispatch errors are silently rolled back; `messageQueue.Processed` reports `success: true` even when the call fails
6. **`foreignAssets.mint` on AssetHub** requires the issuer's signed origin, not root — must first `forceAssetStatus` to set Alice as issuer, then Alice signs the mint directly
7. **Start the beacon state service EARLY** (immediately after Lodestar, before finalization) — it caches proofs for each finalized epoch as they happen. Starting late means historical proofs are missing
8. **`mmrLeaf` not `beefyMmrLeaf`** — the BEEFY MMR leaf pallet on Rococo-local is named `mmrLeaf`, not `beefyMmrLeaf` as in some Snowbridge reference code
9. **Fund Snowbridge sovereign accounts** — the inbound queue needs the Snowbridge sovereign (`0xce796a...`) and checking account (`0x6d6f646c...`) funded on both Bridge Hub and AssetHub for XCM execution
10. **Patch relay `retryWithBackoff`** — disable the "newer finalized header" abandonment in `syncer.go` for local dev networks where the state service may not have all historical proofs cached
