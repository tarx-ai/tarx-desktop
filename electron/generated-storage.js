/**
 * Generated-data storage bounds for TARX Computer plane.
 * Only manages *generated* paths under ~/.tarx — never model weights,
 * user source data, Vault, or primary DBs.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const HOME = os.homedir()
const TARX_HOME = process.env.TARX_HOME || path.join(HOME, '.tarx')
const FINETUNE_DIR = path.join(TARX_HOME, 'finetune')

const DEFAULTS = {
  datasetMaxFiles: Number(process.env.TARX_DATASET_MAX_FILES || 5),
  datasetMaxBytes: Number(process.env.TARX_DATASET_MAX_BYTES || 2 * 1024 * 1024 * 1024),
  datasetWarnBytes: Number(process.env.TARX_DATASET_WARN_BYTES || 1 * 1024 * 1024 * 1024),
  runsMaxBytes: Number(process.env.TARX_RUNS_MAX_BYTES || 512 * 1024 * 1024),
}

function safeStat(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function listDatasetFiles() {
  if (!fs.existsSync(FINETUNE_DIR)) return []
  return fs
    .readdirSync(FINETUNE_DIR)
    .filter((n) => /^dataset-.*\.jsonl$/.test(n))
    .map((n) => {
      const p = path.join(FINETUNE_DIR, n)
      const st = safeStat(p)
      if (!st || !st.isFile()) return null
      return { path: p, size: st.size, mtimeMs: st.mtimeMs }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function dirSize(dir, maxDepth = 3, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return 0
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSize(p, maxDepth, depth + 1)
      else if (e.isFile()) total += fs.statSync(p).size
    } catch { /* */ }
  }
  return total
}

/**
 * Enforce retention on generated dataset-*.jsonl only.
 */
function enforceDatasetRetention(opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULTS.datasetMaxFiles
  const maxBytes = opts.maxBytes ?? DEFAULTS.datasetMaxBytes
  let files = listDatasetFiles()
  let deleted = 0
  let bytesFreed = 0

  for (const f of files.filter((x) => x.size === 0)) {
    try {
      fs.unlinkSync(f.path)
      deleted++
    } catch { /* */ }
  }
  files = listDatasetFiles()

  while (files.length > maxFiles) {
    const victim = files.pop()
    try {
      bytesFreed += victim.size
      fs.unlinkSync(victim.path)
      deleted++
    } catch { /* */ }
    files = listDatasetFiles()
  }

  let bytes = files.reduce((s, f) => s + f.size, 0)
  while (bytes > maxBytes && files.length > 1) {
    const victim = files.pop()
    try {
      bytesFreed += victim.size
      bytes -= victim.size
      fs.unlinkSync(victim.path)
      deleted++
    } catch { /* */ }
    files = listDatasetFiles()
    bytes = files.reduce((s, f) => s + f.size, 0)
  }

  return { deleted, bytesFreed, files: files.length, bytes }
}

function contentHashFile(filePath) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(filePath))
  return h.digest('hex').slice(0, 16)
}

function snapshotGeneratedStorage() {
  const datasets = listDatasetFiles()
  const datasetBytes = datasets.reduce((s, f) => s + f.size, 0)
  const runsBytes = dirSize(path.join(TARX_HOME, 'runs'), 4)
  const logsBytes = dirSize(path.join(TARX_HOME, 'logs'), 3)
  return {
    tarx_home: TARX_HOME,
    execution_plane: 'computer',
    datasets: {
      files: datasets.length,
      bytes: datasetBytes,
      max_files: DEFAULTS.datasetMaxFiles,
      max_bytes: DEFAULTS.datasetMaxBytes,
      warn_bytes: DEFAULTS.datasetWarnBytes,
      over_warn: datasetBytes >= DEFAULTS.datasetWarnBytes,
    },
    runs_bytes: runsBytes,
    logs_bytes: logsBytes,
    never_auto_delete: [
      'model weights under ~/.tarx/models',
      'user source data',
      'Vault credentials',
      'primary databases (tarx.db etc.)',
    ],
  }
}

module.exports = {
  DEFAULTS,
  listDatasetFiles,
  enforceDatasetRetention,
  snapshotGeneratedStorage,
  contentHashFile,
  FINETUNE_DIR,
  TARX_HOME,
}
