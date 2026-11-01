/**
 * Client-half boot test: executes lib/client.js the way the browser loader does
 * (fake window.__ModuleLoader__ + require('react')), applies it to fake contexts
 * and mounts the tab component in jsdom. A client that throws here would blank
 * the whole web UI in the browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const React = require('react')
const jsxRuntime = require('react/jsx-runtime')
const { act } = require('react-dom/test-utils')
const { createRoot } = require('react-dom/client')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.location = dom.window.location
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const status = (badge = 3) => ({ ok: true, plugin: 'dsh-plugin-updates', enabled: true, running: { version: '0.1.5-rc.1', source: 'harness' }, checkedAt: Date.now() - 5000, checking: false, summary: { counts: { 'update-compatible': badge }, safe: badge, badge, total: 5 }, badge, badgeEnabled: true, lastSweep: { at: Date.now(), ok: true, errors: [] }, noGate: true })
const pkgs = [
  { name: 'dsh-better-sidebar', kind: 'registry', installed: '0.18.0', latest: '0.28.2', status: 'update-compatible', reason: 'engines.dsh accepts the running DSH', candidate: { version: '0.18.1' }, blockedLatest: { version: '0.28.2', direction: 'newer' }, applyHint: 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemd-run --user --scope -p MemoryMax=1500M -p MemorySwapMax=0 pnpm add x@0.18.1', links: { npm: 'https://www.npmjs.com/package/dsh-better-sidebar' }, bundled: true },
  { name: 'dsh-orchestrator', kind: 'local', installed: '0.3.0', status: 'local', reason: 'local plugin, not checked' },
  { name: 'odd-one', kind: 'manual', installed: '', status: 'manual', reason: 'cannot be checked automatically', code: 'PLUPD_SPEC_UNSUPPORTED' },
]
const fetchState = { badge: 3, calls: [] }
globalThis.fetch = async (url, init) => {
  fetchState.calls.push([String(url), init && init.method])
  const u = String(url)
  const body = u.endsWith('/status') ? status(fetchState.badge) : u.includes('/list') ? { ok: true, status: status(fetchState.badge), packages: pkgs } : u.endsWith('/settings') ? { ok: true, mode: 'forms', writable: true, values: { enabled: true, intervalHours: 12, badge: true, badgeCountsIncompatible: false, checkOwnRemotes: false, chatNotice: false, githubTokenEnv: '', holds: { a: '>=1' }, upstream: {}, notes: {}, afterInstall: {} }, defaults: {} } : { ok: true }
  return { ok: true, status: 200, json: async () => body }
}

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let loaded
dom.window.__ModuleLoader__ = { load: (p) => { loaded = p } }
new Function('window', 'document', 'location', src)(dom.window, dom.window.document, dom.window.location)
const cache = new Map([['react', React], ['react/jsx-runtime', jsxRuntime]])
const plugin = loaded.factory((id) => { assert.ok(cache.has(id), 'loader asked for undeclared dep ' + id); return cache.get(id) })

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 25)) }) }

function makeCtx({ sidebar = true, injectKind = 'cb' } = {}) {
  const disposers = []; const tabs = []; const sections = []
  const ctx = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    slots: {
      inject: (name, factory) => { const r = factory(); sections.push({ name, r }); return () => {} },
      register: (meta, component) => ({ meta, component }),
    },
    on: () => {},
  }
  if (injectKind === 'cb') {
    ctx.inject = (names, cb) => {
      assert.deepEqual(names, ['betterSidebar'])
      if (!sidebar) return
      cb({ betterSidebar: { registerTab: (d) => { tabs.push(d); return () => {} } }, effect: (fn) => fn() })
    }
  } else if (injectKind === 'throws') ctx.inject = () => { throw new Error('no such service') }
  else if (injectKind === 'cb-empty') ctx.inject = (names, cb) => cb({})
  return { ctx, disposers, tabs, sections }
}

test('client declares inject ["slots"] only: better-sidebar stays optional', () => {
  assert.equal(loaded.id, '@lucagiftzek/dsh-plugin-updates')
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

test('no betterSidebar: apply must not throw (service absent, inject missing, inject throwing, empty service)', () => {
  for (const kind of ['cb', 'missing', 'throws', 'cb-empty']) {
    const h = makeCtx({ sidebar: false, injectKind: kind })
    assert.doesNotThrow(() => plugin.apply(h.ctx), kind)
    assert.equal(h.tabs.length, 0, kind)
    assert.equal(h.sections.length, 1, 'settings section still registered: ' + kind)
    for (const d of h.disposers) d()
  }
})

test('with betterSidebar: Updates tab registers, badge is null until status arrives, then live, with the tab closed', async () => {
  const h = makeCtx()
  plugin.apply(h.ctx)
  assert.equal(h.tabs.length, 1)
  const tab = h.tabs[0]
  assert.equal(tab.id, 'dsh-plugin-updates:list'); assert.equal(tab.title, 'Updates'); assert.equal(tab.single, true)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(tab.badge(), 3, 'badge is live although the tab was never mounted')
  assert.ok(fetchState.calls.some(([u]) => u.endsWith('/dsh-plugin-updates/api/status')))
  plugin.__internals.S.status = { ...status(0) }
  assert.equal(tab.badge(), null, 'zero hides the badge')
  plugin.__internals.S.status = { ...status(7), badgeEnabled: false }
  assert.equal(tab.badge(), null, 'badge setting off hides it')
  for (const d of h.disposers) d()
  assert.equal(plugin.__internals.S.timer, null, 'poll stops on dispose')
})

test('tab component mounts, groups packages, shows the capped command and copies it, nothing is executed', async () => {
  const h = makeCtx()
  plugin.apply(h.ctx)
  const host = document.getElementById('root')
  const root = createRoot(host)
  let copied = ''
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t } }, configurable: true })
  await act(async () => { root.render(React.createElement(h.tabs[0].component, { visible: true })) })
  await flush()
  const text = host.textContent
  assert.match(text, /Plugin updates/)
  assert.match(text, /Actionable now/)
  assert.match(text, /dsh-better-sidebar/)
  assert.match(text, /Local \(own or forked\)/)
  assert.match(text, /Unreachable or manual/)
  assert.match(text, /newer 0\.28\.2 needs a newer core/)
  const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'More')
  await act(async () => { more.click() })
  assert.match(host.textContent, /MemoryMax=1500M/)
  const copy = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Copy command')
  await act(async () => { copy.click() })
  await flush()
  assert.match(copied, /systemd-run --user --scope -p MemoryMax=1500M/)
  assert.ok(fetchState.calls.every(([, m]) => m !== 'POST'), 'copying never posts anything')
  const links = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  assert.ok(links.every((l) => /^https:\/\/(www\.npmjs\.com|github\.com)\//.test(l)), 'links only to npm and github: ' + links)
  await act(async () => { root.unmount() })
  for (const d of h.disposers) d()
})

test('Check now posts to refresh with the required header; Ignore posts to ignore', async () => {
  const h = makeCtx()
  plugin.apply(h.ctx)
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const posts = []
  const prev = globalThis.fetch
  globalThis.fetch = async (url, init) => { if (init && init.method === 'POST') posts.push([String(url), init.headers['x-requested-with'], JSON.parse(init.body)]); return prev(url, init) }
  await act(async () => { root.render(React.createElement(h.tabs[0].component, { visible: true })) })
  await flush()
  const ignore = async () => {
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'More')
    await act(async () => { more.click() })
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Ignore this version')
    await act(async () => { btn.click() })
  }
  await ignore()
  await flush()
  assert.deepEqual(posts[0], ['/dsh-plugin-updates/api/ignore', 'dsh-plugin-updates', { pkg: 'dsh-better-sidebar' }])
  const check = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Check now')
  await act(async () => { check.click() })
  await flush()
  assert.ok(posts.some((p) => p[0].endsWith('/refresh') && p[1] === 'dsh-plugin-updates'))
  globalThis.fetch = prev
  await act(async () => { root.unmount() })
  for (const d of h.disposers) d()
})

test('settings section component mounts and renders the stored values', async () => {
  const h = makeCtx()
  plugin.apply(h.ctx)
  const Comp = h.sections[0].r.component
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(React.createElement(Comp)) })
  await flush()
  assert.match(host.textContent, /Settings mode: forms/)
  assert.match(host.textContent, /Check interval/)
  assert.match(host.textContent, /Holds/)
  assert.ok(host.querySelector('textarea').value.includes('>=1'))
  await act(async () => { root.unmount() })
  for (const d of h.disposers) d()
})
