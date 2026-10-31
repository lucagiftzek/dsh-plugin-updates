/**
 * dsh-plugin-updates, browser half.
 *
 *   Poll       a module-level poll of GET status every 60 s, started in apply(),
 *              so the Updates badge stays live while the tab is closed.
 *   Tab        "Updates" in better-sidebar (OPTIONAL: no better-sidebar, no tab,
 *              no error). Table of packages with link and copy buttons.
 *   Settings   a Settings section through the settings.section slot.
 *
 * The client is read-mostly: its POSTs (check now, ignore, snooze, settings) only
 * change the plugin's own state. It never runs a command: "Copy command" puts
 * the suggested text on the clipboard. Purity: no @deepseek-ai/* imports.
 */
import { useEffect, useRef, useState } from 'react'

const PLUGIN = 'dsh-plugin-updates'
const TAB_ID = 'dsh-plugin-updates:list'
const API = '/dsh-plugin-updates/api'
const POLL_MS = 60000

// ---------------------------------------------------------------- shared state

const S = { status: null, list: null, error: null, subs: new Set(), timer: null, busy: false }
const notify = () => { for (const f of S.subs) { try { f() } catch {} } }

async function api(path, body) {
  const init = { credentials: 'same-origin', headers: { accept: 'application/json' } }
  if (body !== undefined) {
    init.method = 'POST'
    init.headers = { ...init.headers, 'content-type': 'application/json', 'x-requested-with': PLUGIN }
    init.body = JSON.stringify(body)
  }
  const r = await fetch(API + path, init)
  const j = await r.json().catch(() => ({ ok: false, message: 'HTTP ' + r.status }))
  if (!r.ok || j.ok === false) { const e = new Error(j.message || j.error || 'HTTP ' + r.status); e.code = j.code; e.hint = j.hint; throw e }
  return j
}

async function pollStatus() {
  try { S.status = await api('/status'); S.error = null } catch (e) { S.error = e.message || String(e) }
  notify()
}
async function loadList() {
  try { const j = await api('/list?scope=all'); S.list = j.packages; S.status = j.status; S.error = null } catch (e) { S.error = e.message || String(e) }
  notify()
}
function startPoll() {
  if (typeof setInterval !== 'function' || S.timer) return
  void pollStatus()
  S.timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void pollStatus() }, POLL_MS)
  if (S.timer && typeof S.timer.unref === 'function') S.timer.unref()
}
function stopPoll() { if (S.timer) { clearInterval(S.timer); S.timer = null } }

function useShared() {
  const [, set] = useState(0)
  useEffect(() => { const f = () => set((x) => x + 1); S.subs.add(f); return () => { S.subs.delete(f) } }, [])
  return S
}

export const badgeValue = () => {
  const s = S.status
  if (!s || !s.badgeEnabled) return null
  return s.badge > 0 ? s.badge : null
}

// ---------------------------------------------------------------- formatting

const GROUPS = [
  ['Actionable now', (r) => r.status === 'update-compatible' || r.status === 'no-declared-range'],
  ['Needs a newer core', (r) => r.status === 'update-needs-newer-core' || r.status === 'update-needs-older-core'],
  ['Held, ignored or snoozed', (r) => ['held', 'ignored', 'snoozed'].includes(r.status)],
  ['Local (own or forked)', (r) => r.kind === 'local' && !['update-compatible', 'no-declared-range', 'update-needs-newer-core'].includes(r.status)],
  ['Unreachable or manual', (r) => r.status === 'unreachable' || r.status === 'manual' || r.status === 'unknown'],
  ['Up to date', (r) => r.status === 'up-to-date'],
]
const CHIP = {
  'up-to-date': ['ok', 'up to date'], 'update-compatible': ['good', 'update'], 'no-declared-range': ['warn', 'verify by hand'],
  'update-needs-newer-core': ['info', 'needs newer core'], 'update-needs-older-core': ['info', 'needs older core'],
  held: ['info', 'held'], snoozed: ['mute', 'snoozed'], ignored: ['mute', 'ignored'], unreachable: ['bad', 'unreachable'],
  unknown: ['warn', 'unknown'], manual: ['mute', 'manual'], local: ['mute', 'local'],
}
function ago(ms) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return s + ' s ago'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  if (s < 172800) return Math.round(s / 3600) + ' h ago'
  return Math.round(s / 86400) + ' d ago'
}

