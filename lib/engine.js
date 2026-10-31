/**
 * The engine: inventory + evaluation + state + schedule-independent operations.
 * index.js owns timers and routes; this file owns behaviour and is fully testable.
 */
import { readInventory } from './inventory.js'
import { evaluateAll, summarize, reapplyUserState, ignoreKey, ACTIONABLE } from './evaluate.js'
import { fetchFullDoc } from './sources.js'
import { createGithub } from './sources.js'
import { E } from './errors.js'
import { check, doctorReport } from './plugin-errors.js'
import { ALLOWED_HOSTS } from './config.js'
import { hostAllowed } from './net.js'

export const REFRESH_COOLDOWN_MS = 60000
export const NOTICE_MIN_GAP_MS = 24 * 3600000

export function createEngine({ getCfg, state, net, sv, profileDir, running, profileName = () => 'web', now = Date.now, log = () => {}, warn = () => {}, version = '0.0.0', notify = null, hostInfo = async () => ({}), extra = () => ({}) }) {
  let inflight = null
  let lastRefreshAt = 0
  let lastInventory = null
  const gh = createGithub(net, sv)

  const publicRunning = () => {
    const r = running()
    return { version: r.version || null, source: r.source || 'unknown' }
  }

  async function runSweep() {
    const cfg = getCfg()
    const started = now()
    const dir = profileDir()
    const run = running()
    const errors = []
    let results = []
    let inv
    try {
      inv = await readInventory(dir, sv)
      lastInventory = inv
      if (inv.lockError) errors.push({ code: 'PLUPD_LOCKFILE_UNREADABLE', name: '' })
      if (!run.version) errors.push({ code: 'PLUPD_DSH_VERSION_UNKNOWN', name: '' })
      results = await evaluateAll(inv, { cfg, sv, net, gh, running: run.version || '', state, now: started, profileName: profileName() })
      for (const r of results) if (r.code && r.status === 'unreachable') errors.push({ code: r.code, name: r.name })
    } catch (e) {
      const b = E.from(e)
      errors.push({ code: b.code, name: '' })
      state.data.sweep = { at: started, durationMs: now() - started, ok: false, errors, fatal: b.message }
      await state.save()
      throw e
    }
    const summary = summarize(results, cfg)
    state.data.results = { at: started, running: publicRunning(), profile: profileName(), items: results, summary }
    state.data.sweep = { at: started, durationMs: now() - started, ok: errors.length === 0, errors, requests: net.stats.requests, notModified: net.stats.notModified }
    await state.save()
    log(`sweep done: ${results.length} package(s), ${summary.safe} safe update(s), ${errors.length} problem(s), ${net.stats.requests} request(s)`)
    await maybeNotify(results, cfg)
    return state.data.results
  }

  async function maybeNotify(results, cfg) {
    if (!cfg.chatNotice || typeof notify !== 'function') return
    const safe = results.filter((r) => r.status === 'update-compatible')
    const key = safe.map((r) => `${r.name}@${r.candidate && r.candidate.version}`).sort().join(',')
    const n = state.data.notice || (state.data.notice = {})
    if (!key || key === n.lastKey) return
    if (n.lastAt && now() - n.lastAt < NOTICE_MIN_GAP_MS) return
    const names = safe.slice(0, 6).map((r) => `${r.name} ${r.installed} to ${r.candidate.version}`).join(', ')
    const text = `Plugin updates: ${safe.length} compatible update(s) available (${names}${safe.length > 6 ? ', ...' : ''}). Nothing was installed. Open the Updates tab or ask for the plugin_updates tool.`
    try { await notify(text) ; n.lastKey = key; n.lastAt = now(); await state.save() } catch (e) { warn(`notice failed: ${e && e.message}`) }
  }

  /** One sweep at a time; concurrent callers share it. */
  function sweep() {
    if (!inflight) inflight = runSweep().finally(() => { inflight = null })
    return inflight
  }

  /** Synchronous gate (so a route can answer 429 at once), then the shared sweep promise. */
  function refresh({ force = false } = {}) {
    if (!getCfg().enabled) throw E.raise('PLUPD_DISABLED')
    const t = now()
    if (!force && lastRefreshAt && t - lastRefreshAt < REFRESH_COOLDOWN_MS) {
      throw E.raise('PLUPD_REFRESH_COOLDOWN', { retryAfterSec: Math.ceil((REFRESH_COOLDOWN_MS - (t - lastRefreshAt)) / 1000) })
    }
    lastRefreshAt = t
    state.data.refreshAt = t
    return sweep()
  }

  const items = () => (state.data.results && state.data.results.items) || []

  function status() {
    const cfg = getCfg()
    const res = state.data.results
    const sw = state.data.sweep
    const summary = res ? summarize(res.items, cfg) : { counts: {}, safe: 0, badge: 0, total: 0 }
    return {
      ok: true, plugin: 'dsh-plugin-updates', version, enabled: cfg.enabled,
      running: publicRunning(), checkedAt: res ? res.at : null, checking: Boolean(inflight),
      summary, badge: cfg.badge ? summary.badge : 0, badgeEnabled: cfg.badge,
      lastSweep: sw ? { at: sw.at, durationMs: sw.durationMs, ok: sw.ok, errors: sw.errors, requests: sw.requests } : null,
      nextCheckAt: extra().nextCheckAt || null,
      noGate: /^0\.1\./.test(publicRunning().version || ''),
      stateWriteError: state.lastWriteError ? E.body('PLUPD_STATE_WRITE_FAILED').code : null,
    }
  }

  function list({ scope = 'actionable', pkg = '' } = {}) {
    let rows = items()
    const safe = (r) => ['update-compatible', 'no-declared-range'].includes(r.status)
    if (pkg) rows = rows.filter((r) => r.name === pkg)
    else if (scope === 'actionable') rows = rows.filter((r) => ['update-compatible', 'no-declared-range', 'update-needs-newer-core'].includes(r.status) || r.caretTrap)
    else if (scope === 'safe') rows = rows.filter((r) => r.status === 'update-compatible')
    else if (scope === 'outdated') rows = rows.filter((r) => ACTIONABLE.includes(r.status) || r.status === 'held' || r.status === 'ignored' || r.status === 'snoozed')
    else if (scope === 'held') rows = rows.filter((r) => r.status === 'held' || r.hold)
    else if (scope === 'local') rows = rows.filter((r) => r.kind === 'local')
    void safe
    return rows
  }

  function find(name) {
    const r = items().find((x) => x.name === name)
    if (!r) throw E.raise('PLUPD_PACKAGE_UNKNOWN')
    return r
  }

  async function detail(name) {
    const r = find(name)
    const out = { ...r }
    if (r.kind === 'registry') {
      try {
        const full = await fetchFullDoc(net, getCfg(), sv, r.name)
        if (full) {
          const dates = {}
          for (const v of [r.installed, r.latest, r.latestCompatible, r.candidate && r.candidate.version]) if (v && full.time[v]) dates[v] = full.time[v]
          out.published = dates
          if (full.repo) {
            const root = `https://github.com/${full.repo.owner}/${full.repo.repo}`
            out.links = { ...out.links, repo: root, releases: `${root}/releases` }
          }
          const hints = {}
          for (const v of [r.candidate && r.candidate.version, r.latest]) if (v && full.nested[v]) hints[v] = full.nested[v]
          if (Object.keys(hints).length) out.nestedEngineHints = hints
        }
      } catch (e) { out.detailError = E.from(e).code }
    }
    return out
  }

  async function ignore(name, versionKey) {
    const r = find(name)
    const key = typeof versionKey === 'string' && versionKey ? versionKey : ignoreKey(r)
    if (!key || !/^[0-9A-Za-z.+_-]{1,60}$/.test(key)) throw E.raise('PLUPD_BAD_REQUEST', { detail: 'no version to ignore' })
    state.data.ignored[name] = key
    reapplyUserState(items(), state, now())
    await state.save()
    return find(name)
  }
  async function unignore(name) {
    delete state.data.ignored[name]
    delete state.data.snoozed[name]
    reapplyUserState(items(), state, now())
    await state.save()
    return items().find((x) => x.name === name) || null
  }
  async function snooze(name, days) {
    find(name)
    const cfg = getCfg()
    const d = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.min(365, Number(days)) : cfg.snoozeDays
    state.data.snoozed[name] = now() + d * 86400000
    reapplyUserState(items(), state, now())
    await state.save()
    return find(name)
  }

  async function doctor({ probe = true } = {}) {
    const cfg = getCfg()
    const checks = []
    const run = running()
    checks.push(await check('dsh-version', 'Running DSH version detected', async () => run.version
      ? { status: 'ok', detail: `${run.version} (${run.source})` }
      : { status: 'fail', detail: 'unknown', code: 'PLUPD_DSH_VERSION_UNKNOWN', hint: E.codes.PLUPD_DSH_VERSION_UNKNOWN.hint, docs: E.codes.PLUPD_DSH_VERSION_UNKNOWN.docs, human: true }))
    checks.push(await check('gate', 'Compatibility gate on this host', async () => ({
      status: 'info', detail: /^0\.1\./.test(run.version || '') ? 'DSH 0.1.x has no gate: results say "declared compatible", not verified' : 'DSH 0.2.x gate rule applied (engines.dsh, else DSH peer ranges)',
    })))
    checks.push(await check('settings', 'Settings readable', async () => ({ status: 'ok', detail: `enabled ${cfg.enabled}, every ${cfg.intervalHours} h, ${Object.keys(cfg.holds).length} hold(s), ${Object.keys(cfg.upstream).length} upstream map(s)`, ...extra().settingsDetail?.() })))
    checks.push(await check('profile', 'Profile package.json readable', async () => {
      const inv = await readInventory(profileDir(), sv)
      const kinds = {}
      for (const it of inv.items) kinds[it.cls.kind] = (kinds[it.cls.kind] || 0) + 1
      return { status: 'ok', detail: `${inv.items.length} dependencies (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')})` }
    }).then((c) => (c.status === 'fail' ? { ...c, code: 'PLUPD_PROFILE_NOT_FOUND', hint: E.codes.PLUPD_PROFILE_NOT_FOUND.hint, docs: E.codes.PLUPD_PROFILE_NOT_FOUND.docs, human: true } : c)))
    checks.push(await check('lockfile', 'Lockfile readable', async () => {
      if (lastInventory && lastInventory.lockError) return { status: 'warn', detail: 'unreadable', code: 'PLUPD_LOCKFILE_UNREADABLE', hint: E.codes.PLUPD_LOCKFILE_UNREADABLE.hint, docs: E.codes.PLUPD_LOCKFILE_UNREADABLE.docs }
      return { status: lastInventory && lastInventory.hasLock === false ? 'info' : 'ok', detail: lastInventory && lastInventory.hasLock === false ? 'no pnpm-lock.yaml (git dependencies are compared without the pinned commit)' : 'ok' }
    }))
    checks.push(await check('state', 'State file writable', async () => state.lastWriteError
      ? { status: 'warn', detail: 'last write failed', code: 'PLUPD_STATE_WRITE_FAILED', hint: E.codes.PLUPD_STATE_WRITE_FAILED.hint, docs: E.codes.PLUPD_STATE_WRITE_FAILED.docs, human: true }
      : { status: 'ok', detail: state.data.results ? 'results cached' : 'no result yet' }))
    checks.push(await check('hosts', 'Host allowlist', async () => {
      const ok = net.hostAllowed(cfg.registry)
      return ok ? { status: 'ok', detail: `registry host allowed; extra hosts ${cfg.allowHosts.length}` }
        : { status: 'fail', detail: 'registry setting is not on the allowlist', code: 'PLUPD_REGISTRY_HOST_BLOCKED', hint: E.codes.PLUPD_REGISTRY_HOST_BLOCKED.hint, docs: E.codes.PLUPD_REGISTRY_HOST_BLOCKED.docs, human: true }
    }))
    checks.push(await check('github-token', 'GitHub token (optional)', async () => ({
      status: 'info', detail: cfg.githubTokenEnv ? `variable name set, value ${process.env[cfg.githubTokenEnv] ? 'present' : 'NOT present'}` : 'not configured (60 requests per hour unauthenticated)',
    })))
    if (probe) {
      const withTimeout = (p, ms = 6000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
      checks.push(await check('registry', 'Registry reachable', async () => {
        const base = cfg.registry.replace(/\/+$/, '')
        await withTimeout(net.get(`${base}/-/ping`, { noCache: true, reduce: () => 1 }))
        return { status: 'ok', detail: 'ping answered' }
      }).then((c) => (c.status === 'fail' ? { ...c, status: 'warn', code: 'PLUPD_REGISTRY_UNREACHABLE', hint: E.codes.PLUPD_REGISTRY_UNREACHABLE.hint, docs: E.codes.PLUPD_REGISTRY_UNREACHABLE.docs, human: true } : c)))
      checks.push(await check('github', 'GitHub API reachable', async () => {
        const r = await withTimeout(net.get('https://api.github.com/rate_limit', { noCache: true, reduce: (t) => { const j = JSON.parse(t); return { remaining: j.resources && j.resources.core && j.resources.core.remaining, limit: j.resources && j.resources.core && j.resources.core.limit } } }))
        return { status: 'ok', detail: `core limit ${r.data.limit}, remaining ${r.data.remaining}` }
      }).then((c) => (c.status === 'fail' ? { ...c, status: 'warn', code: 'PLUPD_GITHUB_UNREACHABLE', hint: E.codes.PLUPD_GITHUB_UNREACHABLE.hint, docs: E.codes.PLUPD_GITHUB_UNREACHABLE.docs, human: true } : c)))
    }
    const sw = state.data.sweep
    checks.push(await check('last-sweep', 'Last check', async () => {
      if (!sw) return { status: 'info', detail: 'no check has run yet' }
      const problems = (sw.errors || []).length
      return { status: problems ? 'warn' : 'ok', detail: `${new Date(sw.at).toISOString()}, ${sw.durationMs} ms, ${problems} problem(s)${problems ? ': ' + [...new Set(sw.errors.map((e) => e.code))].join(', ') : ''}` }
    }))
    return doctorReport({ plugin: 'dsh-plugin-updates', version, host: await hostInfo(), checks })
  }

  return { sweep, refresh, status, list, detail, ignore, unignore, snooze, doctor, find, items, publicRunning, get inflight() { return Boolean(inflight) } }
}
