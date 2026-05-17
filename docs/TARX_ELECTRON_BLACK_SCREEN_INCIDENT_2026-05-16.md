# TARX Electron Black Screen Incident - 2026-05-16

## Incident Summary

| Field | Value |
| --- | --- |
| Machine | Skynet |
| Trigger | Clicked `Refresh TARX` |
| Observed behavior | Electron window became a black screen. |
| Manual recovery | Quit/restart app; app fired back up. |
| Current status | RECOVERED / ROOT CAUSE UNKNOWN |
| Release impact | RECOVERY GATE GREEN; NORMAL SIGNED-BUILD RELEASE GATES STILL APPLY |

## Suspected Causes

- Renderer refresh hung before the app reported a ready state.
- Renderer process crashed or became unresponsive without a safe-shell fallback.
- Route restore after refresh may have attempted a route that could not render cleanly.
- Bridge/runtime availability may have influenced the loaded surface, but this is not proven.
- Voice/Local Operator initialization is not proven causal and must not be changed unless evidence points there.

## Evidence Locations

- Incident evidence: `/Users/master/.tarx/runs/electron-black-screen-incident/latest.json`
- Recovery QA: `/Users/master/.tarx/runs/electron-black-screen-recovery/latest.json`
- Release stability QA: `/Users/master/.tarx/runs/electron-release-stability/latest.json`
- Electron diagnostics: `~/Library/Application Support/TARX/diagnostics` or `~/Library/Application Support/tarx-desktop/diagnostics`
- macOS crash reports: `~/Library/Logs/DiagnosticReports`
- TARX logs, if present: `~/Library/Logs/TARX` or `~/Library/Logs/tarx-desktop`

## Recovery Hardening Added

- `Refresh TARX` now stores the previous route before refresh.
- Renderer ready heartbeat is armed after refresh/navigation.
- Renderer sends ready signals from preload after DOM/content load.
- Main process watches `did-fail-load`, `render-process-gone`, and `unresponsive`.
- If the renderer fails to report ready, TARX shows a minimal safe shell instead of staying black.
- Safe shell actions: Reload, Restart app, Open safe mode, Copy diagnostics, Open logs, Quit.
- `TARX_SAFE_MODE=1` / `--tarx-safe-mode` boots to a safe shell and skips runtime-dependent boot work.

## Current Release Decision

Recovery hardening is green after:

```bash
npm run qa:electron-black-screen-recovery
npm run qa:electron-release-stability
```

Root cause remains unknown. Treat this as a recovered P0 with a hardened recovery path, not proof that the original Skynet failure mode was causally fixed. Public shipment still needs the normal signed-build, notarization, and target-machine smoke gates.
