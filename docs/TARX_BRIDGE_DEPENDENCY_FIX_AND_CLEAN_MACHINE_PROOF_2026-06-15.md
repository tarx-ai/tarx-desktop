# TARX Bridge Dependency Fix And Clean Machine Proof - 2026-06-15

Status: `CANDIDATE FIX INSTALLED / CLEAN-MACHINE PROOF BLOCKED`

Gate: `launch-blocker-clean-install-bridge-missing-dependency-2026-06-15`

## Blocker Restatement

Fresh clean-machine install previously failed because the packaged TARX Bridge could not resolve `better-sqlite3-multiple-ciphers`, which prevented Track 1 heartbeat from firing and stopped the clean-install proof before hero evidence could be established.

## What Is Proven

- The native packaging guard is wired into the Electron release lane.
- The packaging QA script passes on the current packaged artifact in `dist/mac-arm64/TARX.app`.
- The lane now hard-aborts before publish if notarization credentials are missing.

## Evidence

Commands run in `/Users/master/Desktop/TARX/Repos - active/tarx-electron`:

```bash
bash -n scripts/ship.sh
node --test scripts/qa-electron-native-packaging.test.js
node scripts/qa-electron-native-packaging.js
```

Results:

- `bash -n scripts/ship.sh`: pass
- `node --test scripts/qa-electron-native-packaging.test.js`: pass, 5/5
- `node scripts/qa-electron-native-packaging.js`: pass

Packaging scan output:

- Scanned app bundle: `dist/mac-arm64/TARX.app`
- Native package: `better-sqlite3-multiple-ciphers`
- Packaged files present in `app.asar.unpacked`

Lane wiring proof:

- `scripts/ship.sh:205-242` runs the native packaging scan after build or `--skip-build`, before notarize/upload.
- `scripts/ship.sh:119-149` hard-aborts on missing notarization credentials or a missing `tarx` keychain item.
- `scripts/ship.sh:250-279` only reaches publish after the scan and notarization stage.

## Current Blockers

- Notarization credentials are not available in this shell: `security find-generic-password -s tarx -w` returns nonzero.
- Clean VM install proof has not been rerun from this shell.

## Verdict

Do **not** mark `DONE+PROVEN`.

This is the correct intermediate state:

- `CANDIDATE FIX INSTALLED`
- `CLEAN-MACHINE PROOF BLOCKED`

## Next Gate

`G-auto-update-recovery-clean-machine-canary` or the equivalent clean-machine proof rerun, once notarization credentials and a clean VM target are available.
