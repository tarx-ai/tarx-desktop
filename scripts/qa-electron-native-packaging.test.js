const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  findPackagedApps,
  scanNativePackaging,
} = require('./qa-electron-native-packaging.js')

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeFile(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tarx-native-packaging-'))
  const appPath = path.join(root, 'dist', 'mac-arm64', 'TARX.app')
  const sourceModulePath = path.join(root, 'node_modules', 'better-sqlite3-multiple-ciphers')
  const unpackedModulePath = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3-multiple-ciphers')
  const packageJson = {
    name: 'tarx-desktop',
    version: '1.1.13',
    build: {
      asarUnpack: ['node_modules/better-sqlite3-multiple-ciphers/**'],
    },
  }
  const dependencyGraph = {
    dependencies: {
      'better-sqlite3-multiple-ciphers': {
        name: 'better-sqlite3-multiple-ciphers',
        path: sourceModulePath,
        dependencies: {},
      },
    },
  }

  writeJson(path.join(root, 'package.json'), packageJson)
  writeJson(path.join(sourceModulePath, 'package.json'), {
    name: 'better-sqlite3-multiple-ciphers',
    version: '12.9.0',
    gypfile: true,
  })
  writeFile(path.join(sourceModulePath, 'build', 'Release', 'better_sqlite3.node'), 'native')
  writeFile(path.join(unpackedModulePath, 'build', 'Release', 'better_sqlite3.node'), 'native')

  return { root, appPath, dependencyGraph, sourceModulePath, unpackedModulePath }
}

function makeMultiArchFixture() {
  const fixture = makeFixture()
  const x64AppPath = path.join(fixture.root, 'dist', 'mac-x64', 'TARX.app')
  const x64UnpackedModulePath = path.join(x64AppPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3-multiple-ciphers')

  writeFile(path.join(x64UnpackedModulePath, 'README.txt'), 'present but not native')

  return {
    ...fixture,
    x64AppPath,
    x64UnpackedModulePath,
    packagedApps: [fixture.appPath, x64AppPath],
  }
}

test('scanNativePackaging passes when the declared native module is unpacked', () => {
  const fixture = makeFixture()
  const result = scanNativePackaging({
    root: fixture.root,
    packagedApps: [fixture.appPath],
    dependencyGraph: fixture.dependencyGraph,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.missing, [])
  assert.equal(result.native_packages.length, 1)
  assert.equal(result.native_packages[0].artifact_label, 'mac-arm64')
  assert.equal(result.native_packages[0].package, 'better-sqlite3-multiple-ciphers')
  assert.equal(result.native_packages[0].unpack_pattern_present, true)
  assert.equal(result.native_packages[0].packaged_exists, true)
  assert.ok(result.native_packages[0].packaged_node_files.some((file) => file.endsWith('.node')))
})

test('scanNativePackaging fails when the unpack pattern is missing', () => {
  const fixture = makeFixture()
  writeJson(path.join(fixture.root, 'package.json'), {
    name: 'tarx-desktop',
    version: '1.1.13',
    build: {
      asarUnpack: [],
    },
  })

  const result = scanNativePackaging({
    root: fixture.root,
    packagedApps: [fixture.appPath],
    dependencyGraph: fixture.dependencyGraph,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['mac-arm64:better-sqlite3-multiple-ciphers'])
  assert.equal(result.native_packages[0].unpack_pattern_present, false)
})

test('scanNativePackaging fails if any shipped architecture misses the native payload', () => {
  const fixture = makeMultiArchFixture()
  const result = scanNativePackaging({
    root: fixture.root,
    packagedApps: fixture.packagedApps,
    dependencyGraph: fixture.dependencyGraph,
  })

  assert.equal(result.ok, false)
  assert.equal(result.missing.some((entry) => entry.startsWith('mac-x64:better-sqlite3-multiple-ciphers')), true)
  assert.equal(result.native_packages.filter((entry) => entry.artifact_label === 'mac-arm64')[0].ok, true)
  assert.equal(result.native_packages.filter((entry) => entry.artifact_label === 'mac-x64')[0].ok, false)
})

test('sender node ids remain opaque and deterministic', () => {
  const bridgeSource = fs.readFileSync(path.join('/Users/master/Desktop/TARX/Repos - active/tarx-electron', 'resources', 'bridge', 'bridge.js'), 'utf8')
  const senderNodeId = `node_${'a'.repeat(16)}`

  assert.match(senderNodeId, /^node_[a-f0-9]{16}$/)
  assert.ok(bridgeSource.includes('function nodeIdFromInstallHash(installIdHash)'))
  assert.ok(bridgeSource.includes('return `node_${installIdHash.slice(0, 16)}`;'))
  assert.ok(bridgeSource.includes('function isOpaqueNodeId(nodeId)'))
  assert.ok(bridgeSource.includes('return typeof nodeId === "string" && /^node_[a-f0-9]{16}$/i.test(nodeId);'))
})

test('findPackagedApps discovers all shipped app bundles', () => {
  const fixture = makeMultiArchFixture()
  const apps = findPackagedApps(fixture.root)

  assert.equal(apps.includes(fixture.appPath), true)
  assert.equal(apps.includes(fixture.x64AppPath), true)
})
