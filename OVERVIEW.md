# Content Rights Parachain — What’s Been Built So Far

This repo is a **Polkadot SDK parachain template** customized for a “content rights” use case. It runs as a **Rococo-local parachain** (para id **100**) with a relay (alice/bob) and one collator, and is set up so the development and testing **smart contracts** and other runtime logic can be do locally.

---

## 1. High-Level Stack

| Layer           | What it is                                                                     |
| --------------- | ------------------------------------------------------------------------------ |
| **Relay chain** | Rococo-local (2 validators: alice, bob) — from `polkadot-sdk`                  |
| **Parachain**   | This template runtime + node; para id **100**; name “content-rights-parachain” |
| **Collator**    | Single collator `collator01` running `parachain-template-node`                 |
| **Network**     | Spawned via **Zombienet** (native provider) using `my-content-rights.toml`     |

After `./zombienet-spawn.sh my-content-rights.toml --provider native`, you connect to the **parachain** at **`ws://127.0.0.1:9990`** in Polkadot.js Apps (Developer → Chain state, Revive, etc.).

---

## 2. Runtime (Parachain Logic)

**Location:** `runtime/`

The runtime is a **FRAME** runtime (Polkadot SDK) with:

- **Polkadot SDK** dependency (git) with **`pallet-revive`** and **`runtime-full`** so that ink! 6 (PolkaVM) and supporting pallets are available.

### Pallets Included

| Index  | Pallet                                                | Role                                                 |
| ------ | ----------------------------------------------------- | ---------------------------------------------------- |
| 0      | System                                                | Core block/execution                                 |
| 1      | ParachainSystem                                       | Parachain–relay integration                          |
| 2      | Timestamp                                             | Block time                                           |
| 3      | ParachainInfo                                         | Para id in storage                                   |
| 4      | WeightReclaim                                         | Cumulus weight reclaim                               |
| 5      | **RandomnessCollectiveFlip**                          | Entropy                                              |
| 10     | Balances                                              | Native token (UNIT)                                  |
| 11     | TransactionPayment                                    | Fee payment                                          |
| 15     | Sudo                                                  | Root-style admin                                     |
| 20–24  | Authorship, CollatorSelection, Session, Aura, AuraExt | Collator/consensus (Aura)                            |
| 30–33  | XcmpQueue, PolkadotXcm, CumulusXcm, MessageQueue      | XCM and messaging                                    |
| 40     | Contracts                                             | Wasm smart contracts (pallet-contracts; legacy)      |
| **41** | **Revive**                                            | **ink! 6 / PolkaVM smart contracts (pallet-revive)** |
| 50     | TemplatePallet                                        | Example template pallet                              |

- **Migrations:** `pallet_contracts::Migration<Runtime>` is registered for pallet-contracts storage migrations on upgrade.
- **Genesis presets:** `local_testnet` and `dev` presets are implemented in **no_std** (WASM) as well as std, so Zombienet’s `build-spec --chain local` works when calling into the runtime WASM.
- **Config:** Pallet-revive (FeeInfo, deposits, memory, etc.) and other pallet configs are in `runtime/src/configs/mod.rs`; XCM config is in `runtime/src/configs/xcm_config.rs`.

So far, **no custom “content rights” pallet** has been added; the focus has been on having a working parachain with **pallet-revive** for ink! 6 and tooling.

---

## 3. Node (Collator Binary)

**Location:** `node/`

- **Binary:** `parachain-template-node` (Parachain Collator Template).
- **Chain specs:** Supports `dev`, `template-rococo`, and `local` (plus loading from JSON path). `local` uses the `local_testnet` genesis preset.
- **Relay:** Configured for **rococo-local**; runs both the parachain and the relay client (standard Cumulus collator setup).
- **CLI:** Parachain args before `--`, relay args after `--` (see `node/src/command.rs`).

Built with:

```bash
cargo build --release -p parachain-template-node
```

---

## 4. Pallets (Custom / Template)

**Location:** `pallets/`

- **`pallets/template`**  
  The default SDK “template” pallet: minimal storage, events, errors, and dispatchables (e.g. `do_something`, `cause_error`). Used as a starting point; **not** yet replaced by a custom “content rights” pallet.

No other custom pallets exist yet.

---