const CSS = `
.plu{--ink:var(--dsw-alias-label-primary,inherit);--ink2:var(--dsw-alias-label-secondary,inherit);--line:var(--dsw-alias-border-l2,rgba(128,128,128,.28));--brand:var(--dsw-alias-brand-primary,#4d6bfe);--bad:var(--dsw-alias-state-error-primary,#cf3b3b);--bg:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));
 display:flex;flex-direction:column;height:100%;min-height:0;font:13px/1.45 system-ui,sans-serif;color:var(--ink)}
.plu *{box-sizing:border-box}
.plu-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--line)}
.plu-head .t{font-weight:600}.plu-head .s{color:var(--ink2);font-size:12px}
.plu-body{flex:1;min-height:0;overflow:auto;padding:8px 12px 16px}
.plu h4{margin:14px 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink2)}
.plu table{width:100%;border-collapse:collapse}
.plu td,.plu th{padding:6px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:12.5px}
.plu th{color:var(--ink2);font-weight:500}
.plu .nm{font-weight:600;word-break:break-all}.plu .sub{color:var(--ink2);font-size:11.5px}
.plu .chip{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--line);white-space:nowrap}
.plu .chip.good{border-color:#2f9e5b;color:#2f9e5b}.plu .chip.warn{border-color:#c28a1e;color:#c28a1e}.plu .chip.bad{border-color:var(--bad);color:var(--bad)}.plu .chip.info{border-color:var(--brand);color:var(--brand)}
.plu button,.plu a.btn{font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block;margin:0 4px 4px 0}
.plu button:hover,.plu a.btn:hover{border-color:var(--brand)}
.plu button.pri{background:var(--brand);border-color:var(--brand);color:#fff}
.plu button:disabled{opacity:.5;cursor:default}
.plu pre{margin:4px 0 0;padding:6px 8px;border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:11.5px}
.plu .err{color:var(--bad);padding:8px 12px}
.plu .toast{position:sticky;bottom:6px;margin-top:8px;padding:6px 10px;border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:8px;background:var(--bg)}
.plu label{display:flex;gap:8px;align-items:center;margin:6px 0}.plu input[type=text],.plu input[type=number],.plu textarea{font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--ink)}
.plu textarea{width:100%;min-height:70px;font-family:ui-monospace,monospace;font-size:11.5px}
`
function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('dsh-plugin-updates-css')) return
  const s = document.createElement('style'); s.id = 'dsh-plugin-updates-css'; s.textContent = CSS; document.head.appendChild(s)
}

// ---------------------------------------------------------------- tab

