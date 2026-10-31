/**
 * dsh-plugin-updates, host half.
 *
 * A notify-only update checker for the plugins in the DSH profile. It reads the
 * profile package.json, classifies each dependency by its SPECIFIER, asks
 * registry.npmjs.org or api.github.com (nothing else), applies the DSH
 * compatibility gate against the RUNNING core and reports. It never installs,
 * never edits the profile, never runs a child process.
 *
 * Kill switch: add `- id: plugin-updates` / `disabled: true` to the profile
 * cordis.patch.yml, or set DSH_PLUGIN_UPDATES_DISABLE=1.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createDualSettings, loadHostSchemastery, liveObject } from './dual-settings.js'
import { registerPluginSkills } from './plugin-skills.js'
import { hostInfo } from './plugin-errors.js'
import { E } from './errors.js'
import { DEFAULTS, PLUGIN_ID, ROW_ID, PACKAGE_NAME, settingsSchema, normalizeSettings } from './config.js'
import { loadSemver } from './compat.js'
import { detectRunningAsync, detectRunning } from './version.js'
import { createState, stateDir } from './state.js'
import { createNet } from './net.js'
import { createEngine } from './engine.js'
import { resolveProfileDir } from './inventory.js'
import { makeHandler, API_PREFIX } from './routes.js'
import { agentTools } from './tool.js'

export { agentTools }
export const name = ROW_ID
export const inject = ['settings', 'webServer', 'tools']
export const VERSION = '0.1.0'
const DISABLE_ENV = 'DSH_PLUGIN_UPDATES_DISABLE'

const z = loadHostSchemastery(import.meta.url)
export const Config = settingsSchema(z, liveObject)

function resolveDefineTool(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const bases = []
  if (env.DSH_PLUGIN_UPDATES_TOOLS_MAIN) bases.push(env.DSH_PLUGIN_UPDATES_TOOLS_MAIN)
  bases.push(import.meta.url)
  if (env.DSH_PROFILE) bases.push(join(home, 'profiles', env.DSH_PROFILE, 'probe.js'))
  bases.push(join(home, 'profiles', 'web', 'probe.js'), join(home, 'profiles', 'probe.js'), join(home, 'probe.js'))
  if (process.argv && process.argv[1]) bases.push(process.argv[1])
  for (const base of bases) {
    try {
      const mod = createRequire(base)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* next seed */ }
  }
  return null
}

const typeOk = (def, v) => (Array.isArray(def) ? Array.isArray(v) : def !== null && typeof def === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === typeof def)

