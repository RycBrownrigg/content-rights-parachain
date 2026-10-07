# Content Rights Parachain — Setup Instructions

Step-by-step instructions to build the parachain and run it with Zombienet. Do these in order.

---

## Part 1: Prerequisites

### 1.1 Rust and WASM target

- Install **Rust (stable)** via [rustup](https://rustup.rs/) if needed.
- Add a **WASM target** (required for the runtime):
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

This builds the node and the runtime WASM. The binary must exist at:

`target/release/parachain-template-node`


---

## Part 3: Start the Network with Zombienet

From the **repo root**:

```sh
./zombienet-spawn.sh my-content-rights.toml --provider native
```

- Wait 30–60 seconds (or until you see blocks) before connecting UIs.
- **Parachain RPC:** the collator is configured with **`rpc_port = 9990`**.  
  Connect to: **`ws://127.0.0.1:9990`** (this is the **parachain**, not the relay).
- Relay chain nodes (alice/bob) use other ports; they do **not** expose the parachain’s pallets (e.g. **contentRights**).

If nothing listens on 9990, check the Zombienet output for the collator’s “Direct Link (pjs)” URL and use that port, or run:

```sh
./scripts/check-parachain-port.sh 9990
```

---

## Part 4: Verify the Parachain

1. Open [Polkadot.js Apps](https://polkadot.js.org/apps/) and connect to **`ws://127.0.0.1:9990`**.
2. Go to **Developer → Chain state**.
3. In the pallet dropdown, you should see **contentRights** (and **parachainInfo**, **nfts**, etc.).
4. **parachainInfo → parachainId()** should return your para id (e.g. **100** as in `my-content-rights.toml`).

If **contentRights** does not appear:

- You are likely connected to the relay (wrong port). Use **9990** for the parachain.
- Or the chain was spawned from an **old binary**. Then:
  1. Stop Zombienet (Ctrl+C).
  2. ##### Clean and rebuild:   `cargo clean -p parachain-template-runtime -p parachain-template-node`   `cargo build --release -p parachain-template-node`
  3. Spawn again **without** `--dir` so Zombienet creates a new chain spec from the new binary:  
     `./zombienet-spawn.sh my-content-rights.toml --provider native`
  4. Reconnect to **`ws://127.0.0.1:9990`** and check Chain state again.

See "After changing the runtime" below for more troubleshooting.

---

## Quick reference

| Step             | Command / endpoint                                                                    |
| ---------------- | ------------------------------------------------------------------------------------- |
| Build relay      | `cd polkadot-sdk && cargo build --release -p polkadot`                                |
| Build parachain  | `cargo build --release -p parachain-template-node`                                    |
| Start network    | `./zombienet-spawn.sh my-content-rights.toml --provider native`                       |
| Parachain RPC    | **`ws://127.0.0.1:9990`**                                                             |

---

## After changing the runtime

If you add or change pallets and rebuild:

1. Rebuild: `cargo build --release -p parachain-template-node`
2. **Stop** Zombienet.
3. **Respawn** without reusing old data (do **not** pass `--dir` to reuse the previous chain spec):  
   `./zombienet-spawn.sh my-content-rights.toml --provider native`

Otherwise the network keeps using the old runtime WASM from the previous genesis.

---

## More detail

- **Parachain template, Omni Node, Chopsticks:** [README.md](README.md)
- **Port issues:** `./scripts/check-parachain-port.sh`
