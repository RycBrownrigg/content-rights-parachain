# What to Do Next: Run the Chain and Deploy Flipper

You’ve built the parachain node. To run the chain and deploy/call the Flipper contract, follow this order.

---

## 1. Build the relay chain (polkadot) once

The parachain needs a local relay. Build it from the **polkadot-sdk** in this repo (it has `rococo-native`):

```bash
cd /home/ryc/content-rights-parachain/polkadot-sdk
cargo build --release -p polkadot
```

This can take a while. You only need to do it once (or after an SDK update).

---

## 2. Start the network with Zombienet

From the **repo root**:

```bash
cd /home/ryc/content-rights-parachain
./zombienet-spawn.sh my-content-rights.toml --provider native
```

- Wait until you see blocks being produced (e.g. “Imported #…” in the logs).
- The **parachain** (where the Contracts pallet runs) is on **`ws://127.0.0.1:9990`** (see `my-content-rights.toml`).
- Leave this terminal running.

---

## 3. Deploy the Flipper contract

In a **new terminal**, from your flipper project:

```bash
cd ~/flipper
export SUBSTRATE_URL=ws://127.0.0.1:9990
cargo contract instantiate --suri //Alice --args true
```

- Copy the **contract address** from the output.

---

## 4. Call the contract

Use the address from step 3 as `CONTRACT_ADDRESS`.

**Read (get):**
```bash
cargo contract call --contract CONTRACT_ADDRESS --message get --suri //Alice
```

**Mutate (flip):**
```bash
cargo contract call --contract CONTRACT_ADDRESS --message flip --execute --suri //Alice
```

Then run `get` again to see the value change.

---

## Quick reference

| Step | Command / URL |
|------|----------------|
| Build relay | `cd polkadot-sdk && cargo build --release -p polkadot` |
| Start network | `./zombienet-spawn.sh my-content-rights.toml --provider native` |
| Parachain RPC | `ws://127.0.0.1:9990` |
| Deploy | `SUBSTRATE_URL=ws://127.0.0.1:9990 cargo contract instantiate --suri //Alice --args true` |
| Call get | `cargo contract call --contract <ADDRESS> --message get --suri //Alice` |
| Call flip | `cargo contract call --contract <ADDRESS> --message flip --execute --suri //Alice` |

---

## Optional: Polkadot.js Apps

- Open https://polkadot.js.org/apps
- Connect to **Local Node** and set the endpoint to **`ws://127.0.0.1:9990`** (the parachain).
- You can inspect Chain State, Contracts, and extrinsics there.

If anything fails (e.g. “connection refused”), ensure zombienet is still running and that you’re using port **9990** (parachain), not 9944 (relay).
