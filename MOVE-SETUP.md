# Moving zombienet and polkadot-sdk into this repo

All local dev (zombienet, polkadot relay build, config, script) is set up so everything lives under **content-rights-parachain**. Do the following once.

## 1. Move the directories

From your home (or wherever they are now):

```bash
mv /home/ryc/zombienet /home/ryc/content-rights-parachain/
mv /home/ryc/polkadot-sdk /home/ryc/content-rights-parachain/
```

Or clone them if you don’t have them locally:

```bash
cd /home/ryc/content-rights-parachain
git clone https://github.com/paritytech/zombienet.git
git clone https://github.com/paritytech/polkadot-sdk.git
```

## 2. Apply zombienet overrides (if not already done)

The zombienet in your home already had npm overrides in `zombienet/javascript/package.json`. After moving, that file is at `content-rights-parachain/zombienet/javascript/package.json`. Ensure it contains:

```json
"overrides": {
  "@polkadot/util": "13.5.9",
  "@polkadot/util-crypto": "13.5.9"
}
```

Then reinstall and build:

```bash
cd zombienet/javascript
rm -rf node_modules package-lock.json
npm install
npm run build
cd ../..
```

## 3. Build polkadot (relay + workers)

```bash
cd polkadot-sdk
cargo build --release -p polkadot
cd ..
```

## 4. Run zombienet

From the repo root:

```bash
./zombienet-spawn.sh my-content-rights.toml --provider native
```

Paths in `my-content-rights.toml` are relative to the repo root (directory of the config file).

---

## Git: ignore or submodule?

- **Ignore:** If you don’t want to commit the full `zombienet` and `polkadot-sdk` trees, add to `.gitignore`:

  ```
  /zombienet/
  /polkadot-sdk/
  ```

  Then anyone cloning the repo would clone or copy those two repos themselves (see above).

- **Submodules:** To track specific commits and keep history separate:

  ```bash
  git submodule add https://github.com/paritytech/zombienet.git zombienet
  git submodule add https://github.com/paritytech/polkadot-sdk.git polkadot-sdk
  ```

  After `git submodule update --init`, apply the overrides in `zombienet/javascript` and build as in steps 2 and 3.

---

## Agent / .cursor

If you use an agent or Cursor rules in this repo, they are unaffected: they live under `content-rights-parachain` (e.g. `.cursor/`, `.cursorrules`). The new files (`zombienet-spawn.sh`, `my-content-rights.toml`, docs) are just more files in the same repo. Adding `zombienet/` and `polkadot-sdk/` (or as submodules) doesn’t change how the agent sees the project unless you add rules that reference those paths.
