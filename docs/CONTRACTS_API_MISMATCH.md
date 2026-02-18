# Why "ContractsApi_instantiate is not found"

## What’s going on

- **cargo-contract 6** and **ink! 6** target chains that use **pallet-revive** (PolkaVM).  
  The CLI calls a runtime API named `ContractsApi_instantiate` that only exists when the chain has pallet-revive.

- **Your chain** uses **pallet-contracts** (WASM), not pallet-revive.  
  So the node doesn’t expose `ContractsApi_instantiate`, and you get:

  ```text
  Execution failed: Other: Exported method ContractsApi_instantiate is not found
  ```

So the toolchain (ink! 6 + cargo-contract 6) and the chain (pallet-contracts) don’t match.

---

## Your options

### Option 1: Keep pallet-contracts — use ink! 5 + cargo-contract 5

- Use **ink! 5** and **cargo-contract 5** to build a **WASM** contract.
- Deploy and call it on your current chain (pallet-contracts) via normal extrinsics (e.g. `Contracts::instantiate_with_code`, `Contracts::call`); no `ContractsApi_instantiate` needed.
- You previously hit toolchain/dependency issues with this path (see `INK_OPTION_A.md`). If you fix those (e.g. compatible Rust/toolchain and dependency versions), this is the way to stay on pallet-contracts.

### Option 2: Add pallet-revive — keep ink! 6 + cargo-contract 6

- Integrate **pallet-revive** into your runtime (see `REVIVE_SETUP.md`).
- Keep using **ink! 6** and **cargo-contract 6** for the Flipper.
- Once the chain exposes the revive/Contracts API, `cargo contract instantiate` and `cargo contract call` will work against this chain.

---

## Connection note

- **Connection refused** when using `SUBSTRATE_URL=...`: some versions of cargo-contract ignore the env and need the URL on the command line. Use **`--url ws://127.0.0.1:9990`** so the parachain is used.
- **405** from `curl http://127.0.0.1:9990` and **parachain listening on 9990** are normal; the remaining problem is the API mismatch above, not connectivity.
