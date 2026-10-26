/**
 * dsh-lan-bridge — plugin inventory and one-click synchronisation.
 *
 * "Sync my plugin list to the other machine" is a profile operation, so this
 * module speaks the only vocabulary a DSH profile has:
 *
 *   <profile>/package.json   dependencies{} + dsh.profile.bundles[]
 *   $DSH_HOME/cordis.patch.yml   layer patches (MCP servers, local rows)
 *
 * Nothing here installs packages behind the user's back. `applyManifest` writes
 * the dependency and bundle rows it was asked to write (after a timestamped
 * backup) and reports whether an install run is still needed; `runInstall`
 * spawns the bundled pnpm only when the user presses that button.
 *
 * The patch file is deliberately *not* merged automatically: YAML text from
 * another machine can encode credentials and bindings, so we surface it as a
 * diff and let the user copy what they want.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

export function dshHome() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  return home || path.join(os.homedir(), '.dsh')
}

export function profileDir() {
  const dir = process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim()
  if (dir) return dir
  const profile = (process.env.DSH_PROFILE || 'desktop').trim()
  return path.join(dshHome(), 'profiles', profile)
}

export function profilePackageFile() {
  return path.join(profileDir(), 'package.json')
}

export function userPatchFile() {
  return path.join(dshHome(), 'cordis.patch.yml')
}

function readJson(file, fallback) {
  return fs
    .readFile(file, 'utf8')
    .then(function (text) {
      return JSON.parse(text)
    })
    .catch(function () {
      return fallback
    })
}

function readText(file, fallback) {
  return fs.readFile(file, 'utf8').catch(function () {
    return fallback
  })
}

function sortedNames(map) {
  return Object.keys(map || {}).sort(function (a, b) {
    return a.localeCompare(b)
  })
}

/**
 * The portable description of "what this DSH has installed".
 * @param {object} ctx host plugin context (may be a stub in tests)
 * @param {object} identity { machineId, machineName }
 */
export async function readLocalManifest(ctx, identity) {
  const pkg = await readJson(profilePackageFile(), {})
  const dependencies = pkg && typeof pkg.dependencies === 'object' && pkg.dependencies ? pkg.dependencies : {}
  const bundleRows = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  const patchText = await readText(userPatchFile(), '')
  let entries = []
  try {
    const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : null
    if (manager && typeof manager.listPlugins === 'function') {
      entries = await manager.listPlugins()
    }
  } catch (err) {
    entries = []
  }
  const stateByName = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue
    const name = entry.moduleName || entry.patchId
    if (typeof name !== 'string') continue
    stateByName[name] = {
      entryId: entry.entryId,
      enabled: entry.enabled === true,
      phase: entry.fiberPhase === undefined ? null : entry.fiberPhase,
      patchId: entry.patchId || null
    }
  }
  const plugins = sortedNames(dependencies).map(function (name) {
    return {
      name,
      version: dependencies[name],
      bundle: bundleRows.indexOf(name) >= 0,
      runtime: stateByName[name] || null
    }
  })
  return {
    schemaVersion: 1,
    machineId: (identity && identity.machineId) || '',
    machineName: (identity && identity.machineName) || '',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    profile: (process.env.DSH_PROFILE || 'desktop').trim(),
    profileDir: profileDir(),
    capturedAt: Date.now(),
    registry: DEFAULT_REGISTRY,
    dependencies: Object.assign({}, dependencies),
    bundles: bundleRows.slice(),
    pluginCount: plugins.length,
    plugins,
    patchBytes: Buffer.byteLength(patchText, 'utf8'),
    patch: patchText
  }
}

