import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fakeFetch, json, setup, makeProfile, sha, sv } from './helpers.mjs'
import { createEngine } from '../lib/engine.js'
import { SEED_UPSTREAM } from '../lib/config.js'

const fx = JSON.parse(readFileSync(new URL('./fixtures/registry.json', import.meta.url), 'utf8'))
const toRegistryDoc = (n) => ({
  name: n, 'dist-tags': fx[n].distTags,
  versions: Object.fromEntries(Object.entries(fx[n].versions).map(([v, m]) => [v, { name: n, version: v, engines: m.e ? { dsh: m.e } : undefined, peerDependencies: m.p }])),
})
const pkgJson = (version, meta = {}) => JSON.stringify({ name: 'x', version, engines: meta.e ? { dsh: meta.e } : undefined, peerDependencies: meta.p })

const COLLIDING = ['dsh-orchestrator', 'dsh-mail', 'dsh-session-pin', 'dsh-ego-browser', 'dsh-adaptive-reasoning', 'dsh-session-manager', 'dsh-steering', 'dsh-prompt-library', 'dsh-hpc', 'dsh-voice', 'dsh-artifacts', 'dsh-idle-watchdog', 'dsh-subscriptions', 'dsh-loop', 'dsh-model-picker-table']
const SM = sha('a'); const SM_HEAD = sha('b')
const OWN_LOCAL = sha('c'); const OWN_REMOTE = sha('d')
const LOCK = `packages:\n\n  dsh-session-manager@https://codeload.github.com/dream12347/dsh-session-manager/tar.gz/${SM}:\n    resolution: {gitHosted: true}\n`

function world({ running = '0.1.5-rc.1', settings = {}, extraRoutes = [] } = {}) {
  const routes = [
    [/^https:\/\/registry\.npmjs\.org\/dsh-better-sidebar$/, () => json(toRegistryDoc('dsh-better-sidebar'), { etag: '"bs"' })],
    [/^https:\/\/registry\.npmjs\.org\/@perrylink%2Fdsh-github$/, () => json(toRegistryDoc('@perrylink/dsh-github'), { etag: '"gh"' })],
    [/^https:\/\/registry\.npmjs\.org\/dsh-image-gen$/, () => json(toRegistryDoc('dsh-image-gen'))],
    // github: session-manager has a tagless HEAD at 0.2.3 with a dual-line peer range
    [/repos\/dream12347\/dsh-session-manager\/tags/, () => json([{ name: 'v0.2.2', commit: { sha: SM } }])],
    [/repos\/dream12347\/dsh-session-manager\/commits\/HEAD/, () => ({ status: 200, headers: { etag: '"h"' }, body: SM_HEAD })],
    [/repos\/dream12347\/dsh-session-manager\/contents\/package\.json$/, () => ({ status: 200, headers: {}, body: pkgJson('0.2.3', { p: { '@deepseek-ai/dsh-agent': '^0.1.0-rc.6 || ^0.2.0-rc.1' } }) })],
    // release tarballs
    [/repos\/ManoloRemiddi\/dsh-steering\/releases/, () => json([{ tag_name: 'v0.1.0', assets: [{ name: 'dsh-steering-0.1.0.tgz' }] }])],
    [/repos\/ManoloRemiddi\/dsh-prompt-library\/releases/, () => json([{ tag_name: 'v0.3.0', assets: [{ name: 'dsh-prompt-library-0.3.0.tgz' }] }, { tag_name: 'v0.2.1', assets: [{ name: 'dsh-prompt-library-0.2.1.tgz' }] }])],
    [/repos\/ManoloRemiddi\/dsh-prompt-library\/contents\/package\.json\?ref=v0\.3\.0/, () => ({ status: 200, headers: {}, body: pkgJson('0.3.0', { e: '>=0.1.0-rc.6' }) })],
    // upstream of the archived session-pin
    [/repos\/PerryLink\/dsh-session-pin\/tags/, () => json([{ name: 'v0.7.19', commit: { sha: sha('e') } }, { name: 'v0.7.6', commit: { sha: sha('f') } }])],
    [/repos\/PerryLink\/dsh-session-pin\/commits\/HEAD/, () => ({ status: 200, headers: {}, body: sha('e') })],
    [/repos\/PerryLink\/dsh-session-pin\/contents\/package\.json\?ref=v0\.7\.19/, () => ({ status: 200, headers: {}, body: pkgJson('0.7.19', fx['dsh-session-pin'].versions['0.7.19']) })],
    // own plugin whose origin is ahead
    [/repos\/me\/dsh-hpc\/commits\/HEAD/, () => ({ status: 200, headers: {}, body: OWN_REMOTE })],
    [new RegExp(`repos/me/dsh-hpc/compare/${OWN_LOCAL}\\.\\.\\.${OWN_REMOTE}`), () => json({ status: 'ahead', ahead_by: 3, behind_by: 0 })],
    [/repos\/me\/dsh-hpc\/contents\/package\.json$/, () => ({ status: 200, headers: {}, body: pkgJson('1.1.0') })],
    ...extraRoutes,
  ]
  const f = fakeFetch(routes)
  const profile = makeProfile({
    deps: {
      'dsh-better-sidebar': '^0.18.0', '@perrylink/dsh-github': '^0.7.4', 'dsh-image-gen': '0.8.0',
      'dsh-orchestrator': 'link:./orch', 'dsh-mail': 'link:./mail', 'dsh-session-pin': 'link:./pin', 'dsh-hpc': 'link:./hpc',
      'dsh-session-manager': 'github:dream12347/dsh-session-manager#v0.2.2',
      'dsh-steering': 'https://github.com/ManoloRemiddi/dsh-steering/releases/download/v0.1.0/dsh-steering-0.1.0.tgz',
      'dsh-prompt-library': 'https://github.com/ManoloRemiddi/dsh-prompt-library/releases/download/v0.2.1/dsh-prompt-library-0.2.1.tgz',
      'odd-one': 'git+https://gitlab.example.com/o/r.git',
    },
    bundles: ['dsh-better-sidebar', 'dsh-session-pin'],
    installed: { 'dsh-better-sidebar': '0.18.0', '@perrylink/dsh-github': '0.7.4', 'dsh-image-gen': '0.8.0', 'dsh-session-manager': '0.2.2', 'dsh-steering': '0.1.0', 'dsh-prompt-library': '0.2.1' },
    lock: LOCK,
    links: {
      orch: { version: '0.3.0' }, mail: { version: '0.0.1' },
      pin: { version: '0.7.7', origin: 'https://github.com/PerryLink/dsh-session-pin.git', sha: sha('9') },
      hpc: { version: '1.0.0', origin: 'https://github.com/me/dsh-hpc.git', sha: OWN_LOCAL },
    },
  })
  const s = setup({ fetch: f, settings: { upstream: SEED_UPSTREAM, ...settings } })
  const engine = createEngine({ getCfg: s.cfg, state: s.state, net: s.net, sv, profileDir: () => profile, running: () => ({ version: running, source: 'test' }), profileName: () => 'web' })
  return { f, engine, profile, ...s }
}
const by = (res, n) => res.items.find((r) => r.name === n)

