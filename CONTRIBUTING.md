# Contributing to TARX Desktop

Thanks for helping polish TARX Desktop.

## Naming

- Company: **TARXAN Inc**
- Product: **TARX**
- App: **TARX Desktop**
- Repo: **tarx-desktop**

## Workflow

1. Fork or branch from the default branch (`main` preferred).
2. Keep changes focused (entry path, shell, docs, packaging — not Screens product logic).
3. Run checks:

```bash
node scripts/qa-electron-navigation-boundary.js
node scripts/qa-desktop-agentic-chat-smoke.js
npm run qa:electron-release-stability   # when packaging
```

4. Open a PR with what/why and verification commands.
5. Do **not** publish production download artifacts without human **authorize production**.

## Desktop entry rule

Default product surface is **`/chat`**, not marketing `/home`.  
See `APP_ENTRY_PATH` in `electron/main.js`.

## Security

Never commit Apple notarization secrets, API keys, or customer data.
