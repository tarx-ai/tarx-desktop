/**
 * Local resource visibility + memory-pressure policy for TARX Desktop.
 * Measurements are observational — do not claim a memory leak without a controlled test.
 */
const { execFileSync } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { snapshotGeneratedStorage, enforceDatasetRetention } = require('./generated-storage')

const RSS_WARN_BYTES = Number(process.env.TARX_RSS_WARN_BYTES || 8 * 1024 * 1024 * 1024)
const RSS_CRITICAL_BYTES = Number(process.env.TARX_RSS_CRITICAL_BYTES || 12 * 1024 * 1024 * 1024)

function parsePs() {
  let out = ''
  try {
    out = execFileSync('ps', ['-axo', 'pid=,rss=,comm=,args='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch {
    return []
  }
  const rows = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const rssKb = Number(m[2])
    const comm = m[3]
    const args = m[4]
    rows.push({
      pid,
      rss_bytes: rssKb * 1024,
      comm,
      args: args.slice(0, 240),
    })
  }
  return rows
}

function isTarxRelated(row) {
  const s = `${row.comm} ${row.args}`.toLowerCase()
  return (
    s.includes('tarx') ||
    s.includes('llama-server') ||
    s.includes('whisper-server') ||
    s.includes('cloudflared') && s.includes('tarx') ||
    s.includes('tarx-ops') ||
    s.includes('tarx-core') ||
    s.includes('tarx-channel') ||
    s.includes('training-watcher')
  )
}

function groupDuplicates(rows) {
  const byKey = new Map()
  for (const r of rows) {
    // Group by executable + primary script path heuristic
    let key = r.comm
    const script = r.args.match(/(\/\S+\.(?:js|mjs|ts|py))\b/)
    if (script) key = `${r.comm}:${script[1]}`
    else if (r.args.includes('llama-server')) {
      const port = r.args.match(/--port\s+(\d+)/)
      key = `llama-server:${port ? port[1] : 'unknown'}`
    }
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }
  const duplicates = []
  for (const [key, list] of byKey) {
    if (list.length > 1) duplicates.push({ key, count: list.length, pids: list.map((x) => x.pid) })
  }
  return duplicates
}

function listLoadedModels(rows) {
  const models = []
  for (const r of rows) {
    if (!r.args.includes('llama-server') && !r.args.includes('whisper-server')) continue
    const model = r.args.match(/--model\s+(\S+)/) || r.args.match(/-m\s+(\S+)/)
    const port = r.args.match(/--port\s+(\d+)/)
    models.push({
      pid: r.pid,
      rss_bytes: r.rss_bytes,
      model: model ? model[1] : null,
      port: port ? Number(port[1]) : null,
      comm: r.comm,
    })
  }
  return models
}

function snapshotResources() {
  const all = parsePs()
  const related = all.filter(isTarxRelated)
  const totalRss = related.reduce((s, r) => s + r.rss_bytes, 0)
  const duplicates = groupDuplicates(related)
  const models = listLoadedModels(related)
  const storage = snapshotGeneratedStorage()
  const free = os.freemem()
  const total = os.totalmem()
  const pressure =
    totalRss >= RSS_CRITICAL_BYTES || free < 512 * 1024 * 1024
      ? 'critical'
      : totalRss >= RSS_WARN_BYTES || free < 2 * 1024 * 1024 * 1024
        ? 'warn'
        : 'ok'

  return {
    at: new Date().toISOString(),
    execution_plane: 'computer',
    host: {
      total_bytes: total,
      free_bytes: free,
      loadavg: os.loadavg(),
    },
    tarx: {
      process_count: related.length,
      rss_bytes: totalRss,
      rss_warn_bytes: RSS_WARN_BYTES,
      rss_critical_bytes: RSS_CRITICAL_BYTES,
      pressure,
      processes: related
        .slice()
        .sort((a, b) => b.rss_bytes - a.rss_bytes)
        .slice(0, 40),
      duplicate_groups: duplicates,
      loaded_models: models,
    },
    generated_storage: storage,
    electron: {
      pid: process.pid,
      // process.memoryUsage is the Electron main process only
      memory_usage: process.memoryUsage(),
    },
  }
}

/**
 * Memory-pressure handling: pause optional work flags; never deletes weights/Vault/DB.
 */
function applyMemoryPressurePolicy(snap) {
  const actions = []
  if (!snap || !snap.tarx) return { actions, snap }

  if (snap.tarx.pressure === 'warn' || snap.tarx.pressure === 'critical') {
    actions.push('pause_optional_background_jobs')
    actions.push('reject_new_heavy_jobs')
    // Enforce generated dataset retention only
    const ret = enforceDatasetRetention()
    if (ret.deleted > 0) actions.push(`dataset_retention_deleted_${ret.deleted}`)
  }

  if (snap.tarx.pressure === 'critical') {
    actions.push('show_critical_warning')
    actions.push('preserve_recoverable_state')
    // Unload unused models is deferred to operator — automatic kill of llama-server
    // is unsafe without knowing active chats. Surface recommendation only.
    if (snap.tarx.loaded_models.length > 1) {
      actions.push('recommend_unload_unused_models')
    }
  }

  return { actions, snap }
}

module.exports = {
  snapshotResources,
  applyMemoryPressurePolicy,
  parsePs,
  isTarxRelated,
  RSS_WARN_BYTES,
  RSS_CRITICAL_BYTES,
}
