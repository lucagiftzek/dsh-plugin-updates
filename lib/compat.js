/**
 * Compatibility gate and update decision. Pure functions over a semver module.
 *
 * Gate rule (the DSH 0.2.1 loader rule): if a version declares engines.dsh, that
 * range decides alone; otherwise every peer range of @deepseek-ai/dsh and
 * @deepseek-ai/dsh-* must be satisfied by the RUNNING version
 * (semver.satisfies with includePrerelease). Optional peer meta is not honoured.
 * DSH 0.1.5 has no gate, but declared ranges are still respected here.
 */
import { createRequire } from 'node:module'
import { requireFromHarness } from './dual-settings.js'

export function loadSemver(metaUrl) {
  const fromHarness = requireFromHarness('semver', metaUrl)
  if (fromHarness && typeof fromHarness.satisfies === 'function') return fromHarness
  const own = createRequire(metaUrl || import.meta.url)('semver')
  return own
}

export const OPTS = Object.freeze({ includePrerelease: true })
const isDshPeer = (n) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-')

/** Reduce a package.json (or a registry version entry) to what the gate needs. */
export function reduceMeta(pkg) {
  const out = {}
  if (!pkg || typeof pkg !== 'object') return out
  const e = pkg.engines && typeof pkg.engines === 'object' ? pkg.engines.dsh : undefined
  if (typeof e === 'string' && e.trim()) out.e = e.trim()
  const p = {}
  const peers = pkg.peerDependencies && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {}
  for (const [n, r] of Object.entries(peers)) if (isDshPeer(n) && typeof r === 'string') p[n] = r
  if (Object.keys(p).length) out.p = p
  if (pkg.deprecated) out.d = 1
  const nested = pkg.dsh && pkg.dsh.engines && typeof pkg.dsh.engines.dsh === 'string' ? pkg.dsh.engines.dsh : ''
  if (nested) out.n = nested
  return out
}

/**
 * Verdict of one candidate against the running version.
 * @returns {{ verdict: 'pass'|'fail'|'none'|'unknown', source: 'engines'|'peers'|'none', ranges: {name:string, range:string}[], direction?: 'newer'|'older', failing?: object[] }}
 */
export function gate(sv, running, meta) {
  const m = meta || {}
  const ranges = []
  let source = 'none'
  if (m.e) { ranges.push({ name: 'engines.dsh', range: m.e }); source = 'engines' }
  else if (m.p) { for (const [n, r] of Object.entries(m.p)) ranges.push({ name: n, range: r }); if (ranges.length) source = 'peers' }
  const usable = ranges.filter((x) => sv.validRange(x.range) !== null)
  if (usable.length === 0) return { verdict: 'none', source: 'none', ranges }
  if (!running || !sv.valid(running)) return { verdict: 'unknown', source, ranges }
  const failing = usable.filter((x) => !sv.satisfies(running, x.range, OPTS))
  if (failing.length === 0) return { verdict: 'pass', source, ranges }
  const below = failing.some((x) => sv.ltr(running, x.range, OPTS))
  const above = failing.some((x) => sv.gtr(running, x.range, OPTS))
  return { verdict: 'fail', source, ranges, failing, direction: below || !above ? 'newer' : 'older' }
}

/** "<range>" or "<range> when dsh <host range>" -> { avoid, when } */
export function parseHold(value) {
  const s = String(value || '').trim()
  const m = /^(.*?)\s+when\s+dsh\s+(.+)$/i.exec(s)
  return m ? { avoid: m[1].trim(), when: m[2].trim() } : { avoid: s, when: '' }
}

/** Whether a version is held for this host. */
export function isHeld(sv, running, holdValue, version) {
  if (!holdValue) return false
  const { avoid, when } = parseHold(holdValue)
  if (!avoid || sv.validRange(avoid) === null) return false
  if (when) {
    if (sv.validRange(when) === null) return false
    if (!running || !sv.valid(running) || !sv.satisfies(running, when, OPTS)) return false
  }
  return sv.satisfies(version, avoid, OPTS)
}

