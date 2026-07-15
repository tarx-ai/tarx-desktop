# TARX Desktop

**Local-first desktop app for TARX** — private AI that starts on your computer.

| | |
|---|---|
| **Product** | [TARX](https://tarx.com) |
| **Company** | [TARXAN Inc](https://tarx.com) |
| **App name** | TARX Desktop |
| **Repository** | `tarx-desktop` (legacy clone URL: `tarx-electron`) |
| **Platforms** | macOS (Apple Silicon) primary · Windows/Linux later |
| **Status** | Public Beta — signed & notarized macOS builds |

---

## What it is

TARX Desktop is the Mac app that runs your **Computer** runtime locally and loads the TARX chat surface (`/chat`) with the full agentic contract:

- Streaming chat (`streamTarxFromBrowser`)
- `TOOL_CALL` execution (todos, skills, health, handoffs)
- Local Bridge on CORE ports (inference, memory, tools)

Same product as [tarx.com/chat](https://tarx.com/chat) — with local runtime attached.

## Quickstart

### Install (end users)

1. Download from **[tarx.com/download](https://tarx.com/download)**
2. Open the DMG → drag **TARX** to Applications
3. First launch: if macOS prompts, **Control-click → Open** once (Gatekeeper)
4. Optional local runtime install:

```bash
curl -fsSL https://tarx.com/install | sh
```

### Verify install trust

On the download page you will find:

- **Version** and **file size**
- **SHA-256** of the macOS artifact
- Statement that the app + DMG are **Developer ID signed, notarized, and stapled**

Local check after download:

```bash
# Replace with the path to your downloaded DMG
shasum -a 256 ~/Downloads/TARX-*-arm64.dmg
# Compare to SHA-256 shown at https://tarx.com/download
```

Gatekeeper / notarization (after install):

```bash
spctl --assess --type execute -v /Applications/TARX.app
# expected: accepted (source=Notarized Developer ID)
```

### Develop from source

```bash
git clone https://github.com/tarx-ai/tarx-desktop.git
cd tarx-desktop
npm ci
npm run dev          # loads https://tarx.com/chat by default
```

Overrides:

```bash
TARX_DESKTOP_URL=https://tarx.com   # Screens origin
TARX_DESKTOP_ENTRY=/chat            # product entry path (default)
```

## Architecture

```
TARX Desktop (Electron shell)
  ├── preload flags (agentic contract)
  ├── tray · auto-update · Bridge bootstrap
  └── loads Screens → /chat
        ├── streamTarxFromBrowser
        └── executeToolCalls (skills · todos · health · transfer)
              └── Bridge :11440 · local Computer runtime
```

Desktop does **not** reimplement the agent loop. Screens owns chat + tools; Desktop owns the native shell and local runtime.

## Security

- **Signed** with Developer ID Application (TARXAN Inc / Apple team)
- **Notarized** via Apple notarytool; **stapled** tickets on app + DMG when shipped
- Hardened runtime + entitlements (`build/entitlements.mac.plist`)
- Local data stays on device by default; Supercomputer only with permission
- No secrets in TOOL_CALL payloads; Vault / control-plane product surfaces stay closed until gated open

## Status & roadmap

| Area | Status |
|------|--------|
| Chat + TOOL_CALL agentic loop | Live (Screens + Desktop entry `/chat`) |
| macOS Desktop signed download | Live |
| Windows / Linux Desktop | Not public yet |
| Voice production | Closed until chat FTUX solid |
| Enterprise private runtime | Design partners |

## Contribute

1. Open an issue describing the problem or proposal  
2. Branch from `main` (or current default until rename lands)  
3. Keep PRs small and product-scoped  
4. CI green required  
5. **Production / public download updates** need explicit human authorize  

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Naming

| Term | Use |
|------|-----|
| **TARXAN Inc** | Legal company |
| **TARX** | Product / brand |
| **TARX Desktop** | This application (user-facing) |
| **tarx-desktop** | This repository |
| **Screens** | Web product (`tarx-web` → tarx.com) |

## Links

- Product: [tarx.com](https://tarx.com)  
- Download: [tarx.com/download](https://tarx.com/download)  
- Docs: [docs.tarx.com](https://docs.tarx.com)  
- MCP: [mcp.tarx.com](https://mcp.tarx.com)  
- Org: [github.com/tarx-ai](https://github.com/tarx-ai)  

## License

UNLICENSED — proprietary (TARXAN Inc). Public source for transparency and design-partner collaboration; redistribution rights reserved.
