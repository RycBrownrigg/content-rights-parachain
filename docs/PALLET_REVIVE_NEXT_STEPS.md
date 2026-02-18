# pallet-revive / ink! 6 / cargo-contract 6 – What Was Done and What You Do Next

We integrated **pallet-revive** into the parachain runtime so that **ink! 6** and **cargo-contract 6** can deploy and call contracts (they use the `ContractsApi` that only pallet-revive exposes).

---

## What was changed

1. **Workspace `Cargo.toml`**  
   - `polkadot-sdk` is now a **git** dependency (no version pin) so the runtime can use the in-repo pallet-revive API.  
   - You can pin a specific rev later for reproducible builds, e.g.  
     `rev = "a1b2c3d"` or `tag = "polkadot-sdk-v1.x.x"`.

2. **Runtime `Cargo.toml`**  
   - Added the **`pallet-revive`** feature to the `polkadot-sdk` features list.

3. **Runtime `lib.rs`**  
   - Imported `pallet_revive::evm::{runtime::EthExtra, tx_extension::SetOrigin}`.  
   - Extended **TxExtension** with `ReviveSetOrigin<Runtime>`.  
   - Added **EthExtraImpl** and `impl EthExtra for EthExtraImpl` (so the node can handle both Substrate and Ethereum-style extrinsics).  
   - **UncheckedExtrinsic** is now `pallet_revive::evm::runtime::UncheckedExtrinsic<..., EthExtraImpl>`.  
   - **construct_runtime**: added **Revive** (`pallet_revive`) with index 41.

4. **Runtime `configs/mod.rs`**  
   - **parameter_types**: `DepositPerChildTrieItemRevive`, `MaxEthExtrinsicWeightRevive`.  
   - **impl pallet_revive::Config for Runtime** with all required associated types (Time, Balance, Currency, FeeInfo, AddressMapper, etc.).

5. **Runtime `apis.rs`**  
   - Replaced **impl_runtime_apis!** with **pallet_revive::impl_runtime_apis_plus_revive_traits!** and passed `Runtime, Revive, Executive, EthExtraImpl` plus the existing API impls.  
   - **Core::execute_block** now takes `<Block as BlockT>::LazyBlock` to match the macro’s expectations.

---

## What you do next

1. **Build**  
   From the repo root (with a working Rust toolchain, e.g. `rustup default stable`):

   ```bash
   cd /home/ryc/content-rights-parachain
   cargo build --release -p parachain-template-runtime
   cargo build --release -p parachain-template-node
   ```

   - If the build fails, fix any reported errors (e.g. missing imports, type mismatches, or genesis for Revive).  
   - The first build with a git `polkadot-sdk` may take a long time while dependencies are fetched and compiled.

2. **Run the chain**  
   - Build the relay (polkadot) from `polkadot-sdk` if you haven’t (see `docs/NEXT_STEPS.md`).  
   - Start the network with zombienet, e.g.:

   ```bash
   ./zombienet-spawn.sh my-content-rights.toml --provider native
   ```

   - Parachain RPC: **ws://127.0.0.1:9990**.

3. **Deploy and call Flipper (ink! 6)**  
   In another terminal:

   ```bash
   cd ~/flipper
   cargo contract instantiate --suri //Alice --args true --url ws://127.0.0.1:9990
   ```

   Then use the printed contract address:

   ```bash
   cargo contract call --contract <ADDRESS> --message get --suri //Alice --url ws://127.0.0.1:9990
   cargo contract call --contract <ADDRESS> --message flip --execute --suri //Alice --url ws://127.0.0.1:9990
   ```

---

## Optional: pin polkadot-sdk to a specific rev

In the root `Cargo.toml`, you can pin the SDK for reproducible builds:

```toml
polkadot-sdk = { git = "https://github.com/paritytech/polkadot-sdk.git", rev = "YOUR_REV_OR_TAG", default-features = false }
```

Replace `YOUR_REV_OR_TAG` with a commit hash or tag (e.g. from a release).

---

## If something breaks

- **Build errors** in the runtime (e.g. “missing trait” or “wrong number of type arguments”): the in-repo pallet-revive API may have changed; compare with `polkadot-sdk/substrate/frame/revive/dev-node/runtime` and `polkadot-sdk/cumulus/parachains/runtimes/testing/penpal/src/lib.rs`.  
- **“ContractsApi_instantiate is not found”** at runtime: ensure the node and runtime were built **after** these changes and that you’re connecting to the **parachain** (e.g. port 9990), not the relay.  
- **Genesis / chain spec**: if the chain fails to start, you may need to add Revive’s genesis config to your genesis builder / chain spec (see how penpal or the revive dev-node do it).
