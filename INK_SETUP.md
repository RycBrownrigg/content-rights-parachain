# ink! Environment Setup

This project uses **ink!** (Rust smart contracts) with **pallet-revive** (PolkaVM / ink! 6) on the parachain. You develop contracts with the ink! 6 toolchain and deploy them to your local parachain at **`ws://127.0.0.1:9990`** (after running `./zombienet-spawn.sh my-content-rights.toml --provider native`).

You do **not** need `substrate-contracts-node` — this repo already has a parachain with **pallet-revive** for ink! 6 contracts.

---

## 1. Prerequisites

- **Rust (stable)** and Cargo: [rustup](https://rustup.rs/)
- **WASM target:** You already have one if you've built this parachain's runtime (the runtime build uses the same family of targets). If `./scripts/check-ink-env.sh` reports a missing wasm32 target, add it:
  - **Rust 1.84+:** `rustup target add wasm32v1-none`
  - **Older Rust:** `rustup target add wasm32-unknown-unknown`
- **C++17-capable compiler** (for some contract dependencies): e.g. gcc, clang, or MSVC 2019+

---

## 2. Install cargo-contract (ink! 6 CLI)

[cargo-contract](https://github.com/paritytech/cargo-contract) is the CLI for building, uploading, and calling ink! contracts. This parachain uses **pallet-revive**, so you need **cargo-contract 6.x** (ink! 6). The version on crates.io by default is 5.x, which uses a panic flag that current Rust rejects when building.

**Step 1 — Rust standard library source (required):**

```sh
rustup component add rust-src
```

**Step 2 — Install cargo-contract 6 (for ink! 6 / pallet-revive):**

```sh
# Option A: install the ink! 6–compatible beta (recommended)
cargo install --force --locked --version 6.0.0-beta.1 cargo-contract

# Option B: install latest from git (may need Rust 1.92+)
# cargo install cargo-contract --git https://github.com/paritytech/cargo-contract --force
```

**Step 3 — (Optional) Linting:**

- **macOS:** `brew install openssl` (if needed for dylint)
- For `cargo contract check` linting with dylint, see [cargo-contract README](https://github.com/paritytech/cargo-contract#installation) (nightly + cargo-dylint). You can skip this and still build/upload/call contracts.

**Step 4 — (Optional) Verifiable builds:**

Install [Docker](https://docs.docker.com/engine/install) if you want `cargo contract build --verifiable`.

---

## 3. Verify the setup

From the repo root:

```sh
./scripts/check-ink-env.sh
```

This checks: `rust-src`, WASM target, and `cargo contract` in `PATH`.

Or manually:

```sh
rustup component list --installed | grep -q rust-src && echo "rust-src: OK" || echo "rust-src: missing"
rustup target list --installed | grep -q wasm32 && echo "wasm32 target: OK" || echo "wasm32 target: missing"
cargo contract --version
```

(If you've built the parachain runtime, the wasm32 target is usually already there.)

---

## 4. Quick test: build a Flipper contract (ink! 6)

Use **cargo-contract 6** (see §2) so the template is ink! 6 and the build succeeds on current Rust.

```sh
# Outside this repo, or in a subdir (e.g. contracts/)
cargo contract new flipper
cd flipper
cargo contract build --release
```

You should get `target/ink/flipper/flipper.contract` (or similar path per cargo-contract version). If you see `panic_immediate_abort is now a real panic strategy`, try the **Cargo.toml workaround** in §7 (add `panic = "immediate-abort"` to the contract’s release profile) or install cargo-contract 6 from git.

---

## 5. Deploy to this parachain

1. **Start the parachain** (if not already running):

   ```sh
   ./zombienet-spawn.sh my-content-rights.toml --provider native
   ```

2. **Connect to the parachain RPC:** **`ws://127.0.0.1:9990`** (not the relay).

3. **Upload and instantiate** (example with Flipper):

   ```sh
   cd flipper
   cargo contract upload --suri //Alice --execute --skip-confirm -x
   # Then use the returned code hash to instantiate, or use Contracts UI (see below).
   ```

   For a guided flow you can use:

   - **Contracts UI:** [https://contracts-ui.substrate.io/](https://contracts-ui.substrate.io/) — set the endpoint to **`ws://127.0.0.1:9990`**, then upload and instantiate your `.contract` bundle.
   - **Polkadot.js Apps:** Developer → Contracts → upload code / instantiate.

Use an account with balance (e.g. `//Alice` in dev) for upload and instantiation.

---

## 6. Useful commands

| Command | Purpose |
|--------|--------|
| `cargo contract new <name>` | Create a new ink! contract (Flipper template). |
| `cargo contract build --release` | Build contract → `.contract` bundle. |
| `cargo contract check` | Check Wasm build without producing artifact. |
| `cargo contract test` | Run off-chain tests. |
| `cargo contract upload` | Upload contract code to chain. |
| `cargo contract instantiate` | Create a contract instance. |
| `cargo contract call` | Call a contract message. |

Pass `--help` to any subcommand for options (e.g. `-u ws://127.0.0.1:9990` for endpoint).

---

## 7. Troubleshooting: `panic_immediate_abort` (in `core`)

If `cargo contract build --release` fails with **`panic_immediate_abort is now a real panic strategy!`** (in `core`), do the following in the contract directory (e.g. `~/flipper`).

1. **Opt in to the unstable Cargo feature** — at the **very top** of `Cargo.toml`, before any `[package]` or other table, add:
   ```toml
   cargo-features = ["panic-immediate-abort"]
   ```
2. **Set the release panic strategy** — in `Cargo.toml` add (or extend `[profile.release]` with):
   ```toml
   [profile.release]
   panic = "immediate-abort"
   ```
3. **Use nightly Cargo** — the feature is unstable on stable Cargo 1.93, so build with nightly:
   ```sh
   rustup install nightly
   cargo +nightly contract build --release
   ```

**If you still see `panic_immediate_abort is now a real panic strategy!` (in `core`) with nightly:** cargo-contract **6.0.0-beta.1** (crates.io) still passes the old build-std feature when compiling `core`. Install **cargo-contract from git** so the build uses the new panic strategy:
   ```sh
   cargo +nightly install cargo-contract --git https://github.com/paritytech/cargo-contract --force
   ```
   Then run `cargo +nightly contract build --release` again (keep your `cargo-features` and `[profile.release]` in `Cargo.toml` and `~/.cargo/config.toml` with `json-target-spec = true`).

If you see **`feature 'panic-immediate-abort' is required`** when running `cargo contract build`, you added `panic = "immediate-abort"` but either didn't add `cargo-features = ["panic-immediate-abort"]` at the top of `Cargo.toml`, or you're using stable Cargo. Add the `cargo-features` line and use `cargo +nightly contract build --release`.

**VS Code / rust-analyzer:** You may see a warning that `"immediate-abort"` is not one of `["unwind", "abort"]`. That comes from the editor schema; Cargo and rustc accept `immediate-abort` and the warning can be ignored.

If `cargo contract build --release` fails with one of:

- **`incorrect value 'immediate-abort' for codegen option 'panic'`** — Your contract’s Rust is too old; it doesn’t support `-C panic=immediate-abort`.
- **`panic_immediate_abort is now a real panic strategy!`** (in `core`) — Your contract’s Rust is too new for the *old* `-Z build-std-features=panic_immediate_abort` behavior used by **cargo-contract 5.x**.

**Version alignment:**

| Tool | Contract Rust | Result |
|------|----------------|--------|
| **cargo-contract from git (6.x)** | Needs **Rust 1.92+** (e.g. latest nightly) and **ink! 6** | Uses `-C panic=immediate-abort`; works with latest nightly. |
| **cargo-contract 5.0.3** (crates.io) | Uses `-Z build-std-features=panic_immediate_abort` | Fails on recent nightlies (core rejects the old feature). |

**Recommended fix (ink! 6 + cargo-contract from git):**

1. Use **latest nightly** for the contract (e.g. in `flipper/rust-toolchain.toml`: `channel = "nightly"`).
2. Install **cargo-contract from git** with that same nightly so the binary is built with Rust ≥ 1.92:
   ```sh
   rustup run nightly cargo install cargo-contract --git https://github.com/paritytech/cargo-contract --force
   ```
3. Upgrade the Flipper (or any ink! 5) contract to **ink! 6** (see [ink! 6 migration](https://use.ink/docs/migrate/migrate-from-ink5-to-ink6/)), then:
   ```sh
   cd flipper && unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS && cargo contract build --release
   ```

**If you want to stay on ink! 5:** This is **no longer practical** with the current ecosystem. Older nightlies (e.g. 2024-10-01) accept cargo-contract 5.x’s panic flag but their Cargo does not support **edition2024**; several crates in the dependency tree (e.g. `home`, `base64ct`) now require edition2024, so metadata resolution fails. Newer nightlies have edition2024 but reject the old panic flag. Patching every such crate from git is fragile and failed (e.g. the Cargo repo has invalid test manifests). **Recommendation:** upgrade to **ink! 6** and use **cargo-contract 6.x** (see below and §8).

---

## 8. Troubleshooting: `.json` target specs require `-Zjson-target-spec`

If you see:

```text
warning: This version of cargo-contract is not compatible with the contract's ink! version...
 [==] Building cargo project
error: `.json` target specs require -Zjson-target-spec
ERROR:
```

**Cause:** cargo-contract **6.x** (from git) uses a PolkaVM `.json` target. Recent Rust requires the unstable flag `-Zjson-target-spec` for that target, and in some environments that flag is not reaching the right `rustc` invocation (e.g. Cargo’s target probe).

**For ink! 5:** Using cargo-contract 5.0.1 no longer works with current dependencies (edition2024 vs old nightly; see §7).

**Fix:** Cargo must be run with the unstable flag. cargo-contract may run cargo from a context where the project’s `.cargo/config.toml` is not loaded, so use the **global** config.

1. **Global config (recommended)** — In your home directory, edit or create **`~/.cargo/config.toml`** and add (or merge into existing):

   ```toml
   [unstable]
   json-target-spec = true
   ```

   Then build with nightly:

   ```sh
   cargo +nightly contract build --release
   ```

2. **If the error persists,** cargo-contract may invoke cargo in a way that ignores config. Use a **CARGO wrapper** so the flag is always passed. Create a script (e.g. `~/bin/cargo-json-target-spec`):

   ```sh
   #!/bin/sh
   exec cargo +nightly -Z json-target-spec "$@"
   ```

   Make it executable (`chmod +x ~/bin/cargo-json-target-spec`), then run:

   ```sh
   CARGO=~/bin/cargo-json-target-spec cargo +nightly contract build --release
   ```

   Any cargo invocation from cargo-contract will then get the flag. Use the same for other contract builds, or `export CARGO=~/bin/cargo-json-target-spec` in your shell when working on ink! 6.

---

## 9. References

- [ink! documentation](https://use.ink/)
- [cargo-contract (GitHub)](https://github.com/paritytech/cargo-contract)
- [Contracts UI](https://contracts-ui.substrate.io/) — deploy and call contracts in the browser.