export function apply(ctx, config = {}, overrides = {}) {
  const log = (m) => console.log(`${PLUGIN_ID}: ${m}`)
  const warn = (m) => console.error(`${PLUGIN_ID}: ${m}`)
  if (process.env[DISABLE_ENV] === '1') { log(`${DISABLE_ENV}=1, switched off, nothing registered`); return }

  const store = createDualSettings(ctx, config, {
    ns: PLUGIN_ID, packageName: PACKAGE_NAME, schema: Config || null, base: DEFAULTS, metaUrl: import.meta.url, log, warn,
    legacy: { sections: [PLUGIN_ID, ROW_ID] },
  })
  const cfg = () => normalizeSettings(store.get())
  const sv = overrides.sv || loadSemver(import.meta.url)
  const state = overrides.state || createState({ dir: stateDir(), warn })
  const net = overrides.net || createNet({ fetch: overrides.fetch, state, cfg, version: VERSION, warn })

  let runningNow = detectRunning({ override: cfg().runningDshVersion, sv, metaUrl: import.meta.url })
  detectRunningAsync({ override: cfg().runningDshVersion, sv, metaUrl: import.meta.url }).then((r) => { runningNow = r }).catch(() => {})
  const running = () => {
    const o = cfg().runningDshVersion
    if (o && sv.valid(o)) return { version: o, source: 'setting' }
    return runningNow
  }

  let profileCtx = null
  try { ctx.inject(['profileContext'], (c) => { profileCtx = c.profileContext }) } catch { /* 0.1.5 has no such service */ }
  const ctxProfile = () => { try { return (profileCtx && profileCtx.dir) || (ctx.profileContext && ctx.profileContext.dir) || '' } catch { return '' } }
  const profileDir = () => overrides.profileDir || resolveProfileDir({ ctxProfileDir: ctxProfile() })
  const profileName = () => { const d = profileDir().split(/[\\/]/).filter(Boolean); return d[d.length - 1] || 'web' }

  let nextCheckAt = null
  const notify = async (text) => {
    const agents = (() => { try { return ctx.get('agents') } catch { return null } })()
    if (!agents || typeof agents.list !== 'function') throw new Error('no agents service')
    for (const a of agents.list()) {
      const live = a && typeof a.id === 'string' ? agents.get(a.id) : null
      const session = live && (live.session || live.sessionRef)
      if (session && typeof session.append === 'function') {
        session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'notice', summary: text.slice(0, 200) } })
        return
      }
    }
    throw new Error('no live session to post to')
  }

  const engine = overrides.engine || createEngine({
    getCfg: cfg, state, net, sv, profileDir, running, profileName, version: VERSION, log, warn, notify,
    hostInfo: () => hostInfo(ctx), extra: () => ({ nextCheckAt, settingsDetail: () => ({}) }),
  })

  const settings = {
    view: () => ({ mode: store.mode, writable: store.writable(), values: cfg(), defaults: DEFAULTS, entryId: store.entryId || null }),
    async update(patch) {
      if (!store.writable()) throw E.raise('PLUPD_BAD_REQUEST', { detail: 'settings are read-only in this mode' })
      const clean = {}
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULTS)) throw E.raise('PLUPD_BAD_REQUEST', { detail: `unknown setting ${k}` })
        if (!typeOk(DEFAULTS[k], v)) throw E.raise('PLUPD_BAD_REQUEST', { detail: `wrong type for ${k}` })
        clean[k] = v
      }
      await store.update(clean)
      return settings.view()
    },
  }

  // route
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: makeHandler({ engine, settings, ctx, version: VERSION }) }), `${PLUGIN_ID}: route`)

  // tools
  const defineTool = overrides.defineTool === undefined ? resolveDefineTool() : overrides.defineTool
  const toolsService = (() => { try { return ctx.tools || ctx.get('tools') } catch { return null } })()
  if (typeof defineTool !== 'function') warn('@deepseek-ai/dsh-tools could not be resolved, so no agent tools were registered. The route and the tab still work.')
  else if (!toolsService || typeof toolsService.register !== 'function') warn('the tools registry is unavailable, so no agent tools were registered.')
  else {
    try {
      for (const def of agentTools(defineTool, cfg, { engine })) {
        ctx.effect(() => { const d = toolsService.register(def); return () => { try { if (typeof d === 'function') d() } catch { /* gone */ } } }, `${PLUGIN_ID}: tool ${def.name}`)
      }
    } catch (e) { warn('tool registration failed: ' + ((e && e.stack) || e)) }
  }

  // doctor skill
  const nSkills = registerPluginSkills(ctx, { plugin: PACKAGE_NAME, dir: new URL('../skills/', import.meta.url), log: warn })

  // schedule
  let timer = null
  let disposed = false
  const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
  const schedule = () => {
    clear()
    if (disposed) return
    const c = cfg()
    if (!c.enabled) { nextCheckAt = null; return }
    const interval = c.intervalHours * 3600000
    const last = state.data.sweep && state.data.sweep.at
    const jitter = interval * 0.05 * (Math.random() * 2 - 1)
    const first = !scheduledOnce
    let delay = first ? Math.max(c.initialDelaySeconds * 1000, last ? last + interval - Date.now() : 0) + Math.random() * 10000 : interval + jitter
    delay = Math.min(Math.max(delay, 1000), 2 ** 31 - 1)
    scheduledOnce = true
    nextCheckAt = Date.now() + delay
    timer = setTimeout(async () => {
      timer = null
      try { await engine.sweep() } catch (e) { warn(E.logLine(E.from(e).code, e && e.message)) }
      schedule()
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }
  let scheduledOnce = false
  void state.load().then(() => { if (!disposed) schedule() }).catch(() => schedule())
  const stopWatch = store.watch((next, prev) => {
    const a = normalizeSettings(next); const b = normalizeSettings(prev)
    if (a.enabled !== b.enabled || a.intervalHours !== b.intervalHours) { scheduledOnce = true; schedule() }
  })
  ctx.effect(() => () => { disposed = true; clear(); try { if (typeof stopWatch === 'function') stopWatch() } catch { /* ignore */ } }, `${PLUGIN_ID}: timers`)

  log(`armed, route ${API_PREFIX}, settings ${store.mode}, ${nSkills} skill(s), DSH ${running().version || 'unknown'}`)
  return overrides.expose ? { engine, store, state, settings, schedule } : undefined
}

const plugin = { name, inject, apply, Config }
export default plugin
