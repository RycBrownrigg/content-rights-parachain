# Deploy and Call the Flipper Contract

Use this after you have built the ink! 6 Flipper with `cargo contract build` in `~/flipper`.

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
   Note the RPC URL (e.g. `ws://127.0.0.1:9944` or the port your node uses).

3. **Connection for cargo-contract**  
   Point the CLI at your node. Common options:
   - **Environment:** `export SUBSTRATE_URL=ws://127.0.0.1:9944`
   - **Flag:** many commands support `--url ws://127.0.0.1:9944`  
   Replace the port if your node uses a different one (e.g. 9945).

4. **Account**  
   Use an account that has balance on the chain (e.g. `//Alice` in dev).  
   `--suri //Alice` is the usual dev choice.

---

## 1. Deploy (upload + instantiate)

From the **flipper** directory:

```bash
cd ~/flipper
export SUBSTRATE_URL=ws://127.0.0.1:9944   # or your node’s WebSocket URL

cargo contract instantiate --suri //Alice --args true
```

- `--args true` is the Flipper constructor argument (initial value of the flip).
- This uploads the contract code and creates one instance in a single flow (cargo-contract 6 style).
- The command prints the **contract address** (AccountId). Copy it for the next step.

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
| Instantiate| `cargo contract instantiate --suri //Alice --args true` |
| Read (get) | `cargo contract call --contract <ADDRESS> --message get --suri //Alice` |
| Mutate (flip) | `cargo contract call --contract <ADDRESS> --message flip --execute --suri //Alice` |

- Set `SUBSTRATE_URL` (or use `--url`) so the CLI talks to your node.
- Replace `//Alice` with another `--suri` if you use a different account.
- If you use **pallet-revive** instead of **pallet-contracts**, the same cargo-contract commands are typically used; ensure your chain is running and the RPC URL is correct.
