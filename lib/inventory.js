/**
 * Read-only inventory of the profile: package.json dependencies and bundles,
 * installed versions, the lockfile commits of git dependencies, and (for link:
 * dependencies) the plain-file git facts of the linked folder. No child process.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, isAbsolute, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { classifySpecifier, githubRemote } from './classify.js'
import { E } from './errors.js'

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}
async function readText(file) {
  try { return await readFile(file, 'utf8') } catch (e) { if (e && e.code === 'ENOENT') return null; throw e }
}
async function isDir(p) { try { return (await stat(p)).isDirectory() } catch { return false } }
async function exists(p) { try { await stat(p); return true } catch { return false } }

/** Profile directory: explicit env, the host profile context, then home + name. */
export function resolveProfileDir({ ctxProfileDir, env = process.env, argv = process.argv } = {}) {
  if (env.DSH_PLUGIN_UPDATES_PROFILE_DIR) return env.DSH_PLUGIN_UPDATES_PROFILE_DIR
  if (typeof ctxProfileDir === 'string' && ctxProfileDir) return ctxProfileDir
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  let name = env.DSH_PROFILE || ''
  const i = (argv || []).indexOf('--profile')
  if (!name && i >= 0 && argv[i + 1]) name = argv[i + 1]
  if (!name) name = 'web'
  return join(home, 'profiles', name)
}

/** Parse the git dependency commits out of a pnpm-lock.yaml (text scan, no YAML parser). */
export function parseLockCommits(text) {
  const out = {}
  const re = /^\s{0,4}'?((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)@https:\/\/codeload\.github\.com\/([^/\s]+)\/([^/\s]+)\/tar\.gz\/([0-9a-f]{40})(?:\([^)]*\))*'?:\s*$/gm
  let m
  while ((m = re.exec(String(text || '')))) out[m[1]] = { owner: m[2], repo: m[3], sha: m[4] }
  return out
}

async function gitDir(dir) {
  const dot = join(dir, '.git')
  if (await isDir(dot)) return dot
  const txt = await readText(dot).catch(() => null)
  const m = txt && /^gitdir:\s*(.+)$/m.exec(txt)
  if (m) return isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim())
  return null
}

/** Plain file reads of .git/HEAD, packed-refs and config. */
export async function readGitFacts(dir) {
  const gd = await gitDir(dir)
  if (!gd) return { git: false }
  const head = ((await readText(join(gd, 'HEAD')).catch(() => '')) || '').trim()
  let sha = ''
  let branch = ''
  if (/^[0-9a-f]{40}$/.test(head)) sha = head
  else {
    const m = /^ref:\s*(.+)$/.exec(head)
    if (m) {
      const ref = m[1].trim()
      branch = ref.replace(/^refs\/heads\//, '')
      const loose = ((await readText(join(gd, ref)).catch(() => '')) || '').trim()
      if (/^[0-9a-f]{40}$/.test(loose)) sha = loose
      else {
        const packed = (await readText(join(gd, 'packed-refs')).catch(() => '')) || ''
        const pm = new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(packed)
        if (pm) sha = pm[1]
      }
    }
  }
  const cfg = (await readText(join(gd, 'config')).catch(() => '')) || ''
  const remotes = {}
  let cur = ''
  for (const line of cfg.split(/\r?\n/)) {
    const h = /^\[remote "([^"]+)"\]/.exec(line.trim())
    if (h) { cur = h[1]; continue }
    if (line.trim().startsWith('[')) { cur = ''; continue }
    const u = /^\s*url\s*=\s*(.+)$/.exec(line)
    if (cur && u) remotes[cur] = u[1].trim()
  }
  return { git: true, sha, branch, remotes, origin: remotes.origin || '' }
}

/**
 * @returns {Promise<{ profileDir, items: object[], bundles: string[], lockError?: string }>}
 * item: { name, spec, cls, bundled, installed, installedCommit?, local? }
 */
export async function readInventory(profileDir, sv) {
  const pkg = await readJson(join(profileDir, 'package.json'))
  if (!pkg) throw E.raise('PLUPD_PROFILE_NOT_FOUND', { detail: 'package.json is missing or not valid JSON' })
  const bundles = new Set(((pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []).filter((b) => typeof b === 'string'))
  const deps = { ...(pkg.optionalDependencies || {}), ...(pkg.dependencies || {}) }

  let commits = {}
  let lockError
  try {
    const lock = await readText(join(profileDir, 'pnpm-lock.yaml'))
    if (lock) commits = parseLockCommits(lock)
  } catch (e) { lockError = e && e.message ? e.message : String(e) }

  const items = []
  for (const [name, spec] of Object.entries(deps)) {
    const cls = classifySpecifier(spec, sv)
    const item = { name, spec: String(spec), cls, bundled: bundles.has(name), installed: '' }
    if (cls.kind === 'local') {
      const target = isAbsolute(cls.path) ? cls.path : cls.path.startsWith('~/') ? join(homedir(), cls.path.slice(2)) : resolve(profileDir, cls.path)
      const lp = await readJson(join(target, 'package.json'))
      const facts = await readGitFacts(target)
      item.installed = lp && typeof lp.version === 'string' ? lp.version : ''
      item.local = { dirName: basename(target), parentName: basename(dirname(target)), exists: Boolean(lp), pkgName: lp && lp.name, ...facts }
    } else {
      const ip = await readJson(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
      item.installed = ip && typeof ip.version === 'string' ? ip.version : ''
      if (cls.kind === 'github' && commits[name]) item.installedCommit = commits[name].sha
    }
    items.push(item)
  }
  return { profileDir, items, bundles: [...bundles], lockError, hasLock: await exists(join(profileDir, 'pnpm-lock.yaml')) }
}