/** Compare a remote manifest against the local profile. Pure, no writes. */
export function plan(remote, local) {
  const remoteDeps = (remote && remote.dependencies) || {}
  const localDeps = (local && local.dependencies) || {}
  const remoteBundles = Array.isArray(remote && remote.bundles) ? remote.bundles : []
  const localBundles = Array.isArray(local && local.bundles) ? local.bundles : []

  const missing = []
  const versionDiff = []
  for (const name of sortedNames(remoteDeps)) {
    const want = remoteDeps[name]
    const have = localDeps[name]
    if (have === undefined) missing.push({ name, version: want, bundle: remoteBundles.indexOf(name) >= 0 })
    else if (String(have) !== String(want)) versionDiff.push({ name, local: have, remote: want })
  }
  const localOnly = sortedNames(localDeps).filter(function (name) {
    return remoteDeps[name] === undefined
  })
  const bundlesToAdd = remoteBundles.filter(function (name) {
    return localBundles.indexOf(name) < 0
  })
  return {
    remoteMachine: (remote && remote.machineName) || '',
    remoteMachineId: (remote && remote.machineId) || '',
    missing,
    versionDiff,
    bundlesToAdd,
    localOnly,
    identical: missing.length === 0 && versionDiff.length === 0 && bundlesToAdd.length === 0,
    patchDiffers: Boolean(remote && typeof remote.patch === 'string' && remote.patch.trim() !== '' && remote.patch !== local.patch)
  }
}

async function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = file + '.lan-bridge-backup-' + stamp
  try {
    await fs.copyFile(file, target)
    return target
  } catch (err) {
    return null
  }
}

/**
 * Write the parts of `remote` whose names appear in `options.include` (an array
 * of dependency names; omit to use the full plan). Bundles are added for every
 * installed dependency that the remote marks as a bundle.
 */
export async function applyManifest(remote, options) {
  const opts = options || {}
  const file = profilePackageFile()
  const before = await readJson(file, null)
  if (!before) {
    const error = new Error('cannot read the profile package.json at ' + file)
    error.code = 'NO_PROFILE'
    throw error
  }
  const local = await readLocalManifest({ get: function () { return null } }, {})
  const diff = plan(remote, local)
  const include = Array.isArray(opts.include) ? opts.include : null
  const wanted = new Set(
    include
      ? include
      : diff.missing.concat(diff.versionDiff.map(function (row) { return { name: row.name } })).map(function (row) {
          return row.name
        })
  )
  const skipVersion = opts.skipVersionDiff === true
  const next = JSON.parse(JSON.stringify(before))
  next.dependencies = Object.assign({}, next.dependencies || {})
  let added = 0
  let bumped = 0
  for (const row of diff.missing) {
    if (include && !wanted.has(row.name)) continue
    next.dependencies[row.name] = row.version
    added += 1
  }
  if (!skipVersion) {
    for (const row of diff.versionDiff) {
      if (include && !wanted.has(row.name)) continue
      next.dependencies[row.name] = row.remote
      bumped += 1
    }
  }
  const remoteBundles = Array.isArray(remote.bundles) ? remote.bundles : []
  next.dsh = next.dsh || {}
  next.dsh.profile = next.dsh.profile || {}
  const bundles = Array.isArray(next.dsh.profile.bundles) ? next.dsh.profile.bundles.slice() : []
  let bundlesAdded = 0
  for (const name of remoteBundles) {
    if (bundles.indexOf(name) >= 0) continue
    if (include && !wanted.has(name)) continue
    if (next.dependencies[name] === undefined) continue
    bundles.push(name)
    bundlesAdded += 1
  }
  next.dsh.profile.bundles = bundles

  const changed = added > 0 || bumped > 0 || bundlesAdded > 0
  if (!changed) {
    return { changed: false, added: 0, bumped: 0, bundlesAdded: 0, installRequired: false, backup: null }
  }
  const saved = await backup(file)
  await fs.writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return {
    changed: true,
    added,
    bumped,
    bundlesAdded,
    installRequired: added > 0 || bumped > 0,
    backup: saved,
    profile: file
  }
}

