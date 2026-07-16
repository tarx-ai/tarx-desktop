# P0 Local Memory, Processes, and Generated Storage Audit

**Status:** DRAFT — measurements on founder Mac + code root-cause  
**Date:** 2026-07-16  
**PR title:** `fix(desktop): bound local memory, processes, and generated storage`

## 1. Measured snapshot (founder Mac, 2026-07-16)

| Metric | Value | Notes |
|--------|-------|-------|
| Free disk before prior cleanup | ~213 MiB | System nearly full |
| Generated `dataset-*.jsonl` before cleanup | ~145 GiB / ~1058 files | Under `~/.tarx/finetune/` |
| Free disk after cleanup | ~156 GiB | Duplicate datasets removed (kept newest 5) |
| TARX-related process RSS (this audit) | **~4.3 GiB total** (27 related processes) | Not a proven “leak”; includes loaded models |
| Largest single process | `llama-server` Nemotron ~**2.9 GiB RSS** | Model weights in RAM, expected if loaded |
| TARX Electron | **two** processes ~330–350 MiB each | Single-instance lock exists; second may be helper/renderer host |
| Duplicate exports | **pairs written same second, identical size** | e.g. `dataset-1784215746905` and `...924` both 167339833 bytes at 11:29 |

**Do not claim a memory leak** without a controlled soak proving unbounded growth independent of loaded models.

## 2. Code path that creates `dataset-*.jsonl`

| Path | Module | Mechanism |
|------|--------|-----------|
| **Primary** | `tarx-ops` `src/workers/training-watcher.ts` → `exportStagedPairs()` | `writeFileSync(.../dataset-${Date.now()}.jsonl)` |
| Bundled | `dist/bridge.js` / `dist/bridge-full.js` | Same logic after esbuild |
| Entry | `src/bridge.ts` calls `startTrainingWatcher()` | Every Bridge process starts the watcher |
| Interval | `CHECK_INTERVAL = 30 * 60 * 1000` | Plus first run after 60s |
| Trigger | `countStagedPairs() >= 50` OR nightly window | Reads `conversation_evals.staged_for_finetune=1` |

No other writers found outside tarx-ops Bridge builds and backups.

## 3. Ranked causes of duplicate dataset generation

| Rank | Cause | Evidence |
|------|-------|----------|
| **1** | **Timestamp filenames always unique** (`Date.now()`) | Every export creates a new file even if content identical |
| **2** | **`staged_for_finetune` never cleared** for `conversation_evals` after export | Same ~54k pairs re-exported every 30 minutes forever |
| **3** | **Multiple Bridge/watcher owners** | Dual writes same second with identical byte size; dual `tarx-channel` PIDs historically; multiple supervisor scripts |
| **4** | Auto train + export without quotas | Unbounded disk until host full |

## 4. Process inventory (types)

Observed TARX-related roles:

- Desktop app (`TARX` Electron)
- `llama-server` (computer + embed + optional ports)
- `whisper-server`
- `tarx-ops` channel / bridge
- `tarx-core`
- cloudflared tunnel
- legacy supervisors under `Documents/New project/_desktop/...` and `Desktop/TARX/Repos - active/...`
- training-watcher loop **inside** Bridge (not a separate process name)

## 5. Controls added in this PR (desktop)

| Control | Location |
|---------|----------|
| Generated storage snapshot + retention (dataset-*.jsonl only) | `electron/generated-storage.js` |
| Resource snapshot: RSS, models, duplicates, disk, plane | `electron/resource-guard.js` |
| IPC: `tarx:resource-snapshot`, pressure apply, storage enforce | `electron/main.js` |
| Retention on quit | `before-quit` → `enforceDatasetRetention` |
| Existing single-instance Electron lock | `requestSingleInstanceLock` (already present) |
| Configurable soak harness | `scripts/qa-local-resource-soak.js` |
| Unit tests for retention/dedup helpers | `scripts/qa-generated-storage-contract.js` |

## 6. Controls added in installed runtime (`tarx-ops` training-watcher)

| Control | Behavior |
|---------|----------|
| Content-hash filenames | `dataset-{sha256_16}.jsonl` |
| Dedup skip | Identical hash → no new file |
| Clear staged flags | `UPDATE conversation_evals SET staged_for_finetune=0` after export |
| Watcher lock file | `~/.tarx/finetune/training-watcher.lock` by PID |
| In-process single start | `watcherStarted` guard |
| Auto fine-tune **off by default** | Requires `TARX_ENABLE_AUTO_FINETUNE=1` |
| Retention | max files (default 5), max bytes (default 2 GiB), warn 1 GiB |
| Atomic writes | temp + rename |
| Never deletes | model weights, Vault, primary DBs |

## 7. Memory-pressure policy (safe)

On warn/critical:

- pause optional background jobs (flag/actions list)
- reject new heavy jobs (policy signal)
- enforce **generated dataset** retention only
- recommend unload of unused models (no automatic kill of active inference without operator)

## 8. Residual risks

- Legacy supervisor scripts outside Desktop may still spawn duplicate runtimes.
- `llama-server` memory is model-size-dominated; reducing requires unload/policy, not just Desktop GC.
- Electron dual process may be normal (main+GPU/helper); needs labeled inventory, not forced kill.
- tarx-ops fix must be deployed to the running Bridge for full effect (rebuild `dist/bridge.js` applied locally).

## 9. Founder decisions

1. Keep `TARX_ENABLE_AUTO_FINETUNE` default **off**? (recommended yes)  
2. Auto-unload cold models under critical pressure? (default: recommend only)  
3. Kill legacy `Documents/New project/_desktop` supervisors on Desktop launch?  
