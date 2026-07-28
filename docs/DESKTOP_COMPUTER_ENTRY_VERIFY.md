# Desktop Computer entry verification

Computer is the canonical Desktop shell. Chat is a focused task surface inside
the product, not the application entry contract.

## What Desktop loads

| Path | Behavior |
|------|----------|
| Boot | `appEntryUrl(PRIMARY_URL)` → `https://app.tarx.com/computer` |
| Local Bridge fallback | Runtime health remains on `http://localhost:11440` |
| Auth magic-link | `callbackUrl=/computer` then recover to `/computer` |
| Safe fallback / refresh | Remaps `/` and `/home` → `/computer` |
| Composer | `https://app.tarx.com/chat` |
| Preferences | `/settings` (intentional) |

**Task stack** (page-owned, not reimplemented in Electron):

- `streamTarxFromBrowser` + `executeToolCalls` on Screens `/chat` (#37)
- TOOL_CALL: todos, skills, health (+ transfer when web #39 lands)
- Events: `tarx:todo-changed`, `tarx:skill-used`, `tarx:health-refreshed`, `tarx:tool-calls-finished`
- Preload: `chatStreamContract=web-shared-v1`, `agenticTools=page-executeToolCalls`, `agentTransferContract=api-agentic-transfer-v1`

## Verification commands

```bash
# 1) Source contract
rg "PRIMARY_URL|APP_ENTRY_PATH|CHAT_ENTRY_PATH" electron/main.js

# 2) Navigation QA (must be green)
node scripts/qa-electron-navigation-boundary.js
# expect: electron_navigation_boundary_green

# 3) Product surfaces live
curl -s -o /dev/null -w "%{http_code}\n" https://app.tarx.com/computer    # 200
curl -s -o /dev/null -w "%{http_code}\n" https://app.tarx.com/chat        # 200
curl -s -o /dev/null -w "%{http_code}\n" https://app.tarx.com/api/version # 200
curl -s -o /dev/null -w "%{http_code}\n" https://tarx.com/                 # 200 marketing

# 4) Bridge (local CORE)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:11440/health  # 200 when runtime up

# 5) Full static/live route smoke
node scripts/qa-desktop-computer-entry-smoke.js

# 6) Dev Desktop boot
npm ci && npm run dev
# Main window → https://app.tarx.com/computer
# Floating composer → https://app.tarx.com/chat
# window.__TARX_DESKTOP__.agenticTools === 'page-executeToolCalls'
# window.__TARX_DESKTOP__.agentTransferContract === 'api-agentic-transfer-v1'
```

## Remaining edge cases (not Desktop bugs)

| Edge | Notes |
|------|-------|
| Marketing `tarx.com` | Opens outside Desktop; it is not an allowed product-app origin |
| Packaged app not rebuilt | A new Desktop build is required for existing users |
| Bridge offline | `/computer` loads and reports the local connection state |
| Unauth session | `/computer` and `/chat` load; some tools may require sign-in |
| A2A transfer tool | Web #39 not on prod yet; preload flag ready |
| `TARX_DESKTOP_URL` override | `APP_ENTRY_PATH` is appended to the configured base |
| Local web shell absent | Bridge health alone does not imply a local renderer is available |

## Master todo (updated)

- [x] Desktop boots `app.tarx.com/computer`
- [x] Marketing origin removed from the in-app allowlist
- [x] Remap `/` + `/home` in fallbacks/refresh
- [x] Auth callback → `/computer`
- [x] Focused composer remains `/chat`
- [x] Preload agentic + transfer contract flags
- [x] Navigation-boundary QA green
- [ ] **Ship Desktop binary** after explicit production authorization
- [ ] Signed-in smoke: TOOL_CALL todo + skill + health in Desktop
- [ ] Promote `app.tarx.com` root redirect from `/chat` to `/computer`