/** Where the pnpm that ships with the desktop app lives, if any. */
export function detectPnpm() {
  const explicit = process.env.DSH_PNPM_PATH
  if (explicit && explicit.trim()) return { command: process.execPath, args: [explicit.trim()], via: 'DSH_PNPM_PATH' }
  const candidates = []
  try {
    // <app>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs
    const execDir = path.dirname(process.execPath)
    candidates.push(path.join(execDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'))
    candidates.push(path.join(execDir, '..', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'))
  } catch (err) {
    /* not an electron host */
  }
  return { candidates }
}

/**
 * Resolve a runnable pnpm. Returns `{ command, args, cwd, via }` or null.
 */
export async function resolvePnpm() {
  const detected = detectPnpm()
  if (detected.command) return detected
  for (const candidate of detected.candidates || []) {
    try {
      await fs.access(candidate)
      return { command: process.execPath, args: [candidate], via: 'bundled', cwd: profileDir() }
    } catch (err) {
      /* keep looking */
    }
  }
  return null
}

/**
 * Spawn `pnpm install` in the profile. Resolves with the exit code and the last
 * `tail` lines of output; never rejects on a non-zero exit.
 */
export function runInstall(options) {
  const opts = options || {}
  const registry = opts.registry || DEFAULT_REGISTRY
  return resolvePnpm().then(function (pnpm) {
    if (!pnpm || !pnpm.command) {
      return {
        ok: false,
        code: 'PNPM_NOT_FOUND',
        message: 'pnpm was not found. Run this by hand in ' + profileDir() + ': pnpm install --registry=' + registry
      }
    }
    const args = pnpm.args.concat(['install', '--registry=' + registry])
    const limit = typeof opts.collect === 'number' ? opts.collect : 80
    return new Promise(function (resolve) {
      let child
      try {
        child = spawn(pnpm.command, args, { cwd: profileDir(), env: process.env, windowsHide: true })
      } catch (err) {
        resolve({ ok: false, code: 'SPAWN_FAILED', message: String((err && err.message) || err) })
        return
      }
      const lines = []
      const push = function (chunk) {
        const text = String(chunk)
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue
          lines.push(line)
          if (lines.length > limit) lines.shift()
        }
        if (typeof opts.onLine === 'function') {
          try {
            opts.onLine(text)
          } catch (err) {
            /* ignore */
          }
        }
      }
      if (child.stdout) child.stdout.on('data', push)
      if (child.stderr) child.stderr.on('data', push)
      const timer = setTimeout(function () {
        try {
          child.kill()
        } catch (err) {
          /* ignore */
        }
      }, typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 8 * 60 * 1000)
      child.on('error', function (err) {
        clearTimeout(timer)
        resolve({ ok: false, code: 'SPAWN_FAILED', message: String((err && err.message) || err), lines })
      })
      child.on('close', function (code) {
        clearTimeout(timer)
        resolve({
          ok: code === 0,
          code: 'EXIT_' + String(code),
          exitCode: code,
          command: pnpm.command + ' ' + args.join(' '),
          via: pnpm.via,
          cwd: profileDir(),
          lines
        })
      })
    })
  })
}

/** Toggle one plugin through the loader. */
export async function setPluginEnabled(ctx, entryId, enabled) {
  const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : null
  if (!manager || typeof manager.setPluginEnabled !== 'function') {
    return { ok: false, code: 'NO_SERVICE', message: 'the profile service is unavailable on this surface' }
  }
  try {
    await manager.setPluginEnabled(entryId, enabled === true)
    return { ok: true, entryId, enabled: enabled === true }
  } catch (err) {
    return { ok: false, code: 'REJECTED', message: String((err && err.message) || err) }
  }
}

/** Installed rows, for the "manage plugins" list. */
export async function listRuntimePlugins(ctx) {
  const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : null
  if (!manager || typeof manager.listPlugins !== 'function') return []
  try {
    const rows = await manager.listPlugins()
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return {
        entryId: row.entryId,
        name: row.moduleName || row.patchId || '',
        patchId: row.patchId || null,
        enabled: row.enabled === true,
        phase: row.fiberPhase === undefined ? null : row.fiberPhase,
        readOnly: Boolean(row.readOnlyReason)
      }
    })
  } catch (err) {
    return []
  }
}

export const moduleDir = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch (err) {
    return ''
  }
})()
