# TARX Desktop 1.1.12 — Release notes

**Product:** TARX Desktop  
**Company:** TARXAN Inc  
**Date:** 2026-07-15  
**Channel:** macOS Apple Silicon (signed + notarized when ship completes)

## Highlights

- **Boots agentic `/chat`** — no more landing on marketing `/home` via site root redirect
- **Auth magic-link** returns to `/chat`
- **Safe fallbacks** remap `/` and `/home` to the chat entry
- **Agentic contract flags** on preload (`page-executeToolCalls`, transfer contract ready)
- Public naming cleanup: **TARX Desktop** / **tarx-desktop**

## Install trust

| Check | Expectation |
|-------|-------------|
| Download page | Version, size, SHA-256, notarization copy |
| `spctl --assess` | Notarized Developer ID |
| Updater | `latest-mac.yml` matches shipped artifacts |

```bash
shasum -a 256 dist/TARX-1.1.12-arm64.dmg
spctl --assess --type execute -v dist/mac-arm64/TARX.app
```

## Upgrade notes

- Existing users: install 1.1.12 DMG or accept in-app update when feed is published
- Dev clones: `npm ci && npm run dev` — confirm URL ends with `/chat`

## Not in this release

- Windows Desktop public build
- Voice production open
- Screens browser root `/` → `/chat` (separate web PR; authorize production)
