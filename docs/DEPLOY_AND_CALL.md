# Deploy and Call the Flipper Contract

Use this after building the ink! 6 Flipper with `cargo contract build` in `~/flipper`.

---

## Prerequisites

1. **Built contract**  
   In `~/flipper` you should have:
   - `target/ink/flipper/flipper.contract` (bundle used for upload/instantiate)
   - `target/ink/flipper/flipper.wasm`

2. **Running node**  
   A chain that has the Contracts pallet (e.g. your content-rights parachain in dev mode, or a local `--dev` node).  
   Example:
   ```bash
   # From content-rights-parachain repo
   ./target/release/content-rights-parachain --dev
   ```
   Note the RPC URL (e.g. `ws://127.0.0.1:9990` or the port your node uses).

3. **Connection for cargo-contract**  
   Point the CLI at your node. Common options:
   - **Environment:** `export SUBSTRATE_URL=ws://127.0.0.1:9990`
   - **Flag:** many commands support `--url ws://127.0.0.1:9990`  
   Replace the port if your node uses a different one (e.g. 9945).

4. **Account**  
   Use an account that has balance on the chain (e.g. `//Alice` in dev).  
   `--suri //Alice` is the usual dev choice.

---

## 1. Deploy (upload + instantiate)

From the **flipper** directory:

```bash
cd ~/flipper
export SUBSTRATE_URL=ws://127.0.0.1:9990   # or your node’s WebSocket URL

cargo contract instantiate --url ws://127.0.0.1:9990 --suri //Alice --args true --skip-confirm --execute
```

- `--args true` is the Flipper constructor argument (initial value of the flip).
- This uploads the contract code and creates one instance in a single flow (cargo-contract 6 style).
- The command prints the **contract address** (AccountId). Copy it for the next step.

**If you see:** `Could not decode ContractResult::result ... DispatchError, variant doesn't exist` during the dry-run, use **skip dry-run** and pass weight limits (required when skipping dry-run):

```bash
cargo contract instantiate --url ws://127.0.0.1:9990 --suri //Alice --args true \
  --skip-confirm --skip-dry-run --execute \
  --gas 2000000000000 --proof-size 10485760 \
  --storage-deposit-limit 1000000000000000000
```

- `--gas` is ref_time (computation weight). For **instantiate** these values may be accepted; for **calls** from the Contracts UI use lower limits (RefTime `1000000000000`, ProofSize `2097152`) to avoid "Transaction would exhaust the block limits" (see §3).
- `--storage-deposit-limit` is the max balance to reserve for contract storage (in smallest units); use a large value if you skip dry-run (e.g. `1000000000000000000`).

If your CLI expects **upload** and **instantiate** as two steps, use:

```bash
cargo contract upload --suri //Alice
# Note the Code hash from the output, then:
cargo contract instantiate --suri //Alice --constructor new --args true
# Or use the code hash: --code-hash <hash>
```

Again, copy the **contract address** from the output.

---

## 2. Call the contract

Use the **contract address** from step 1 as `CONTRACT_ADDRESS` below.

**Read state (get, no execution):**

```bash
cargo contract call --contract CONTRACT_ADDRESS --message get --suri //Alice
```

Omit `--execute` so it’s a dry-run / read-only call. You should see the current boolean value.

**Change state (flip, on-chain execution):**

```bash
cargo contract call --contract CONTRACT_ADDRESS --message flip --execute --suri //Alice
```

- `--execute` makes it a real transaction (costs fees, mutates state).
- Then call `get` again to see the value toggled.

---

## Summary

| Step        | Command |
|------------|--------|
| Build      | `cd ~/flipper && cargo contract build` |
| Instantiate| `cargo contract instantiate --url ws://127.0.0.1:9990 --suri //Alice --args true --skip-confirm --execute` |
| Read (get) | `cargo contract call --contract <ADDRESS> --message get --suri //Alice` |
| Mutate (flip) | `cargo contract call --contract <ADDRESS> --message flip --execute --suri //Alice` |

- Set `SUBSTRATE_URL` (or use `--url`) so the CLI talks to your node. Parachain RPC is usually **`ws://127.0.0.1:9990`**.
- Replace `//Alice` with another `--suri` if you use a different account.
- If you use **pallet-revive** instead of **pallet-contracts**, the same cargo-contract commands are typically used; ensure your chain is running and the RPC URL is correct.

### "Field weight_limit does not exist" when using `--skip-dry-run`

This chain uses **pallet-revive**, which names the call parameter **`weight_limit`**. The **cargo-contract** CLI is built for **pallet-contracts**, which uses **`gas_limit`**. When you use `--skip-dry-run --execute`, cargo-contract encodes the extrinsic with its internal struct (gas_limit) and the encoding fails because the chain metadata expects `weight_limit`.

**Workaround:** Instantiate (and optionally upload) via a UI that reads the chain metadata, so the correct field names are used:

