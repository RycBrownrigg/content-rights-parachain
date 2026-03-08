# Content Rights Parachain — Setup Instructions

Step-by-step instructions to build the parachain, run it with Zombienet, and deploy ink! contracts. Do these in order.

---

## Part 1: Prerequisites

### 1.1 Rust and WASM target

- Install **Rust (stable)** via [rustup](https://rustup.rs/) if needed.
- Add a **WASM target** (required for the runtime and for ink!):
  - **Rust 1.84+:**  
    `rustup target add wasm32v1-none`
  - **Older Rust:**  
    `rustup target add wasm32-unknown-unknown`
- If you add the target after cloning, run `cargo clean` before building the runtime.

### 1.2 Relay chain binaries (Polkadot)

Zombienet needs the `polkadot` binary (and workers). Build them from the bundled SDK:

```sh
cd /path/to/content-rights-parachain
cd polkadot-sdk && cargo build --release -p polkadot
cd ..
```

Ensure `polkadot-sdk/target/release/polkadot` exists. The config `my-content-rights.toml` points the relay to `polkadot-sdk/target/release/`.

### 1.3 Zombienet

- Install [Zombienet](https://paritytech.github.io/zombienet/install.html#installation) (e.g. via npm or the standalone binary).
- This repo runs Zombienet from **`zombienet/javascript`** with a wrapper script, so you need the `zombienet/` directory inside the repo (already present if you cloned with submodules or have it in tree).
- If you changed Zombienet JS code under `zombienet/javascript`, rebuild:  
  `cd zombienet/javascript && npm run build && cd ../..`

---

## Part 2: Build the Parachain

From the **repo root**:

```sh
cargo build --release -p parachain-template-node
```

This builds the node and the runtime WASM (including **pallet-revive** for ink! 6). The binary must exist at:

`target/release/parachain-template-node`

Optional checks:

- **Runtime / contract pallet in binary:**  
  `./scripts/verify-runtime-has-contracts.sh`  
  (should report the contracts pallet as found)
- **Full contracts checklist:**  
  `./scripts/contracts-checklist.sh`

---

## Part 3: Start the Network with Zombienet

From the **repo root**:

```sh
./zombienet-spawn.sh my-content-rights.toml --provider native
```

- Wait 30–60 seconds (or until you see blocks) before connecting UIs.
- **Parachain RPC:** the collator is configured with **`rpc_port = 9990`**.  
  Connect to: **`ws://127.0.0.1:9990`** (this is the **parachain**, not the relay).
- Relay chain nodes (alice/bob) use other ports; they do **not** expose the parachain’s pallets (e.g. **revive**, contracts).

If nothing listens on 9990, check the Zombienet output for the collator’s “Direct Link (pjs)” URL and use that port, or run:

```sh
./scripts/check-parachain-port.sh 9990
```

---

## Part 4: Verify the Parachain and Contract Pallets

1. Open [Polkadot.js Apps](https://polkadot.js.org/apps/) and connect to **`ws://127.0.0.1:9990`**.
2. Go to **Developer → Chain state**.
3. In the pallet dropdown, you should see **revive** (and **parachainInfo**, **contracts**, etc.). Use **revive** for ink! 6 contract deployment.
4. **parachainInfo → parachainId()** should return your para id (e.g. **100** as in `my-content-rights.toml`).

If **revive** (or the contract pallet you need) does not appear:

- You are likely connected to the relay (wrong port). Use **9990** for the parachain.
- Or the chain was spawned from an **old binary**. Then:
  1. Stop Zombienet (Ctrl+C).
  2. ##### Clean and rebuild:   `cargo clean -p parachain-template-runtime -p parachain-template-node`   `cargo build --release -p parachain-template-node`
  3. Spawn again **without** `--dir` so Zombienet creates a new chain spec from the new binary:  
     `./zombienet-spawn.sh my-content-rights.toml --provider native`
  4. Reconnect to **`ws://127.0.0.1:9990`** and check Chain state again.

See README.md (“Runtime development / After adding or changing runtime pallets”) and `./scripts/contracts-checklist.sh` for more troubleshooting. For ink! 6 deployment you use the **Revive** pallet.

---

## Part 5: ink! Environment (for Smart Contracts)

To build and deploy ink! contracts to this parachain you need **cargo-contract** and its prerequisites.

### 5.1 Rust standard library source

```sh
rustup component add rust-src
```

### 5.2 WASM target

If you haven’t already (Part 1.1):

- **Rust 1.84+:** `rustup target add wasm32v1-none`
- **Older:** `rustup target add wasm32-unknown-unknown`

### 5.3 cargo-contract

```sh
cargo install --force --locked cargo-contract
```

### 5.4 Verify ink! environment

From repo root:

```sh
./scripts/check-ink-env.sh
```

It checks: **rust-src**, **wasm32** target, and **cargo contract** in PATH. Fix any reported missing item (see [INK_SETUP.md](INK_SETUP.md) for details).

---

## Part 6: Build and Deploy an ink! Contract

### 6.1 Create and build a contract

Outside this repo (or in a subdir, e.g. `contracts/`):

```sh
cargo contract new flipper
cd flipper
cargo contract build --release
```

You should get a `.contract` bundle (e.g. `target/ink/flipper/flipper.contract`).

### 6.2 Deploy to the parachain

1. **Parachain must be running** (Part 3) and you must use its RPC: **`ws://127.0.0.1:9990`**.

2. **Upload and instantiate** (example with Flipper and dev account `//Alice`):
   
   ```sh
   cd flipper
   cargo contract upload --suri //Alice --execute --skip-confirm -x
   ```
   
   Or use a UI:
   
   - **[Contracts UI](https://contracts-ui.substrate.io/)** or **[ui.use.ink](https://ui.use.ink)** — set endpoint to **`ws://127.0.0.1:9990`**, then upload the `.contract` and instantiate. To **call** contracts (e.g. `flip`), set RefTime Limit to **`1000000000000`** and ProofSize Limit to **`2097152`** to avoid "Transaction would exhaust the block limits". If you use a browser extension account, run **`revive::mapAccount`** (Developer → Extrinsics) after each zombienet restart. See [INK_SETUP.md](INK_SETUP.md) and [docs/DEPLOY_AND_CALL.md](docs/DEPLOY_AND_CALL.md) for full details.
   - **Polkadot.js Apps** — connect to **`ws://127.0.0.1:9990`**, then **Developer → Contracts** to upload code and instantiate.

Use an account with balance (e.g. **//Alice** in dev) for upload and instantiation.

---

## Quick reference

| Step             | Command / endpoint                                                                    |
| ---------------- | ------------------------------------------------------------------------------------- |
| Build relay      | `cd polkadot-sdk && cargo build --release -p polkadot`                                |
| Build parachain  | `cargo build --release -p parachain-template-node`                                    |
| Start network    | `./zombienet-spawn.sh my-content-rights.toml --provider native`                       |
| Parachain RPC    | **`ws://127.0.0.1:9990`**                                                             |
| Verify contract pallet | Polkadot.js Apps → Developer → Chain state → pallet **revive** (ink! 6) or **contracts** |
| Verify ink! env  | `./scripts/check-ink-env.sh`                                                          |
| Deploy contract  | Contracts UI or `cargo contract upload` with `-u ws://127.0.0.1:9990` (or equivalent) |

---

## After changing the runtime

If you add or change pallets (e.g. revive, contracts) and rebuild:

1. Rebuild: `cargo build --release -p parachain-template-node`
2. **Stop** Zombienet.
3. **Respawn** without reusing old data (do **not** pass `--dir` to reuse the previous chain spec):  
   `./zombienet-spawn.sh my-content-rights.toml --provider native`

Otherwise the network keeps using the old runtime WASM from the previous genesis.

---

## More detail

- **ink! and cargo-contract:** [INK_SETUP.md](INK_SETUP.md)
- **Parachain template, Omni Node, Chopsticks:** [README.md](README.md)
- **Contract pallet not showing / port issues:** README.md section “Runtime development” and `./scripts/contracts-checklist.sh`, `./scripts/check-parachain-port.sh`