function useToast() {
  const [msg, set] = useState('')
  const t = useRef(null)
  const flash = (m) => { set(m); if (t.current) clearTimeout(t.current); t.current = setTimeout(() => set(''), 3200) }
  useEffect(() => () => { if (t.current) clearTimeout(t.current) }, [])
  return [msg, flash]
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

function Row({ r, flash, reload }) {
  const [open, setOpen] = useState(false)
  const [cls, label] = CHIP[r.status] || ['mute', r.status]
  const act = async (path, body, okMsg) => { try { await api(path, body); flash(okMsg); await reload() } catch (e) { flash((e.code ? e.code + ': ' : '') + e.message) } }
  const cand = r.candidate && r.candidate.version
  const links = r.links || {}
  return (
    <>
      <tr>
        <td><div className="nm">{r.name}</div><div className="sub">{r.kind}{r.bundled ? '' : ', not in bundles'}</div></td>
        <td>{r.installed || '?'}</td>
        <td>{cand || r.latest || '-'}{r.blockedLatest ? <div className="sub">newer {r.blockedLatest.version} needs a newer core</div> : null}</td>
        <td><span className={'chip ' + cls}>{label}</span></td>
        <td><button type="button" onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button></td>
      </tr>
      {open ? (
        <tr><td colSpan={5}>
          <div className="sub">{r.userReason || r.reason}</div>
          {r.caretTrap ? <div className="sub" style={{ color: 'var(--bad)' }}>{r.caretTrap.reason}</div> : null}
          {r.hold ? <div className="sub">hold: {r.hold}</div> : null}
          {r.note ? <div className="sub">note: {r.note}</div> : null}
          {r.code ? <div className="sub">code: {r.code}</div> : null}
          {r.manualHint ? <div className="sub">{r.manualHint}</div> : null}
          {r.afterInstall ? <div className="sub">after installing: {r.afterInstall}</div> : null}
          {r.applyHint ? <pre>{r.applyHint}</pre> : null}
          <div style={{ marginTop: 6 }}>
            {r.applyHint ? <button type="button" className="pri" onClick={async () => flash((await copyText(r.applyHint)) ? 'Command copied. Nothing was run.' : 'Copy failed, select the text above.')}>Copy command</button> : null}
            {links.npm ? <a className="btn" href={links.npm} target="_blank" rel="noreferrer">npm</a> : null}
            {links.releases ? <a className="btn" href={links.releases} target="_blank" rel="noreferrer">Releases</a> : null}
            {links.changelog ? <a className="btn" href={links.changelog} target="_blank" rel="noreferrer">Changelog</a> : null}
            {links.compare ? <a className="btn" href={links.compare} target="_blank" rel="noreferrer">Compare</a> : null}
            {['update-compatible', 'no-declared-range', 'update-needs-newer-core', 'update-needs-older-core'].includes(r.status) ? <>
              <button type="button" onClick={() => act('/ignore', { pkg: r.name }, 'Version ignored')}>Ignore this version</button>
              <button type="button" onClick={() => act('/snooze', { pkg: r.name, days: 7 }, 'Snoozed 7 days')}>Snooze 7 days</button>
            </> : null}
            {r.status === 'ignored' || r.status === 'snoozed' ? <button type="button" onClick={() => act('/unignore', { pkg: r.name }, 'Restored')}>Restore</button> : null}
          </div>
        </td></tr>
      ) : null}
    </>
  )
}

function UpdatesView({ visible = true }) {
  const st = useShared()
  const [msg, flash] = useToast()
  useEffect(() => { injectCss() }, [])
  useEffect(() => {
    if (!visible) return undefined
    void loadList()
    const t = setInterval(() => { void loadList() }, 30000)
    return () => clearInterval(t)
  }, [visible])
  const status = st.status
  const rows = st.list || []
  const checkNow = async () => {
    try {
      await api('/refresh', {})
      flash('Check started')
      for (let i = 0; i < 90; i++) { await new Promise((r) => setTimeout(r, 2000)); await loadList(); if (!(S.status && S.status.checking)) break }
      flash('Check finished')
    } catch (e) { flash((e.code ? e.code + ': ' : '') + e.message) }
  }
  return (
    <div className="plu">
      <div className="plu-head">
        <span className="t">Plugin updates</span>
        <span className="s">{status ? `DSH ${status.running.version || 'unknown'}${status.noGate ? ' (no gate on this core)' : ''}, checked ${ago(status.checkedAt)}${status.checking ? ', checking...' : ''}` : 'loading'}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="pri" disabled={!status || status.checking || !status.enabled} onClick={checkNow}>Check now</button>
      </div>
      {st.error ? <div className="err">{st.error}</div> : null}
      <div className="plu-body">
        {status && status.lastSweep && status.lastSweep.errors.length ? <div className="sub">{status.lastSweep.errors.length} problem(s) in the last check: {[...new Set(status.lastSweep.errors.map((e) => e.code))].join(', ')}</div> : null}
        {GROUPS.map(([title, pick]) => {
          const g = rows.filter(pick)
          if (!g.length) return null
          return (
            <div key={title}>
              <h4>{title} ({g.length})</h4>
              <table><thead><tr><th>Package</th><th>Installed</th><th>Available</th><th>Status</th><th /></tr></thead>
                <tbody>{g.map((r) => <Row key={r.name} r={r} flash={flash} reload={loadList} />)}</tbody></table>
            </div>
          )
        })}
        {!rows.length && !st.error ? <div className="sub" style={{ padding: 12 }}>{status && status.checkedAt ? 'No packages.' : 'No result yet. The first check runs a minute after start, or press Check now.'}</div> : null}
        {msg ? <div className="toast" role="status">{msg}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- settings section

const SCALARS = [['enabled', 'boolean', 'Enabled'], ['intervalHours', 'number', 'Check interval (hours)'], ['badge', 'boolean', 'Show the badge'], ['badgeCountsIncompatible', 'boolean', 'Badge also counts updates that need a newer core'], ['checkOwnRemotes', 'boolean', 'Compare own plugins with their GitHub origin'], ['chatNotice', 'boolean', 'Post a daily notice in a chat'], ['githubTokenEnv', 'text', 'Name of the environment variable holding a GitHub token']]
const DICTS = [['holds', 'Holds (package to range to avoid)'], ['upstream', 'Upstream (local plugin to owner/repo)'], ['notes', 'Notes (package to text)'], ['afterInstall', 'After install reminders']]

function SettingsSection() {
  const [cfg, setCfg] = useState(null)
  const [err, setErr] = useState('')
  const [msg, flash] = useToast()
  const [dicts, setDicts] = useState({})
  useEffect(() => { injectCss() }, [])
  const load = async () => {
    try { const j = await api('/settings'); setCfg(j); setDicts(Object.fromEntries(DICTS.map(([k]) => [k, JSON.stringify(j.values[k] || {}, null, 2)]))) } catch (e) { setErr(e.message) }
  }
  useEffect(() => { void load() }, [])
  const save = async (patch) => { try { await api('/settings', { patch }); flash('Saved'); await load() } catch (e) { flash((e.code ? e.code + ': ' : '') + e.message) } }
  if (err) return <div className="plu" style={{ height: 'auto' }}><div className="err">{err}</div></div>
  if (!cfg) return <div className="plu" style={{ height: 'auto' }}><div className="sub" style={{ padding: 12 }}>Loading</div></div>
  return (
    <div className="plu" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="plu-body" style={{ overflow: 'visible' }}>
        <div className="sub">Settings mode: {cfg.mode}{cfg.writable ? '' : ' (read-only here, edit the profile row)'}. Only registry.npmjs.org and api.github.com are contacted.</div>
        {SCALARS.map(([k, type, label]) => (
          <label key={k}>
            {type === 'boolean' ? <input type="checkbox" checked={Boolean(cfg.values[k])} disabled={!cfg.writable} onChange={(e) => save({ [k]: e.target.checked })} />
              : <input type={type === 'number' ? 'number' : 'text'} defaultValue={cfg.values[k]} disabled={!cfg.writable} onBlur={(e) => { const v = type === 'number' ? Number(e.target.value) : e.target.value; if (v !== cfg.values[k]) void save({ [k]: v }) }} />}
            <span>{label}</span>
          </label>
        ))}
        {DICTS.map(([k, label]) => (
          <div key={k}>
            <h4>{label}</h4>
            <textarea value={dicts[k] || '{}'} disabled={!cfg.writable} onChange={(e) => setDicts({ ...dicts, [k]: e.target.value })} />
            <button type="button" disabled={!cfg.writable} onClick={() => { try { void save({ [k]: JSON.parse(dicts[k] || '{}') }) } catch { flash('Not valid JSON') } }}>Save {k}</button>
          </div>
        ))}
        {msg ? <div className="toast" role="status">{msg}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- plugin contract

const tabIcon = (size = 16) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2v7M5 6.5L8 9.5l3-3M3 11.5v1.5h10v-1.5" />
  </svg>
)

/** Register the Updates tab on a better-sidebar service. Never throws. */
export function registerTab(c) {
  try {
    const sb = c && c.betterSidebar
    if (!sb || typeof sb.registerTab !== 'function') return
    const make = () => sb.registerTab({
      id: TAB_ID, title: 'Updates', order: 94, single: true, icon: tabIcon,
      badge: () => badgeValue(),
      component: (props) => <UpdatesView visible={props.visible !== false} />,
    })
    if (typeof c.effect === 'function') c.effect(make, `${PLUGIN}: Updates sidebar tab`)
    else { const d = make(); if (typeof c.on === 'function') c.on('dispose', () => { try { d() } catch {} }) }
  } catch (e) { console.warn('[dsh-plugin-updates] sidebar tab not registered: ' + String((e && e.message) || e)) }
}

export const inject = ['slots']

export function apply(ctx) {
  injectCss()
  ctx.effect(() => { startPoll(); return () => stopPoll() }, `${PLUGIN}: status poll`)
  // better-sidebar is OPTIONAL: no service, no tab, no error.
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['betterSidebar'], (c) => registerTab(c)) } catch (e) { console.warn('[dsh-plugin-updates] sidebar unavailable: ' + String((e && e.message) || e)) }
  }
  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.effect(() => {
      const d = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: PLUGIN, order: 64, label: () => 'Plugin updates', inject: () => ({}),
      }, function UpdatesSettingsSlot() { return <SettingsSection /> }))
      return typeof d === 'function' ? d : () => {}
    }, `${PLUGIN}: settings section`)
  }
}

export const __internals = { S, GROUPS, CHIP, startPoll, stopPoll, pollStatus }
