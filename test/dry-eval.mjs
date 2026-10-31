#!/usr/bin/env node
/**
 * Dry evaluation of a REAL profile, read-only.
 *
 *   node test/dry-eval.mjs --copy <src-profile-dir> <dest-dir>     copy package.json, pnpm-lock.yaml and the
 *                                                                  installed package.json of every dependency
 *   node test/dry-eval.mjs <profile-copy> [--host 0.1.5-rc.1] [--host 0.2.1-rc.5] [--skip-github] [--json]
 *
 * It uses the real registry and GitHub (ETag cached in <profile-copy>/.state, so a repeat run is nearly free)
 * and never writes outside <profile-copy>. link: folders are read in place (package.json and .git files only).
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createState } from '../lib/state.js'
import { createNet } from '../lib/net.js'
import { createEngine } from '../lib/engine.js'
import { loadSemver } from '../lib/compat.js'
import { normalizeSettings } from '../lib/config.js'

const args = process.argv.slice(2)
if (args[0] === '--copy') {
  const [, src, dest] = args
  mkdirSync(dest, { recursive: true })
  for (const f of ['package.json', 'pnpm-lock.yaml']) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dest, f))
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
  let n = 0
  for (const name of Object.keys(pkg.dependencies || {})) {
    const from = join(src, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(from)) continue
    const to = join(dest, 'node_modules', ...name.split('/'), 'package.json')
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    n++
  }
  console.log(`copied package.json, lockfile and ${n} installed package.json files to ${dest}`)
  process.exit(0)
}

const profile = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--host'))
const hosts = args.flatMap((a, i) => (a === '--host' ? [args[i + 1]] : []))
if (!hosts.length) hosts.push('0.1.5-rc.1', '0.2.1-rc.5')
const skipGithub = args.includes('--skip-github')
const sv = loadSemver(import.meta.url)
const state = createState({ dir: join(profile, '.state') })
await state.load()
const realFetch = globalThis.fetch
const fetchImpl = (url, init) => (skipGithub && String(url).startsWith('https://api.github.com') ? Promise.reject(new Error('github skipped')) : realFetch(url, init))
const cfg = normalizeSettings({})
const net = createNet({ fetch: fetchImpl, state, cfg: () => cfg, version: 'dry-eval' })
const out = {}
for (const host of hosts) {
  const engine = createEngine({ getCfg: () => cfg, state, net, sv, profileDir: () => profile, running: () => ({ version: host, source: 'dry-eval' }), profileName: () => 'web' })
  const res = await engine.sweep()
  out[host] = res.items
  const before = net.stats.requests
  console.error(`host ${host}: ${res.items.length} packages, requests so far ${before} (304: ${net.stats.notModified}, github ${net.stats.github}, registry ${net.stats.registry})`)
}
if (args.includes('--json')) { writeFileSync(join(profile, 'dry-eval.json'), JSON.stringify(out, null, 1)); process.exit(0) }
const names = out[hosts[0]].map((r) => r.name)
const cell = (r) => {
  if (!r) return '-'
  const c = r.candidate && r.candidate.version
  return `${r.status}${c ? ' ' + c : ''}${r.blockedLatest ? ' (blocked ' + r.blockedLatest.version + ')' : ''}${r.caretTrap ? ' [caret->' + r.caretTrap.resolves + ']' : ''}${r.code ? ' ' + r.code : ''}`
}
console.log(['package', 'kind', 'installed', ...hosts].join(' | '))
for (const n of names) {
  const rows = hosts.map((h) => out[h].find((r) => r.name === n))
  console.log([n, rows[0].kind, rows[0].installed || '?', ...rows.map(cell)].join(' | '))
}
console.error(`total requests ${net.stats.requests}: registry ${net.stats.registry}, github ${net.stats.github}, not modified ${net.stats.notModified}`)