test('classification by specifier: colliding names never reach the registry', async () => {
  const w = world()
  await w.engine.sweep()
  const urls = w.f.calls.map((c) => c.url)
  for (const n of COLLIDING) assert.ok(!urls.some((u) => u.startsWith('https://registry.npmjs.org/' + n)), n + ' leaked to the registry')
  assert.ok(urls.every((u) => /^https:\/\/(registry\.npmjs\.org|api\.github\.com)\//.test(u)), 'only the two allowed hosts')
  assert.ok(!urls.some((u) => u.includes('odd-one') || u.includes('gitlab')), 'the gitlab dependency is never contacted')
})

test('0.1.5 host: better-sidebar stays on 0.18.x, github shows the caret trap, image-gen needs a hand check', async () => {
  const w = world()
  const res = await w.engine.sweep()
  const bs = by(res, 'dsh-better-sidebar')
  assert.equal(bs.latest, '0.28.2')
  assert.notEqual(bs.candidate.version, '0.28.2')
  assert.equal(bs.blockedLatest.version, '0.28.2')
  const gh = by(res, '@perrylink/dsh-github')
  assert.ok(gh.caretTrap && gh.caretTrap.resolves === '0.7.28', JSON.stringify(gh.caretTrap))
  assert.match(gh.caretTrap.reason, /fresh resolve/)
  assert.equal(by(res, 'dsh-image-gen').status, 'no-declared-range')
  assert.equal(res.summary.safe >= 2, true)
})

test('0.2.1 host: the same inventory now offers 0.28.2 and 0.7.28', async () => {
  const w = world({ running: '0.2.1-rc.5' })
  const res = await w.engine.sweep()
  assert.equal(by(res, 'dsh-better-sidebar').candidate.version, '0.28.2')
  assert.equal(by(res, '@perrylink/dsh-github').candidate.version, '0.7.28')
  assert.equal(by(res, '@perrylink/dsh-github').caretTrap, undefined)
})

test('apply command is memory capped, exact, scripts off, and carries the reminder', async () => {
  const w = world({ running: '0.2.1-rc.5', settings: { afterInstall: { 'dsh-better-sidebar': 'Re-run the translation patch script.' } } })
  const res = await w.engine.sweep()
  const bs = by(res, 'dsh-better-sidebar')
  assert.match(bs.applyHint, /^XDG_RUNTIME_DIR=\/run\/user\/\$\(id -u\) systemd-run --user --scope -p MemoryMax=1500M -p MemorySwapMax=0 pnpm --dir "\$\{DSH_HOME:-\$HOME\/\.dsh\}\/profiles\/web" add --save-exact --ignore-scripts dsh-better-sidebar@0\.28\.2$/)
  assert.equal(bs.afterInstall, 'Re-run the translation patch script.')
  assert.ok(!/\/home\//.test(bs.applyHint), 'no home path in the command')
})

test('git dependency with a tagless HEAD at a newer version is a candidate pinned by commit', async () => {
  const w = world()
  const res = await w.engine.sweep()
  const sm = by(res, 'dsh-session-manager')
  assert.equal(sm.kind, 'github')
  assert.equal(sm.installedCommit, SM)
  assert.equal(sm.status, 'update-compatible')
  assert.equal(sm.candidate.version, '0.2.3')
  assert.equal(sm.candidate.ref.kind, 'head')
  assert.match(sm.applyHint, new RegExp(`'dsh-session-manager@github:dream12347/dsh-session-manager#${SM_HEAD}'`))
  assert.ok(sm.links.compare.includes(SM) && sm.links.compare.includes(SM_HEAD))
})

test('release tarball: same version is up to date, a newer asset yields a rewritten URL', async () => {
  const w = world()
  const res = await w.engine.sweep()
  assert.equal(by(res, 'dsh-steering').status, 'up-to-date')
  const pl = by(res, 'dsh-prompt-library')
  assert.equal(pl.kind, 'release')
  assert.equal(pl.status, 'update-compatible')
  assert.match(pl.applyHint, /releases\/download\/v0\.3\.0\/dsh-prompt-library-0\.3\.0\.tgz'$/)
  assert.ok(pl.links.changelog.endsWith('/releases/tag/v0.3.0'))
})

test('session-pin (archived upstream): upstream map gives the final release, with the note and a manual hint, no pnpm command', async () => {
  const w = world()
  const res = await w.engine.sweep()
  const pin = by(res, 'dsh-session-pin')
  assert.equal(pin.kind, 'local')
  assert.equal(pin.upstream, 'PerryLink/dsh-session-pin')
  assert.equal(pin.candidate.version, '0.7.19')
  assert.match(pin.note, /archived/)
  assert.equal(pin.applyHint, undefined)
  assert.match(pin.manualHint, /Local folder/)
})

test('link: plugin whose git remote is ahead (checkOwnRemotes on)', async () => {
  const w = world({ settings: { checkOwnRemotes: true } })
  const res = await w.engine.sweep()
  const hpc = by(res, 'dsh-hpc')
  assert.equal(hpc.status, 'no-declared-range')
  assert.match(hpc.reason, /3 commit\(s\) ahead/)
  assert.equal(hpc.upstream, 'me/dsh-hpc')
})

test('plain own plugins are not checked unless asked, and never touch the network', async () => {
  const w = world()
  const res = await w.engine.sweep()
  for (const n of ['dsh-orchestrator', 'dsh-mail', 'dsh-hpc']) assert.equal(by(res, n).status, 'local', n)
  assert.ok(!w.f.calls.some((c) => /me\/dsh-hpc/.test(c.url)))
})

test('unsupported specifier is manual with the stable code', async () => {
  const w = world()
  const res = await w.engine.sweep()
  const odd = by(res, 'odd-one')
  assert.equal(odd.status, 'manual'); assert.equal(odd.code, 'PLUPD_SPEC_UNSUPPORTED')
})

test('a failed lookup is unreachable, never up to date', async () => {
  const w = world({ extraRoutes: [] })
  w.f.calls.length = 0
  const f2 = fakeFetch([[/./, { status: 500, body: '' }]])
  const s = setup({ fetch: f2 })
  const engine = createEngine({ getCfg: s.cfg, state: s.state, net: s.net, sv, profileDir: () => w.profile, running: () => ({ version: '0.1.5-rc.1', source: 'test' }) })
  const res = await engine.sweep()
  const bs = by(res, 'dsh-better-sidebar')
  assert.equal(bs.status, 'unreachable'); assert.equal(bs.code, 'PLUPD_REGISTRY_UNREACHABLE')
  assert.equal(by(res, 'dsh-session-manager').code, 'PLUPD_GITHUB_UNREACHABLE')
  assert.equal(res.items.filter((r) => r.status === 'up-to-date').length, 0)
})

test('GitHub rate limit mid-sweep marks the rest unreachable with the rate-limit code, registry still works', async () => {
  const remaining = { v: 11 }
  const w = world({ extraRoutes: [] })
  const f = fakeFetch([
    [/registry\.npmjs\.org/, () => json(toRegistryDoc('dsh-better-sidebar'))],
    [/api\.github\.com/, () => json([], { headers: { 'x-ratelimit-remaining': String(remaining.v--), 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 900) } })],
  ])
  const s = setup({ fetch: f })
  const engine = createEngine({ getCfg: s.cfg, state: s.state, net: s.net, sv, profileDir: () => w.profile, running: () => ({ version: '0.1.5-rc.1', source: 'test' }) })
  const res = await engine.sweep()
  assert.ok(res.items.some((r) => r.code === 'PLUPD_GITHUB_RATE_LIMITED'))
  assert.notEqual(by(res, 'dsh-better-sidebar').status, 'unreachable')
})

test('second sweep sends If-None-Match and gets 304s with the same answer', async () => {
  const doc = JSON.stringify(toRegistryDoc('dsh-better-sidebar'))
  const f = fakeFetch([[/registry\.npmjs\.org/, (u, init) => (init.headers['if-none-match'] === '"bs1"' ? { status: 304, headers: {} } : { status: 200, headers: { etag: '"bs1"' }, body: doc })]])
  const profile = makeProfile({ deps: { 'dsh-better-sidebar': '^0.18.0' }, installed: { 'dsh-better-sidebar': '0.18.0' } })
  const s = setup({ fetch: f })
  const engine = createEngine({ getCfg: s.cfg, state: s.state, net: s.net, sv, profileDir: () => profile, running: () => ({ version: '0.1.5-rc.1', source: 'test' }) })
  const a = await engine.sweep()
  const b = await engine.sweep()
  assert.equal(s.net.stats.notModified, 1)
  assert.equal(by(a, 'dsh-better-sidebar').candidate.version, by(b, 'dsh-better-sidebar').candidate.version)
})

test('ignore, snooze and restore re-derive status without any request', async () => {
  const w = world({ running: '0.2.1-rc.5' })
  await w.engine.sweep()
  const calls = w.f.calls.length
  const ign = await w.engine.ignore('dsh-better-sidebar')
  assert.equal(ign.status, 'ignored')
  assert.equal(w.engine.status().summary.safe < w.engine.items().filter((r) => r.baseStatus || r.status === 'update-compatible').length + 1, true)
  const restored = await w.engine.unignore('dsh-better-sidebar')
  assert.equal(restored.status, 'update-compatible')
  const sn = await w.engine.snooze('dsh-better-sidebar', 3)
  assert.equal(sn.status, 'snoozed')
  assert.equal(w.f.calls.length, calls)
  await assert.rejects(() => w.engine.ignore('nope'), (e) => e.code === 'PLUPD_PACKAGE_UNKNOWN')
})

test('refresh has a 60 s cooldown', async () => {
  const w = world()
  await w.engine.refresh()
  await assert.rejects(async () => w.engine.refresh(), (e) => e.code === 'PLUPD_REFRESH_COOLDOWN')
})

test('badge counts only compatible updates unless badgeCountsIncompatible is on', async () => {
  const a = world()
  await a.engine.sweep()
  const compat = a.engine.status().badge
  const b = world({ settings: { badgeCountsIncompatible: true } })
  await b.engine.sweep()
  assert.ok(compat >= 1)
  assert.ok(b.engine.status().badge >= compat)
  const c = world({ settings: { badge: false } })
  await c.engine.sweep()
  assert.equal(c.engine.status().badge, 0)
})

test('state file never contains a token, a home path or the profile directory', async () => {
  const w = world()
  await w.engine.sweep()
  const text = JSON.stringify(w.state.data)
  assert.ok(!text.includes(w.profile))
  assert.ok(!/ghp_|Bearer/.test(text))
})
