# Commit summary: Zombienet + Polkadot workers (all under content-rights-parachain)

## What was done

### 1. Zombienet: fix @polkadot duplicate-version warnings

- **File:** `zombienet/javascript/package.json` (inside this repo, after moving zombienet here)
- **Change:** Add npm `overrides` so a single version of `@polkadot/util` and `@polkadot/util-crypto` is used (13.5.9), avoiding "multiple versions" warnings from nested deps.
- **Follow-up:** After moving zombienet in, run in `zombienet/javascript`: `rm -rf node_modules package-lock.json && npm install && npm run build`.

### 2. Zombienet spawn script (in repo root)

- **File:** `zombienet-spawn.sh`
- **Purpose:** Runs zombienet from this repo’s `zombienet/javascript` (with the overrides above). Expects `zombienet/` and `polkadot-sdk/` to live inside this repo.
- **Behavior:** Resolves the config path from where you run the script; then `cd`s to the **config file’s directory** (repo root) so relative paths in the config work; runs `node zombienet/javascript/packages/cli/dist/cli.js spawn ...`.
- **Usage (from repo root):** `./zombienet-spawn.sh my-content-rights.toml --provider native`

### 3. Relay + parachain config with relative paths

- **File:** `my-content-rights.toml`
- **Change:** Relay uses polkadot and workers from this repo’s `polkadot-sdk` build; all paths are relative to the config file’s directory (repo root):
  - `default_command = "polkadot-sdk/target/release/polkadot"`
  - `default_args` includes `"--workers-path", "polkadot-sdk/target/release"`
  - Parachain `command = "target/release/parachain-template-node"`

### 4. Documentation

- **POLKADOT-WORKERS-FIX.md:** Explains the worker-binaries error and two fixes (in-repo build vs install to `/usr/lib/polkadot`). Paths written for this repo layout.
- **COMMIT-SUMMARY.md:** This file.
- **MOVE-SETUP.md:** Steps to move zombienet and polkadot-sdk into this repo and optional .gitignore/submodule notes.

---

## Why use the script instead of `zombienet`?

Global `zombienet` uses its own `node_modules`, which can have duplicate `@polkadot/util` / `@polkadot/util-crypto` and trigger "multiple versions" warnings. The script runs the CLI from this repo’s `zombienet/javascript`, where we added npm overrides, so the warning is avoided.

---

## Suggested commit message

```
fix: zombienet + polkadot workers; move setup into repo

- add zombienet-spawn.sh (run zombienet from repo’s zombienet/javascript)
- my-content-rights.toml: relay from polkadot-sdk build, relative paths
- docs: POLKADOT-WORKERS-FIX.md, COMMIT-SUMMARY.md, MOVE-SETUP.md
- expect zombienet/ and polkadot-sdk/ inside repo (see MOVE-SETUP.md)
```

---

## Files touched (for staging)

- `zombienet-spawn.sh`
- `my-content-rights.toml`
- `POLKADOT-WORKERS-FIX.md`
- `COMMIT-SUMMARY.md`
- `MOVE-SETUP.md`
- `.gitignore` (optional entries for `zombienet/` and `polkadot-sdk/`)

After moving: `zombienet/javascript/package.json` (and optionally `package-lock.json`) if you track zombienet inside this repo.
