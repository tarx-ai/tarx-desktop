#!/usr/bin/env node
/**
 * Configurable local resource soak (no model download, no finetune, no production deploy).
 *
 * Usage:
 *   node scripts/qa-local-resource-soak.js
 *   TARX_SOAK_SECONDS=30 node scripts/qa-local-resource-soak.js
 */
'use strict'

const { snapshotResources, applyMemoryPressurePolicy } = require('../electron/resource-guard')
const { enforceDatasetRetention, snapshotGeneratedStorage } = require('../electron/generated-storage')

const SECONDS = Number(process.env.TARX_SOAK_SECONDS || 15)
const INTERVAL_MS = Number(process.env.TARX_SOAK_INTERVAL_MS || 3000)

async function main() {
  const samples = []
  const end = Date.now() + SECONDS * 1000
  console.log(JSON.stringify({ event: 'soak_start', seconds: SECONDS, interval_ms: INTERVAL_MS }, null, 2))

  // Launch-adjacent: retention enforce + baseline
  const retention = enforceDatasetRetention()
  samples.push({ t: Date.now(), kind: 'baseline', retention, snap: snapshotResources() })

  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
    const snap = snapshotResources()
    const pressure = applyMemoryPressurePolicy(snap)
    samples.push({
      t: Date.now(),
      kind: 'tick',
      rss_bytes: snap.tarx.rss_bytes,
      process_count: snap.tarx.process_count,
      pressure: snap.tarx.pressure,
      actions: pressure.actions,
      dataset_bytes: snap.generated_storage.datasets.bytes,
      dataset_files: snap.generated_storage.datasets.files,
      free_bytes: snap.host.free_bytes,
    })
  }

  const first = samples[0]?.snap?.tarx?.rss_bytes ?? 0
  const last = samples[samples.length - 1]?.rss_bytes ?? samples[samples.length - 1]?.snap?.tarx?.rss_bytes ?? 0
  const delta = last - first
  const report = {
    event: 'soak_complete',
    samples: samples.length,
    rss_bytes_first: first,
    rss_bytes_last: last,
    rss_delta_bytes: delta,
    // Growth alone is not a leak proof (models may load). Flag only extreme growth.
    unbounded_growth_suspected: delta > 512 * 1024 * 1024 && SECONDS >= 60,
    storage: snapshotGeneratedStorage(),
    note: 'Do not claim memory leak unless controlled soak isolates model-load effects.',
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