## 5. Zombienet and Local Network

**Spawn script:** `zombienet-spawn.sh`

- Expects **zombienet** and **polkadot-sdk** inside the repo.
- Takes a TOML config (e.g. `my-content-rights.toml`), rewrites paths to **absolute** (polkadot, parachain binary), and runs Zombienet’s JS CLI with `--provider native`.
- Normalizes `rpc_port = 9990` in the temp config so the parachain RPC is on a fixed port.

**Config:** `my-content-rights.toml`

- **Relay:** rococo-local, alice + bob, polkadot from `polkadot-sdk/target/release/polkadot`.
- **Parachain:** id **100**, name “content-rights-parachain”, **chain = "local"** (for build-spec), **command** at parachain and collator level so the **parachain-template-node** binary is used (not the default `polkadot-parachain`).
- **Collator:** `collator01`, **rpc_port = 9990** (parachain RPC).

**Zombienet patches (in-repo):**

- **configGenerator.ts:** Native provider accepts both `rpc_port` and `rpcPort` so TOML port is respected.
- **paras.ts:** `setupChainSpec` gets `parachain.chain ?? chainName` so a valid chain name (e.g. `"local"`) is passed and “undefined-plain.json” / preset errors are avoided.

After “Network launched”, the parachain is reachable at **`ws://127.0.0.1:9990`**.

---

## 6. Scripts (Repo Root)

| Script                                        | Purpose                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **`scripts/check-parachain-port.sh`**         | Shows which process (if any) is listening on the parachain RPC port (default 9990).                                               |
| **`scripts/clean-runtime-wasm.sh`**           | Removes runtime WASM and related build artifacts so the next build is a full recompile (e.g. after changing pallets).             |
| **`scripts/verify-runtime-has-contracts.sh`** | Checks that the built `parachain-template-node` runtime includes the contracts pallet (e.g. via wbuild Cargo.lock or build-spec). |
| **`scripts/contracts-checklist.sh`**          | Runs the verify script and, if needed, prints clean-rebuild and respawn steps so the contract pallet appears in Chain state.      |
| **`scripts/respawn-with-new-runtime.sh`**     | Stops existing Zombienet/parachain processes and spawns a fresh network with the current binary (no `--dir`).                     |

Used for: confirming the correct binary, debugging “no contracts” or wrong port, and doing a clean respawn after runtime changes.

---

## 7. CI / Automation

**Location:** `.github/`

- **Workflows:** `ci.yml`, `release.yml`, `pr-reminder.yml`, `test-zombienet.yml`.
- **Actions:** free-disk-space, macos-dependencies, ubuntu-dependencies.
- **Tests:** `zombienet-smoke-test.zndsl` for Zombienet-based smoke testing.

Standard template CI plus Zombienet test wiring.

---

## 8. Other Config and Docs

- **`dev_chain_spec.json`** — Dev chain spec (if used for local runs).
- **`zombienet.toml` / `zombienet-omni-node.toml`** — Other Zombienet/Omni Node configs.
- **`Dockerfile`** — For containerized build/run.
- **`README.md`** — Getting started, Omni Node, Zombienet, runtime development, **and** the extra content for this repo: rebuild/respawn after runtime changes, port **9990**, “Initializing connection” and “contracts not in Chain state” troubleshooting, contracts checklist.

---

## 9. What Exists vs What’s Next

**In place:**

- Parachain template with **pallet-revive** (ink! 6 / PolkaVM) and **RandomnessCollectiveFlip**.
- Runtime config for pallet-revive (FeeInfo, deposits, memory, etc.) and supporting pallets.
- Genesis presets working in WASM so Zombienet `build-spec --chain local` succeeds.
- Single-collator Zombienet setup (**my-content-rights.toml**) using **parachain-template-node** on port **9990**.
- Scripts to verify runtime in the binary, clean build, and respawn.
- Zombienet patches so `rpc_port` and chain name are correct.

**Not yet built:**

- No custom “content rights” pallet or business logic.
- Template pallet is still the default example.
- No production chain spec or deployment config; everything is local/dev (rococo-local, local testnet).

So far the repo is a **working parachain with pallet-revive (ink! 6) and tooling**; the next step is to add the actual content-rights functionality (e.g. a new pallet and/or contracts) on top of this base.