/**
 * Decide the status of one package from its candidate versions.
 * @param candidates {version:string, meta?:object, ref?:any}[] every version/tag/head to consider
 * @param o {sv, running, installed, hold, userState:{ignored?:string, snoozedUntil?:number}, now}
 * Candidate versions may be prereleases; only stable ones are offered.
 */
export function decide(candidates, o) {
  const { sv, running, installed, hold } = o
  const now = o.now || Date.now()
  const view = (c) => (c ? { version: c.version, ref: c.ref, gate: c.gate } : null)
  const stable = []
  for (const c of candidates) {
    if (!sv.valid(c.version) || sv.prerelease(c.version)) continue
    if (c.meta && c.meta.d) continue
    stable.push({ ...c, gate: gate(sv, running, c.meta), held: isHeld(sv, running, hold, c.version) })
  }
  stable.sort((a, b) => sv.rcompare(a.version, b.version))
  const open = stable.filter((c) => !c.held)
  const passing = open.filter((c) => c.gate.verdict === 'pass' || c.gate.verdict === 'none')
  const latestCompatible = passing[0] || null
  const latest = stable[0] || null
  const out = { latest: view(latest), latestCompatible: view(latestCompatible), status: 'up-to-date', reason: '', candidate: null, blockedLatest: null, heldVersions: [] }
  if (!installed || !sv.valid(installed)) {
    out.status = 'unknown'; out.reason = 'installed version is not known'; return out
  }
  const gt = (c) => c && sv.gt(c.version, installed)
  const newerOpen = open.filter(gt)
  const newerHeld = stable.filter((c) => c.held && gt(c))
  out.heldVersions = newerHeld.map((c) => c.version)
  const unknownGate = newerOpen.filter((c) => c.gate.verdict === 'unknown')
  const best = passing.find(gt) || null

  if (best) {
    out.candidate = view(best)
    if (best.gate.verdict === 'none') { out.status = 'no-declared-range'; out.reason = 'the new version declares no DSH range, verify by hand' }
    else { out.status = 'update-compatible'; out.reason = best.gate.source === 'engines' ? 'engines.dsh accepts the running DSH' : 'DSH peer ranges accept the running DSH' }
    const blocked = newerOpen.find((c) => c.gate.verdict === 'fail' && sv.gt(c.version, best.version))
    if (blocked) out.blockedLatest = { version: blocked.version, direction: blocked.gate.direction, failing: blocked.gate.failing }
  } else if (unknownGate.length) {
    out.status = 'unknown'; out.reason = 'the running DSH version is unknown, compatibility cannot be judged'
    out.candidate = view(unknownGate[0])
  } else if (newerHeld.length) {
    out.status = 'held'; out.reason = 'every newer version is on the holds list'
    out.candidate = view(newerHeld[0])
  } else if (newerOpen.length) {
    const top = newerOpen[0]
    out.candidate = view(top)
    out.status = top.gate.direction === 'older' ? 'update-needs-older-core' : 'update-needs-newer-core'
    out.reason = `${top.version} declares ${top.gate.ranges.map((r) => `${r.name} ${r.range}`).join(', ')}`
  }

  // user state: ignore a version, or snooze the package
  const c = out.candidate
  const actionable = ['update-compatible', 'no-declared-range', 'update-needs-newer-core', 'update-needs-older-core']
  if (c && actionable.includes(out.status)) {
    const us = o.userState || {}
    if (us.ignored && us.ignored === c.version) { out.baseStatus = out.status; out.status = 'ignored'; out.reason = `version ${c.version} was ignored` }
    else if (us.snoozedUntil && us.snoozedUntil > now) { out.baseStatus = out.status; out.status = 'snoozed'; out.reason = `snoozed until ${new Date(us.snoozedUntil).toISOString().slice(0, 10)}` }
  }
  return out
}
