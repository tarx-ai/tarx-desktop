# TARX Desktop (`tarx-electron`)

**The local-first desktop shell for sovereign AI.**

Public product name: **TARX Desktop** (Mac-first for V1).  
Technical repo name: **`tarx-electron`** (cross-platform Electron packaging).

Loads **TARX Screens** ([tarx-web](https://github.com/tarx-ai/tarx-web)) and bootstraps the local Bridge runtime so chat, tools, and skills use **one application contract** — no dual client.

## One runtime. Three execution planes

- **Computer (local)** — Private default on Mac (Windows/Linux next).  
- **Supercomputer** — Permissioned headroom when approved.  
- **Enterprise / Machines** — Sovereign nodes you own; see [tarx.com/machines](https://tarx.com/machines).

## Quickstart (5 minutes)

```bash
# End-user runtime install
curl -fsSL https://cli.tarx.com/install | sh

# Developer: this repo
git clone git@github.com:tarx-ai/tarx-electron.git
cd tarx-electron
nvm use   # Node 22 — see .nvmrc
npm ci
npm run dev
```

Packaged app (after build): `dist/mac-arm64/TARX.app` (product name **TARX**).

Screens URL defaults to `https://tarx.com` (override with `TARX_DESKTOP_URL` for local Screens).

## Architecture

```
┌──────────────────────────────────────────────┐
│           TARX Desktop (Electron)            │
│  preload · bridge bootstrap · tray · updates │
└────────────────────┬─────────────────────────┘
                     │ loads Screens
                     ▼
┌──────────────────────────────────────────────┐
│  tarx-web · /chat                            │
│  streamTarxFromBrowser + executeToolCalls    │
└────────────────────┬─────────────────────────┘
                     │ localhost CORE
                     ▼
┌──────────────────────────────────────────────┐
│  Bridge :11440 · Inference · Embeddings      │
│  Closed: control plane, cognitive product,   │
│  memory store, Super multi-node, prod voice  │
└──────────────────────────────────────────────┘
```

**Contract:** Desktop exposes `__TARX_DESKTOP__` / `__TARX_ELECTRON__` and  
`chatStreamContract: 'web-shared-v1'`. It does **not** reimplement TOOL_CALL execution.

## Maturity

| Area | Status |
|------|--------|
| Mac shell + Bridge bootstrap | **Beta** |
| Shared Screens agentic chat | **Beta** (depends on tarx-web main) |
| Windows / Linux | Coming |
| Production voice | **Closed** until FTUX + chat loops are solid |
| Signed releases / notarize | In progress (see workflows) |

## Roadmap

- **Q3 2026:** Stable V1 conversational loops via Screens  
- **Q4 2026:** Cross-platform Desktop + appliance pairing  
- **2027:** Deeper enterprise private runtime + open beachheads  

## Security

- Secrets in Vault; skills and external calls user-approved  
- Evidence-oriented local operator paths (feature-flagged)  
- SBOM + signed releases (in progress)  
- Do not open control-plane product surfaces from this shell  

## Contribution

1. Branch from the default integration branch (moving toward `main`)  
2. `npm ci` · Node 22  
3. PR · CI green (preload contract + syntax)  
4. Release / production packaging only with **`authorize production`**

```bash
npm run dev
npm run build
# CI: .github/workflows/ci.yml + voice-beta packaging workflows
```

## Naming

| Public | Technical |
|--------|-----------|
| TARX Desktop | `tarx-electron` |
| TARX Screens | `tarx-web` |
| TARX (app binary) | productName in Electron build |

## Related

- Product web: https://github.com/tarx-ai/tarx-web  
- CLI: https://github.com/tarx-ai/tarx-cli  
- Open beachheads: [tarx-palantir](https://github.com/tarx-ai/tarx-palantir) · [tarx-weights](https://github.com/tarx-ai/tarx-weights)  
- Site: https://tarx.com · Contact: howdy@tarx.com  

## Releases

https://github.com/tarx-ai/tarx-electron/releases  
