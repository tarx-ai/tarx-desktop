# Contributing to TARX Desktop (`tarx-electron`)

## Public vs technical name

- **Public:** TARX Desktop  
- **Repo:** `tarx-electron`

## Basics

- Prefer small PRs: shell stability, preload contracts, packaging  
- Node **22** · **npm ci**  
- Do not reimplement Screens chat/tool loops here  

## Contract with Screens

Preload must expose:

- `__TARX_DESKTOP__` with `isElectron: true`  
- `__TARX_ELECTRON__`  
- `chatStreamContract: 'web-shared-v1'`  

Chat agentic execution remains in **tarx-web**.

## Production / releases

Signed builds and production release channels require:

```text
authorize production
```

Voice production remains **closed** until product FTUX + chat loops are solid.
