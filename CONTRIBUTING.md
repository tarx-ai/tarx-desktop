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
node scripts/qa-desktop-computer-entry-smoke.js
npm run qa:electron-release-stability   # when packaging
```

4. Open a PR with what/why and verification commands.
5. Do **not** publish production download artifacts without human **authorize production**.

## Desktop surface rule

The default product shell is **`https://app.tarx.com/computer`**. Marketing
`tarx.com` opens outside Desktop, while `/chat` remains an explicit focused
task surface. See `PRIMARY_URL`, `APP_ENTRY_PATH`, and `CHAT_ENTRY_PATH` in
`electron/main.js`.

## Security

Never commit Apple notarization secrets, API keys, or customer data.
