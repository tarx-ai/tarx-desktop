# TARX Electron Release Stability

Updated: 2026-05-17

## Current Status

| Area | Status |
| --- | --- |
| Electron Black Screen Incident | RECOVERED / ROOT CAUSE UNKNOWN |
| Refresh TARX | RECOVERY QA GREEN |
| Public Electron Release | RELEASE STABILITY GREEN FOR BLACK-SCREEN RECOVERY GATE |
| Internal development | ALLOWED |
| Feature merges | ALLOWED ONLY IF they do not touch refresh/boot path or release stability QA passes afterward |

## Required Release Gates

Run:

```bash
npm run qa:electron-black-screen-recovery
npm run qa:electron-release-stability
```

Evidence:

- `/Users/master/.tarx/runs/electron-black-screen-incident/latest.json`
- `/Users/master/.tarx/runs/electron-black-screen-recovery/latest.json`
- `/Users/master/.tarx/runs/electron-release-stability/latest.json`

## Recovery Contract

- Refresh must not leave a black screen.
- Previous route is recorded before refresh.
- Renderer ready heartbeat starts after refresh/navigation.
- Renderer load timeout shows safe shell.
- Renderer crash/unresponsive/failed-load shows safe shell or restores fallback.
- Safe shell does not depend on Bridge, Voice, Operating Brief, or web app data.
- Safe mode preserves user data and bypasses runtime-dependent panels.
- Supercomputer remains off.
- Computer Use execution remains disabled.
- Production voice remains blocked.

## Safe Shell

Safe shell shows:

- TARX
- "The workspace failed to load."
- Reload
- Restart app
- Open safe mode
- Copy diagnostics
- Open logs
- Quit
- app version/build
- last route attempted
- first error if known

## Safe Mode

`TARX_SAFE_MODE=1` or `--tarx-safe-mode`:

- bypasses last route restore
- bypasses Bridge startup during boot
- bypasses Local Operator / Voice / MediaDevices initialization
- boots into the minimal safe shell
- preserves user data
- exposes diagnostics

## Release Recommendation

Current recommendation: **RELEASE STABILITY GREEN**

The black-screen recovery gate is green, but the original root cause remains unknown. Treat this as a hardened recovery path, not proof that the original Skynet trigger was causally fixed. Public Electron release still needs the normal signed-build, notarization, and target-machine smoke gates before shipment.
