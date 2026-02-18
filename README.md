<div align="center">

# Polkadot SDK's Parachain Template

<img height="70px" alt="Polkadot SDK Logo" src="https://github.com/paritytech/polkadot-sdk/raw/master/docs/images/Polkadot_Logo_Horizontal_Pink_White.png#gh-dark-mode-only"/>
<img height="70px" alt="Polkadot SDK Logo" src="https://github.com/paritytech/polkadot-sdk/raw/master/docs/images/Polkadot_Logo_Horizontal_Pink_Black.png#gh-light-mode-only"/>

> This is a template for creating a [parachain](https://wiki.polkadot.network/docs/learn-parachains) based on Polkadot SDK.
>
> This template is automatically updated after releases in the main [Polkadot SDK monorepo](https://github.com/paritytech/polkadot-sdk).

</div>

## Table of Contents

- [Intro](#intro)

- [Template Structure](#template-structure)

- [Getting Started](#getting-started)

- [Starting a Development Chain](#starting-a-development-chain)

  - [Omni Node](#omni-node-prerequisites)
  - [Zombienet setup with Omni Node](#zombienet-setup-with-omni-node)
  - [Parachain Template Node](#parachain-template-node)
  - [Connect with the Polkadot-JS Apps Front-End](#connect-with-the-polkadot-js-apps-front-end)
  - [Takeaways](#takeaways)

- [Runtime development](#runtime-development)
- [Contributing](#contributing)
- [Getting Help](#getting-help)

## Intro

- ⏫ This template provides a starting point to build a [parachain](https://wiki.polkadot.network/docs/learn-parachains).

- ☁️ It is based on the
  [Cumulus](https://paritytech.github.io/polkadot-sdk/master/polkadot_sdk_docs/polkadot_sdk/cumulus/index.html) framework.

- 🔧 Its runtime is configured with a single custom pallet as a starting point, and a handful of ready-made pallets
  such as a [Balances pallet](https://paritytech.github.io/polkadot-sdk/master/pallet_balances/index.html).

- 👉 Learn more about parachains [here](https://wiki.polkadot.network/docs/learn-parachains)

## Template Structure

A Polkadot SDK based project such as this one consists of:

- 🧮 the [Runtime](./runtime/README.md) - the core logic of the parachain.
- 🎨 the [Pallets](./pallets/README.md) - from which the runtime is constructed.
- 💿 a [Node](./node/README.md) - the binary application, not part of the project default-members list and not compiled unless
  building the project with `--workspace` flag, which builds all workspace members, and is an alternative to
  [Omni Node](https://paritytech.github.io/polkadot-sdk/master/polkadot_sdk_docs/reference_docs/omni_node/index.html).

## Getting Started

- 🦀 The template is using the Rust language.

- 👉 Check the
  [Rust installation instructions](https://www.rust-lang.org/tools/install) for your system.

- 🛠️ Depending on your operating system and Rust version, there might be additional
  packages required to compile this template - please take note of the Rust compiler output.

- **WASM target (required for runtime build):**  
  - **Rust 1.84+:** `rustup target add wasm32v1-none`  
  - **Older Rust:** `rustup target add wasm32-unknown-unknown`  
  After adding a new target, run `cargo clean` before building.

Fetch parachain template code:

```sh
git clone https://github.com/paritytech/polkadot-sdk-parachain-template.git parachain-template

cd parachain-template
```

## Starting a Development Chain

The parachain template relies on a hardcoded parachain id which is defined in the runtime code
and referenced throughout the contents of this file as `{{PARACHAIN_ID}}`. Please replace
any command or file referencing this placeholder with the value of the `PARACHAIN_ID` constant:

```rust,ignore
pub const PARACHAIN_ID: u32 = 1000;
```

### Omni Node Prerequisites

[Omni Node](https://paritytech.github.io/polkadot-sdk/master/polkadot_sdk_docs/reference_docs/omni_node/index.html) can
be used to run the parachain template's runtime. `polkadot-omni-node` binary crate usage is described at a high-level
[on crates.io](https://crates.io/crates/polkadot-omni-node).

#### Install `polkadot-omni-node`

Please see the installation section at [`crates.io/omni-node`](https://crates.io/crates/polkadot-omni-node).

#### Build `parachain-template-runtime`

```sh
cargo build --profile production
```

#### Install `staging-chain-spec-builder`

Please see the installation section at [`crates.io/staging-chain-spec-builder`](https://crates.io/crates/staging-chain-spec-builder).

#### Use `chain-spec-builder` to generate the `chain_spec.json` file

```sh
chain-spec-builder create --relay-chain "rococo-local" --para-id {{PARACHAIN_ID}} --runtime \
    target/release/wbuild/parachain-template-runtime/parachain_template_runtime.wasm named-preset development
```

**Note**: the `relay-chain` and `para-id` flags are mandatory information required by
Omni Node, and for parachain template case the value for `para-id` must be set to `{{PARACHAIN_ID}}`, since this
is also the value injected through [ParachainInfo](https://docs.rs/staging-parachain-info/0.17.0/staging_parachain_info/)
pallet into the `parachain-template-runtime`'s storage. The `relay-chain` value is set in accordance
with the relay chain ID where this instantiation of parachain-template will connect to.

#### Run Omni Node

Start Omni Node with the generated chain spec. We'll start it in development mode (without a relay chain config), producing
and finalizing blocks based on manual seal, configured below to seal a block with each second.

```bash
polkadot-omni-node --chain <path/to/chain_spec.json> --dev --dev-block-time 1000
```

However, such a setup is not close to what would run in production, and for that we need to setup a local
relay chain network that will help with the block finalization. In this guide we'll setup a local relay chain
as well. We'll not do it manually, by starting one node at a time, but we'll use [zombienet](https://paritytech.github.io/zombienet/intro.html).

Follow through the next section for more details on how to do it.

### Zombienet setup with Omni Node

Assuming we continue from the last step of the previous section, we have a chain spec and we need to setup a relay chain.
We can install `zombienet` as described [here](https://paritytech.github.io/zombienet/install.html#installation), and
`zombienet-omni-node.toml` contains the network specification we want to start.

#### Relay chain prerequisites

Download the `polkadot` (and the accompanying `polkadot-prepare-worker` and `polkadot-execute-worker`) binaries from
[Polkadot SDK releases](https://github.com/paritytech/polkadot-sdk/releases). Then expose them on `PATH` like so:

```sh
export PATH="$PATH:<path/to/binaries>"
```

#### Update `zombienet-omni-node.toml` with a valid chain spec path

To simplify the process of using the parachain-template with zombienet and Omni Node, we've added a pre-configured
development chain spec (dev_chain_spec.json) to the parachain template. The zombienet-omni-node.toml file of this
template points to it, but you can update it to an updated chain spec generated on your machine. To generate a
chain spec refer to [staging-chain-spec-builder](https://crates.io/crates/staging-chain-spec-builder)

Then make the changes in the network specification like so:

```toml
# ...
[[parachains]]
id = "<PARACHAIN_ID>"
chain_spec_path = "<TO BE UPDATED WITH A VALID PATH>"
# ...
```

#### Start the network

```sh
zombienet --provider native spawn zombienet-omni-node.toml
```

### Parachain Template Node

As mentioned in the `Template Structure` section, the `node` crate is optionally compiled and it is an alternative
to `Omni Node`. Similarly, it requires setting up a relay chain, and we'll use `zombienet` once more.

#### Install the `parachain-template-node`

```sh
cargo install --path node
```

#### Setup and start the network

For setup, please consider the instructions for `zombienet` installation [here](https://paritytech.github.io/zombienet/install.html#installation)
and [relay chain prerequisites](#relay-chain-prerequisites).

We're left just with starting the network:

```sh
zombienet --provider native spawn zombienet.toml
```

### Connect with the Polkadot-JS Apps Front-End

- 🌐 You can interact with your local node using the
  hosted version of the Polkadot/Substrate Portal:
  [relay chain](https://polkadot.js.org/apps/#/explorer?rpc=ws://localhost:9944)
  and [parachain](https://polkadot.js.org/apps/#/explorer?rpc=ws://localhost:9988).

- 🪐 A hosted version is also
  available on [IPFS](https://dotapps.io/).

- 🧑‍🔧 You can also find the source code and instructions for hosting your own instance in the
  [`polkadot-js/apps`](https://github.com/polkadot-js/apps) repository.

### Takeaways

Development parachains:

- 🔗 Connect to relay chains, and we showcased how to connect to a local one.
- 🧹 Do not persist the state.
- 💰 Are preconfigured with a genesis state that includes several prefunded development accounts.
- 🧑‍⚖️ Development accounts are used as validators, collators, and `sudo` accounts.

## Runtime development

### After adding or changing runtime pallets (e.g. pallet-contracts)

When you add or remove pallets in the runtime and rebuild the node, **any already-running network (e.g. Zombienet) is still using the old runtime WASM** that was baked into genesis when it was first spawned. To see the new pallets (e.g. **contracts** in the Chain State dropdown):

1. **Rebuild** the parachain node:  
   `cargo build --release -p parachain-template-node`
2. **Stop** the current Zombienet (or dev chain).
3. **Respawn** the network so it starts from a **fresh genesis** using the new binary (and its embedded WASM).  
   Example: run your usual spawn command again (e.g. `./zombienet-spawn.sh my-content-rights.toml --provider native`). Do not reuse old chain data; let Zombienet create a new temp dir so the new runtime is used from block 0.

If you keep using the same chain data directory, the chain will keep executing the old runtime.

**If you still don’t see the new pallets (e.g. contracts):** make sure you’re connected to the **parachain** RPC, not the relay chain. The relay (alice/bob) has a different runtime and won’t show your parachain’s pallets. In `my-content-rights.toml` the parachain collator uses `rpc_port = 9990`; in Polkadot.js Apps connect to **`ws://127.0.0.1:9990`** to get the parachain (with contracts). You can confirm you’re on the parachain: Developer → Chain state → **parachainInfo** → **parachainId()** should return your para id (e.g. 100).

**If Polkadot.js Apps shows “Initializing connection” forever when using `ws://127.0.0.1:9990`:** the parachain collator may be on a different port. In the zombienet spawn output, after “Network launched”, check the **collator01** row: **Direct Link (pjs)** shows the actual RPC URL (e.g. `ws://127.0.0.1:9989`). Use that port in Polkadot.js Apps. This repo is configured for `rpc_port = 9990`; if Zombienet still used 9989, a patch in `zombienet/javascript` was applied so it respects `rpc_port`. Rebuild zombienet after pulling: `cd zombienet/javascript && npm run build`, then spawn again. If nothing is listening on the port shown, run `./scripts/check-parachain-port.sh <port>` and check the collator log path from the spawn terminal.

**If you’re on the parachain (9990) and contracts still don’t appear**, the chain was almost certainly created with an older binary. Do a **clean rebuild and fresh spawn** from the repo root:

1. **Stop** Zombienet completely (Ctrl+C or kill the process).
2. **Clean and rebuild** so the runtime WASM is definitely regenerated:
   ```sh
   cargo clean -p parachain-template-runtime -p parachain-template-node
   cargo build --release -p parachain-template-node
   ```
3. **Spawn from repo root** (so the script resolves the binary path correctly):
   ```sh
   cd /path/to/content-rights-parachain
   ./zombienet-spawn.sh my-content-rights.toml --provider native
   ```
4. After the network is running (blocks in explorers), connect to **`ws://127.0.0.1:9990`** and check the Chain State pallet list for **contracts**.

Do **not** pass `--dir` to the spawn script when testing; let Zombienet create a new temp dir so the chain spec is generated from the binary you just built.

**Verify your binary:** From repo root, run `./scripts/verify-runtime-has-contracts.sh` after building. If it prints "Contracts pallet: FOUND", your binary is correct and the running chain was created with an older one; do a full stop and respawn (no `--dir`). If it prints "NOT FOUND", run `./scripts/clean-runtime-wasm.sh` then `cargo build --release -p parachain-template-node` and verify again (the runtime uses `runtime-full` so pallet-contracts is included; a stale build can omit it).

**"Contracts" still not in the list?** You are in the right place: **Developer → Chain state**; the pallet list is the left dropdown. Run `./scripts/contracts-checklist.sh` from repo root: it verifies your binary and prints the exact clean-rebuild-and-respawn steps.

**ink! smart contracts:** To develop and deploy ink! contracts on this parachain, set up the ink! environment (Rust, `rust-src`, wasm32 target, `cargo-contract`) and use the parachain RPC at **`ws://127.0.0.1:9990`**. See **[INK_SETUP.md](INK_SETUP.md)** for step-by-step setup and `./scripts/check-ink-env.sh` to verify the environment.

We recommend using [`chopsticks`](https://github.com/AcalaNetwork/chopsticks) when the focus is more on the runtime
development and `OmniNode` is enough as is.

### Install chopsticks

To use `chopsticks`, please install the latest version according to the installation [guide](https://github.com/AcalaNetwork/chopsticks?tab=readme-ov-file#install).

### Build a raw chain spec

Build the `parachain-template-runtime` as mentioned before in this guide and use `chain-spec-builder`
again but this time by passing `--raw-storage` flag:

```sh
chain-spec-builder create --raw-storage --relay-chain "rococo-local" --para-id {{PARACHAIN_ID}} --runtime \
    target/release/wbuild/parachain-template-runtime/parachain_template_runtime.wasm named-preset development
```

### Start `chopsticks` with the chain spec

```sh
npx @acala-network/chopsticks@latest --chain-spec <path/to/chain_spec.json>
```

### Alternatives

`OmniNode` can be still used for runtime development if using the `--dev` flag, while `parachain-template-node` doesn't
support it at this moment. It can still be used to test a runtime in a full setup where it is started alongside a
relay chain network (see [Parachain Template node](#parachain-template-node) setup).

## Contributing

- 🔄 This template is automatically updated after releases in the main [Polkadot SDK monorepo](https://github.com/paritytech/polkadot-sdk).

- ➡️ Any pull requests should be directed to this [source](https://github.com/paritytech/polkadot-sdk/tree/master/templates/parachain).

- 😇 Please refer to the monorepo's
  [contribution guidelines](https://github.com/paritytech/polkadot-sdk/blob/master/docs/contributor/CONTRIBUTING.md) and
  [Code of Conduct](https://github.com/paritytech/polkadot-sdk/blob/master/docs/contributor/CODE_OF_CONDUCT.md).

## Getting Help

- 🧑‍🏫 To learn about Polkadot in general, [docs.Polkadot.com](https://docs.polkadot.com/) website is a good starting point.

- 🧑‍🔧 For technical introduction, [here](https://github.com/paritytech/polkadot-sdk#-documentation) are
  the Polkadot SDK documentation resources.

- 👥 Additionally, there are [GitHub issues](https://github.com/paritytech/polkadot-sdk/issues) and
  [Substrate StackExchange](https://substrate.stackexchange.com/).
- 👥You can also reach out on the [Official Polkdot discord server](https://polkadot-discord.w3f.tools/)
- 🧑Reach out on [Telegram](https://t.me/substratedevs) for more questions and discussions
