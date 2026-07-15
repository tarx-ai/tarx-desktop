# TARX Desktop (tarx-electron)

**The local-first desktop runtime for sovereign AI.**

Build and run AI applications that start on your computer, scale to hosted compute, and deploy onto enterprise-owned infrastructure — **without rewriting your application contract**.

> **Public name:** TARX Desktop (Mac-first for V1).  
> **Repo name:** `tarx-electron` (technical, cross-platform Electron shell).

## One Runtime. Three Execution Planes

- **Local (Computer)** — Runs directly on Mac/Windows/Linux with full privacy and offline capability.
- **Hosted (Supercomputer)** — Seamless burst to accelerated capacity when needed (permissioned).
- **Enterprise Private (BYO)** — Deploy onto your own hardware/appliances with full governance, observability, and control.

## Quickstart (5 minutes)

```bash
# Install TARX runtime (Computer)
curl -fsSL https://cli.tarx.com/install | sh

# From this repo (dev)
npm ci
npm run dev

# Or start packaged Desktop once built
# open dist/mac-arm64/TARX.app
```

See [docs.tarx.com](https://docs.tarx.com) for install and operations.

## Architecture

```
┌─────────────────────────────────────────────┐
│              TARX Desktop (Electron)        │
│  preload flags · bridge bootstrap · tray    │
└───────────────────┬─────────────────────────┘
                    │ loads Screens (web)
                    ▼
┌─────────────────────────────────────────────┐
│  tarx-web · /chat · streamTarxFromBrowser   │
│  executeToolCalls (skills / todos / health) │
└───────────────────┬─────────────────────────┘
                    │ localhost CORE ports
                    ▼
┌─────────────────────────────────────────────┐
│  Bridge :11440 · Inference · Embeddings     │
│  (control plane / cognitive / memory store  │
│   stay closed product surfaces)             │
└─────────────────────────────────────────────┘
```

**Desktop entry:** Electron loads `APP_ENTRY_PATH` (`/chat` by default), not site root.  
(`https://tarx.com/` still 307s to marketing `/home` on Screens — Desktop deliberately bypasses that.)

Override with `TARX_DESKTOP_ENTRY` or `TARX_DESKTOP_URL` when needed.

Core principles:

- **Local-first** by default
- **Portable** across planes
- **Sovereign** — you control data, models, providers, and policy
- **Operational** — self-healing, evidence-based, observable
- **One chat contract** — Desktop does not reimplement agentic loops; Screens `/chat` owns `streamTarxFromBrowser` + `executeToolCalls`

## Current Maturity

- **Alpha → Beta** — Conversational flow, skills, MCP tool calling, and Electron stability in active hardening.
- Platforms: Mac (primary), Windows/Linux coming.
- Status: Actively developed with automated CI/CD and TARX agent orchestration.
- Voice production remains **closed** until FTUX + chat loops are solid.

## Roadmap

- Q3 2026: Stable V1 conversational loops + skills ecosystem
- Q4 2026: Cross-platform + appliance deployment
- 2027: Full open TARX-OS weights + enterprise private runtime

## Security Model

- Memory boundaries and Vault for secrets
- User-approved skills and external calls
- Evidence logging for all actions
- SBOM and signed releases (in progress)

## Contribution

See [CONTRIBUTING.md](CONTRIBUTING.md) when present. We welcome issues, PRs, and design partners. All activity is driven by real product work + TARX automation.

**Merge rule:** isolated branch → CI green → human `authorize production` before release.

## Changelog

See [Releases](https://github.com/tarx-ai/tarx-electron/releases) for detailed history.