- **Polkadot.js Apps:** Connect to **`ws://127.0.0.1:9990`** → **Developer** → **Contracts** → upload your `.contract` bundle (or use existing code hash) → **Instantiate** and set **weight limit** and **storage deposit limit**. For **calls** (see §3), use limits below block capacity (e.g. ref_time `1000000000000`, proof_size `2097152`).
- **Contracts UI:** [https://contracts-ui.substrate.io/](https://contracts-ui.substrate.io/) or [https://ui.use.ink](https://ui.use.ink) — set endpoint to **`ws://127.0.0.1:9990`**, then upload and instantiate; the form will show the correct parameters.

Once the contract is instantiated, **`cargo contract call`** for read-only (e.g. `get`) and for executed calls (e.g. `flip --execute`) may still work; if you see the same encoding error on `call`, use the same UI for calling.

### Version warning (cargo-contract 6.0.0-beta.2)

If you see: *"This version of cargo-contract is not compatible with the contract's ink! version. Please use cargo-contract in version '6.0.0-beta.1' or change the contract's ink! version to '>=6.0.0-beta.2'"* — you can ignore it for deploy/instantiate/call, or align versions:

- Use **cargo-contract 6.0.0-beta.1**: `cargo install --force --locked --version 6.0.0-beta.1 cargo-contract`
- Or upgrade the contract's **ink!** dependency to a version that supports cargo-contract `>=6.0.0-beta.2` (see [ink! releases](https://github.com/paritytech/ink/releases)).

---

## 3. Deploy and call via Contracts UI (recommended for pallet-revive)

This section documents the steps that work end-to-end for deploying the Flipper contract and calling `get` / `flip` on this parachain (pallet-revive, ink! 6).

### Prerequisites

- Parachain running: `./zombienet-spawn.sh my-content-rights.toml --provider native`
- Parachain RPC: **`ws://127.0.0.1:9990`**
- Built Flipper: `target/ink/flipper/flipper.contract` (from `cargo contract build --release` in your flipper directory)
- **Account:** Use an account that has balance. If you use a **browser extension account** (e.g. Polkadot.js):
  1. **Fund it:** In [Polkadot.js Apps](https://polkadot.js.org/apps/) connected to `ws://127.0.0.1:9990`, go to **Developer → Extrinsics** and submit **`balances::forceSetBalance`** (sudo): set **who** to your extension account and a large **new_free** balance.
  2. **Map the account:** Submit **`revive::mapAccount`** signed by your extension account. You must run **mapAccount again after each zombienet restart** (mapping is not persisted).

### Deploy (upload + instantiate)

You can deploy via the UI or via Extrinsics:

- **Contracts UI:** Open [Contracts UI](https://contracts-ui.substrate.io/) or [ui.use.ink](https://ui.use.ink), set endpoint to **`ws://127.0.0.1:9990`**. Use the flow to upload contract code (your `.contract` bundle) and instantiate. Note the **contract address** (instance address) after instantiation.
- **Extrinsics:** In Polkadot.js Apps → **Developer → Extrinsics**, submit **`revive::uploadCode`** (paste code hex from the built contract, set storage deposit limit), then **`revive::instantiate`** (code hash, constructor data, salt, storage deposit limit). Note the instantiated **contract address**.

### Add an existing contract in the UI

To interact with a contract you already deployed:

1. In Contracts UI, go to **Add New Contract** → **Add contract from address** (or equivalent).
2. Enter the **contract address** (the instance address, e.g. `0x2740...a7355`). Do **not** use "Look up code hash" for this—that field expects a **code hash**, not an instance address.
3. **Upload metadata:** In the "Upload Metadata" area, select or drag-and-drop your **`flipper.contract`** file (or the `.contract` file for that contract). This lets the UI show the contract messages (`get`, `flip`).
4. Optionally set a **Contract name** (e.g. "Flipper") and click **Add contract**.

### Call the contract

- **Read-only (`get`):** Select message **`get`**, choose your **Caller** account, and run the read. You should see the current boolean value.
- **State-changing (`flip`):** Select message **`flip`**, choose your **Caller** account. Set **RefTime Limit** and **ProofSize Limit** to values **below** the parachain block limits:
  - **RefTime Limit:** **`1000000000000`** (1 second). Do not use `2000000000000` for calls—the block only allows about 2 seconds total, so one extrinsic cannot claim the full block.
  - **ProofSize Limit:** **`2097152`** (2 MiB). Do not use `10485760` (10 MiB) for calls on this chain or you may hit block limits.
- Click **Call contract** and sign in the extension. Then call **`get`** again to confirm the value toggled.

### Troubleshooting

- **`1010: Invalid Transaction: Transaction would exhaust the block limits`** — You requested too much weight. Reduce **RefTime Limit** to `1000000000000` (or `500000000000`) and **ProofSize Limit** to `2097152` (or `1048576`) and try again. The **dry run** can still show success; the chain rejects the extrinsic when the *declared* weight exceeds block limits.
- **Red "call error" with no message** — Open the browser **Developer Tools** (F12) → **Console** and look for `RpcError: 1010` or "Transaction would exhaust the block limits". Reduce limits as above.
- **Transactions log** — In the Contracts UI it appears in the **right-hand panel**, below "Dry run outcome". Failed calls may not appear there; use the console for errors.
- **DispatchError or mapping errors** — Ensure your caller account has been mapped (**`revive::mapAccount`**) and has balance; run mapAccount again after each zombienet restart.
