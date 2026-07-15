# Security Policy — TARX Desktop

**Product:** TARX Desktop  
**Company:** TARXAN Inc  
**Repository:** [tarx-ai/tarx-desktop](https://github.com/tarx-ai/tarx-desktop)

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.1.x (current Mac Beta) | Yes |
| < 1.1.0 | No — upgrade |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

1. Email **security@tarx.com** (preferred) with:
   - Product / version (`TARX.app` version or git tag)
   - Description and impact
   - Reproduction steps
   - Optional: PoC (no production customer data)
2. Or use GitHub **Private vulnerability reporting** on this repository if enabled.

We aim to acknowledge within **3 business days** and provide a status update within **10 business days**.

## Scope

In scope:

- TARX Desktop (Electron shell) signing, update feed, and local IPC/preload
- Auth deep links (`tarx://`) and session handling in the shell
- Unintended exposure of local Bridge / vault data via the Desktop app

Out of scope (report to the appropriate product surface):

- Hosted tarx.com application bugs that are not Desktop-specific
- Third-party dependencies without a Desktop impact
- Social engineering / phishing without a product flaw

## Disclosure

Please allow us to remediate before public disclosure. Coordinated disclosure preferred. We will credit reporters who want credit (no bounty program is guaranteed).

## Install trust (users)

Download only from [https://tarx.com/download](https://tarx.com/download) or [GitHub Releases](https://github.com/tarx-ai/tarx-desktop/releases).

```bash
shasum -a 256 TARX-*-arm64.dmg
codesign --verify --deep --strict --verbose=2 /Applications/TARX.app
spctl --assess --type execute -v /Applications/TARX.app
xcrun stapler validate /Applications/TARX.app
```

Expect Gatekeeper: `accepted` / `source=Notarized Developer ID`. Do not normalize “open anyway” bypasses as the supported install path.
