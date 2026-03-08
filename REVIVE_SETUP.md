# pallet-revive (ink! 6 / PolkaVM)

This parachain uses **pallet-revive** for ink! 6 smart contracts. Contract development and deployment (e.g. with cargo-contract 6) target **pallet-revive** (PolkaVM), not pallet-contracts.

## What’s in place

- **Runtime:** `pallet-revive` is integrated in the parachain runtime (pallet index 41). The runtime uses a **git** dependency on `polkadot-sdk` so the full pallet-revive API (EVM fees, `EthExtra`, `SetOrigin`, etc.) is available.
- **Config:** `pallet_revive::Config` is implemented in `runtime/src/configs/mod.rs` (FeeInfo, deposits, memory limits, ChainId, etc.).
- **APIs:** Runtime APIs are implemented via `pallet_revive::impl_runtime_apis_plus_revive_traits!` in `runtime/src/apis.rs`.
- **Tooling:** Use **ink! 6** and **cargo-contract 6.x** (from git) to build and deploy contracts to this chain. See [INK_SETUP.md](INK_SETUP.md).

## Why pallet-revive (not only pallet-contracts)

- **ink! 6** and **cargo-contract 6** target the PolkaVM/revive stack. This repo is set up for that workflow.
- The runtime still includes **pallet-contracts** (index 40) for legacy WASM contracts; the primary path for new ink! development is **pallet-revive**.

## References

- [INK_SETUP.md](INK_SETUP.md) — ink! environment, cargo-contract, deploy to this parachain.
- [docs/DEPLOY_AND_CALL.md](docs/DEPLOY_AND_CALL.md) — deploy and call via Contracts UI, weight limits, mapAccount, and troubleshooting (e.g. "Transaction would exhaust the block limits").
- Polkadot SDK: `substrate/frame/revive`, `substrate/frame/revive/dev-node/runtime`, and penpal runtime for reference configs.
