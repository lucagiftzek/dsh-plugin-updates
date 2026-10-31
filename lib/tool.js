/**
 * The read-only agent tool. agentTools(defineTool, deps) is exported so tests
 * can compile the definition with the real defineTool.
 */
import { E } from './errors.js'

const TEXT = (s) => [{ type: 'text', text: s }]
export const TOOL_NOTE = 'Never run pnpm add, pnpm update or dsh plugin add for these on your own. Present the list to the human; if they ask to apply an update, use the capped command in applyHint (memory cap included) and remind them of afterInstall steps.'

function slim(r) {
  const o = {
    name: r.name, kind: r.kind, installed: r.installed || null, latest: r.latest || null, latestCompatible: r.latestCompatible || null,
    status: r.status, reason: r.reason || '',
  }
  if (r.candidate) o.candidate = { version: r.candidate.version, ref: r.candidate.ref ? (r.candidate.ref.kind + ':' + r.candidate.ref.value) : undefined }
  if (r.blockedLatest) o.blockedLatest = { version: r.blockedLatest.version, needs: r.blockedLatest.direction === 'older' ? 'older core' : 'newer core' }
  if (r.caretTrap) o.caretTrap = r.caretTrap
  if (r.heldVersions) o.heldVersions = r.heldVersions
  if (r.hold) o.hold = r.hold
  if (r.note) o.note = r.note
  if (r.channels) o.channels = r.channels
  if (r.code) o.code = r.code
  if (r.links && Object.keys(r.links).length) o.links = r.links
  if (r.applyHint) o.applyHint = r.applyHint
  if (r.manualHint) o.manualHint = r.manualHint
  if (r.afterInstall) o.afterInstall = r.afterInstall
  return o
}

export function agentTools(defineTool, cfg, deps = {}) {
  const { engine } = deps
  const defs = []
  defs.push(defineTool({
    name: 'plugin_updates',
    description: 'Read-only report on newer releases of the DSH plugins in this profile, judged against the RUNNING DSH core '
      + '(an update that needs a newer core is never called safe). Covers registry, GitHub and link: plugins by their specifier. '
      + 'scope: actionable (default: safe updates, updates needing a newer core, caret traps), outdated, safe, held, local, all. '
      + 'Each package has status, installed, latest, latestCompatible, links and, for safe updates, applyHint (a memory-capped command). '
      + TOOL_NOTE + ' This tool never installs anything and never edits the profile.',
    parameters: {
      scope: { type: 'string', description: 'actionable | outdated | safe | held | local | all. Default actionable.' },
      package: { type: 'string', description: 'Only this package name.' },
      refresh: { type: 'boolean', description: 'Run a new check first (rate limited, 60 s cooldown). Default false: use the last result.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          headline: { type: 'string', required: true },
          running: { type: 'json' },
          checkedAt: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          packages: { type: 'json' },
          notes: { type: 'array', items: { type: 'string' } },
          code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' }, docs: { type: 'string' }, error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok === false ? `${v.code || 'error'}: ${v.message || v.error}${v.hint ? ' ' + v.hint : ''}` : [v.headline, ...(v.packages || []).map((p) => `${p.name} ${p.installed || '?'} -> ${p.candidate ? p.candidate.version : p.latest || '-'}  ${p.status}${p.reason ? ': ' + p.reason : ''}${p.applyHint ? '\n  apply: ' + p.applyHint : ''}`), ...(v.notes || [])].join('\n')),
    },
    async execute(args) {
      try {
        const scope = ['actionable', 'outdated', 'safe', 'held', 'local', 'all'].includes(args && args.scope) ? args.scope : 'actionable'
        const notes = [TOOL_NOTE]
        if (args && args.refresh === true) {
          try { await engine.refresh() } catch (e) {
            const b = E.from(e)
            if (b.code === 'PLUPD_REFRESH_COOLDOWN') notes.push('Refresh skipped: ' + b.message + ' (' + (b.retryAfterSec || 60) + ' s).')
            else return b
          }
        } else if (!engine.status().checkedAt) {
          try { await engine.sweep() } catch (e) { return E.from(e) }
        }
        const st = engine.status()
        const rows = engine.list({ scope, pkg: args && typeof args.package === 'string' ? args.package : '' })
        if (args && args.package && rows.length === 0) return E.tool('PLUPD_PACKAGE_UNKNOWN')
        if (st.noGate) notes.push('This host is DSH 0.1.x: it has no compatibility gate, so "update-compatible" means declared compatible by the package ranges, not verified.')
        if (!st.running.version) notes.push(E.codes.PLUPD_DSH_VERSION_UNKNOWN.message + '. Compatibility could not be judged.')
        const unreachable = engine.items().filter((r) => r.status === 'unreachable').length
        if (unreachable) notes.push(`${unreachable} package(s) could not be checked (status unreachable).`)
        return {
          ok: true,
          headline: `${st.summary.safe} safe update(s) of ${st.summary.total} package(s) on DSH ${st.running.version || 'unknown'}${st.checkedAt ? '' : ' (not checked yet)'}; showing ${rows.length} (${scope})`,
          running: st.running, checkedAt: st.checkedAt, packages: rows.map(slim), notes,
        }
      } catch (e) { return E.from(e) }
    },
  }))
  defs.push(defineTool({
    name: 'plugin_updates_doctor',
    description: 'Read-only self-check of the plugin updates notifier (DSH version, profile, state, hosts, last check). Returns the doctor report.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, report: { type: 'json', required: true } } },
      render: (_a, v) => TEXT(`doctor: ${v.report.status}\n` + v.report.checks.map((c) => `${c.status} ${c.id} ${c.detail || ''}${c.code ? ' [' + c.code + ']' : ''}`).join('\n')),
    },
    async execute() { return { ok: true, report: await engine.doctor() } },
  }))
  return defs
}
