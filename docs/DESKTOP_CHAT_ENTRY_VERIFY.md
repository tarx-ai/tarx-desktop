# Desktop /chat entry — post-#3 verification

**Merged:** PR #3 → default `codex/tarx-electron-voice-setup-source-kill-v1` (`a294b63`)

## What Desktop loads

| Path | Behavior |
|------|----------|
| Boot | `appEntryUrl(PRIMARY_URL)` → `https://tarx.com/chat` |
| Local Bridge fallback | `http://localhost:11440/chat` |
| Auth magic-link | `callbackUrl=/chat` then recover to `/chat` |
| Safe fallback / refresh | Remaps `/` and `/home` → `/chat` |
| Composer | `/chat` |
| Preferences | `/settings` (intentional) |

**Agentic stack** (page-owned, not reimplemented in Electron):

- `streamTarxFromBrowser` + `executeToolCalls` on Screens `/chat` (#37)
- TOOL_CALL: todos, skills, health (+ transfer when web #39 lands)
- Events: `tarx:todo-changed`, `tarx:skill-used`, `tarx:health-refreshed`, `tarx:tool-calls-finished`
- Preload: `chatStreamContract=web-shared-v1`, `agenticTools=page-executeToolCalls`, `agentTransferContract=api-agentic-transfer-v1`

## Verification commands

```bash
# 1) Default branch has entry contract
cd tarx-electron && git fetch origin
git show origin/codex/tarx-electron-voice-setup-source-kill-v1:electron/main.js \
  | rg "APP_ENTRY_PATH|appEntryUrl\\(PRIMARY_URL\\)|pathname === '/home'"

# 2) Navigation QA (must be green)
node scripts/qa-electron-navigation-boundary.js
# expect: electron_navigation_boundary_green, 12 passed

# 3) Screens agentic surface live
curl -sI https://tarx.com/chat | head -5          # 200
curl -sI https://tarx.com/ | rg -i location       # location: /home (marketing; Desktop bypasses)
curl -s -o /dev/null -w "%{http_code}\n" https://tarx.com/api/version  # 200

# 4) Bridge (local CORE)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:11440/health  # 200 when runtime up

# 5) Dev Desktop boot
npm ci && npm run dev
# DevTools → location should be …/chat not …/home
# window.__TARX_DESKTOP__.agenticTools === 'page-executeToolCalls'
# window.__TARX_DESKTOP__.agentTransferContract === 'api-agentic-transfer-v1'
```

## Remaining edge cases (not Desktop bugs)

| Edge | Notes |
|------|-------|
| Screens `/` → `/home` | Marketing product decision; Desktop never loads `/` as entry |
| Nav shell "Home" → `/home` | User can navigate in-app to marketing home; remap only on boot/fallback |
| Packaged app not rebuilt | Need new Desktop build/release to pick up #3 for end users |
| Bridge offline | `/chat` still loads; Runtime strip shows offline; skills needing Bridge fail gracefully |
| Unauth session | `/chat` works; some tools 401 — expected |
| A2A transfer tool | Web #39 not on prod yet; preload flag ready |
| `TARX_DESKTOP_URL` override | If set to a path without `/chat`, APP_ENTRY still appends `/chat` |
| Local fallback without Screens `/chat` | Bridge-only may 404 `/chat` if not serving Screens — rare |

## Master todo (updated)

- [x] #3 merge — Desktop boots `/chat`
- [x] Remap `/` + `/home` in fallbacks/refresh
- [x] Auth callback → `/chat`
- [x] Preload agentic + transfer contract flags
- [x] Navigation-boundary QA green
- [ ] **Ship Desktop binary** (pack/notarize) so users leave pre-#3 builds
- [ ] Signed-in smoke: TOOL_CALL todo + skill + health in Desktop
- [ ] Merge/deploy web A2A #39 when authorized
- [ ] Optional: Screens root `/` → `/chat` for browsers (product authorize)
- [ ] Optional: in-app nav demote `/home` or redirect Desktop user-agent to `/chat`
