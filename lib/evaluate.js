/**
 * Evaluate every inventory item against its source and the running DSH.
 * Pure orchestration over net (allowlisted fetch), sources and compat.
 * Nothing here writes outside the plugin state and nothing runs a process.
 */
import { gate, decide } from './compat.js'
import { fetchPackument, createGithub, tagVersion } from './sources.js'
import { parseUpstream, githubRemote } from './classify.js'
import { buildApply, buildLinks } from './apply.js'
import { E } from './errors.js'

const MAX_TAGS = 3
const mapPool = async (items, n, fn) => {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k) }
  }))
  return out
}

function base(it, cfg) {
  return {
    name: it.name, kind: it.cls.kind === 'manual' ? 'manual' : it.cls.kind, spec: it.spec, bundled: it.bundled,
    installed: it.installed || '', installedCommit: it.installedCommit || undefined,
    latest: '', latestCompatible: '', status: 'unknown', reason: '', candidate: null,
    note: cfg.notes[it.name] || undefined, hold: cfg.holds[it.name] || undefined,
    links: {}, checkedAt: new Date().toISOString(),
  }
}

function errorResult(r, e) {
  const b = E.from(e)
  return { ...r, status: 'unreachable', reason: b.message, code: b.code, retryAfterSec: b.retryAfterSec, hint: b.hint }
}

function userStateFor(state, name, now) {
  return { ignored: state.data.ignored[name] || '', snoozedUntil: state.data.snoozed[name] || 0, now }
}

function mergeDecision(r, dec, it, ctx) {
  r.latest = dec.latest ? dec.latest.version : ''
  r.latestCompatible = dec.latestCompatible ? dec.latestCompatible.version : ''
  r.status = dec.status
  r.baseStatus = dec.baseStatus
  r.reason = dec.reason
  r.candidate = dec.candidate ? { version: dec.candidate.version, ref: dec.candidate.ref, verdict: dec.candidate.gate && dec.candidate.gate.verdict, ranges: dec.candidate.gate && dec.candidate.gate.ranges } : null
  if (dec.blockedLatest) r.blockedLatest = dec.blockedLatest
  if (dec.heldVersions && dec.heldVersions.length) r.heldVersions = dec.heldVersions
  const wantsApply = ['update-compatible', 'no-declared-range', 'update-needs-newer-core', 'update-needs-older-core', 'ignored', 'snoozed', 'held'].includes(r.status) && dec.candidate
  const forApply = dec.baseStatus ? dec.baseStatus : r.status
  if (dec.candidate && ['update-compatible', 'no-declared-range'].includes(forApply)) {
    const a = buildApply({ name: it.name, kind: r.kind, cls: it.cls }, dec.candidate, { profileName: ctx.profileName, installed: it.installed })
    r.applyHint = a.applyHint || undefined
    r.manualHint = a.manualHint || undefined
    if (r.applyHint && ctx.cfg.afterInstall[it.name]) r.afterInstall = ctx.cfg.afterInstall[it.name]
    if (r.kind === 'local' && ctx.cfg.afterInstall[it.name]) r.afterInstall = ctx.cfg.afterInstall[it.name]
  } else if (wantsApply && dec.candidate && ['update-needs-newer-core', 'update-needs-older-core'].includes(r.status)) {
    r.manualHint = 'This version cannot be taken by the running DSH. It becomes applicable after the core is updated.'
  }
  return r
}

async function evalRegistry(it, r, ctx) {
  const { net, cfg, sv, running, state, now } = ctx
  const name = it.cls.alias || it.name
  const pk = await fetchPackument(net, cfg, sv, name)
  if (!pk) { r.status = 'unknown'; r.reason = 'the package is not on the registry (private, renamed or removed)'; return r }
  const candidates = Object.entries(pk.versions).map(([version, meta]) => ({ version, meta }))
  const dec = decide(candidates, { sv, running, installed: it.installed, hold: cfg.holds[it.name], userState: userStateFor(state, it.name, now) })
  mergeDecision(r, dec, it, ctx)
  r.dependencyLatestTag = pk.distTags.latest || undefined
  if (pk.distTags.latest && !dec.latest) r.latest = pk.distTags.latest

  // extra channels: shown, never counted
  const channels = {}
  for (const ch of cfg.channels) {
    if (ch === 'latest') continue
    const v = pk.distTags[ch]
    if (v && it.installed && sv.valid(it.installed) && sv.gt(v, it.installed)) channels[ch] = { version: v, gate: gate(sv, running, pk.versions[v]).verdict }
  }
  if (Object.keys(channels).length) r.channels = channels

  // caret trap: what a plain re-resolve of the declared range would install
  const range = it.cls.range
  if (range && it.installed && sv.valid(it.installed)) {
    const stableAll = Object.keys(pk.versions).filter((v) => !sv.prerelease(v))
    const resolves = it.cls.tag ? pk.distTags[it.cls.tag] : sv.maxSatisfying(stableAll, range)
    if (resolves && sv.gt(resolves, it.installed)) {
      const g = gate(sv, running, pk.versions[resolves])
      if (g.verdict === 'fail') r.caretTrap = { resolves, reason: `a fresh resolve of "${it.spec}" would pick ${resolves}, which this DSH cannot take`, direction: g.direction }
    }
  }
  r.links = buildLinks({ ...it, kind: 'registry' }, it.installed, dec.candidate)
  return r
}

async function gitCandidates(gh, owner, repo, { sv, running, installed, installedCommit, tagCandidates }) {
  const tags = (await gh.tags(owner, repo)).map((t) => ({ ...t, version: tagVersion(sv, t.name) })).filter((t) => t.version && !sv.prerelease(t.version))
  tags.sort((a, b) => sv.rcompare(a.version, b.version))
  const newer = tags.filter((t) => !installed || !sv.valid(installed) || sv.gt(t.version, installed))
  const head = await gh.headSha(owner, repo)
  const cands = []
  for (const t of newer.slice(0, MAX_TAGS)) {
    const pkg = await gh.packageAt(owner, repo, t.name)
    cands.push({ version: t.version, ref: { kind: 'tag', value: t.name, tag: t.name }, meta: pkg ? pkg.meta : {} })
    const g = gate(sv, running, pkg ? pkg.meta : {})
    if (g.verdict === 'pass' || g.verdict === 'none') break
  }
  let headPkg = null
  const needHead = head && head !== installedCommit
  if (needHead) {
    headPkg = await gh.packageAt(owner, repo, '')
    if (headPkg && headPkg.version && installed && sv.valid(installed) && sv.gt(headPkg.version, installed) && !cands.some((c) => c.version === headPkg.version)) {
      cands.push({ version: headPkg.version, ref: { kind: 'head', value: head }, meta: headPkg.meta })
    }
  }
  return { cands, head, tags, headPkg }
}

async function evalGithub(it, r, ctx) {
  const { cfg, sv, running, state, now } = ctx
  const gh = ctx.gh
  const { owner, repo, ref } = it.cls
  it.upstreamRepo = { owner, repo }
  it.installedTag = ref && /^v?\d/.test(ref) ? ref : undefined
  const { cands, head, tags } = await gitCandidates(gh, owner, repo, { sv, running, installed: it.installed, installedCommit: it.installedCommit })
  const dec = decide(cands, { sv, running, installed: it.installed, hold: cfg.holds[it.name], userState: userStateFor(state, it.name, now) })
  mergeDecision(r, dec, it, ctx)
  if (!r.latest && tags[0]) r.latest = tags[0].version
  if (head) r.headSha = head
  if (head && it.installedCommit && head !== it.installedCommit && r.status === 'up-to-date') r.unreleasedCommits = true
  if (r.unreleasedCommits) r.reason = 'default branch has newer commits at the same version'
  r.links = { ...buildLinks({ ...it, kind: 'github' }, it.installed, dec.candidate) }
  return r
}

async function evalRelease(it, r, ctx) {
  const { cfg, sv, running, state, now, gh } = ctx
  const { owner, repo, tag } = it.cls
  it.upstreamRepo = { owner, repo }
  it.installedTag = tag
  const rels = (await gh.releases(owner, repo)).filter((x) => !x.draft && !x.prerelease)
    .map((x) => ({ ...x, version: tagVersion(sv, x.tag) })).filter((x) => x.version && !sv.prerelease(x.version))
  rels.sort((a, b) => sv.rcompare(a.version, b.version))
  const newer = rels.filter((x) => !it.installed || !sv.valid(it.installed) || sv.gt(x.version, it.installed))
  const cands = []
  for (const x of newer.slice(0, MAX_TAGS)) {
    const pkg = await gh.packageAt(owner, repo, x.tag)
    cands.push({ version: x.version, ref: { kind: 'release', value: x.tag, tag: x.tag, assets: x.assets }, meta: pkg ? pkg.meta : {} })
    const g = gate(sv, running, pkg ? pkg.meta : {})
    if (g.verdict === 'pass' || g.verdict === 'none') break
  }
  const dec = decide(cands, { sv, running, installed: it.installed, hold: cfg.holds[it.name], userState: userStateFor(state, it.name, now) })
  mergeDecision(r, dec, it, ctx)
  if (!r.latest && rels[0]) r.latest = rels[0].version
  r.links = buildLinks({ ...it, kind: 'release' }, it.installed, dec.candidate)
  return r
}

function findUpstream(it, cfg) {
  const l = it.local || {}
  for (const key of [it.name, l.pkgName, l.dirName]) {
    if (key && cfg.upstream[key]) return parseUpstream(cfg.upstream[key])
  }
  return null
}

const GATE_STATUS = (g, hasCandidate) => {
  if (!hasCandidate) return 'up-to-date'
  if (g.verdict === 'pass') return 'update-compatible'
  if (g.verdict === 'none') return 'no-declared-range'
  if (g.verdict === 'fail') return g.direction === 'older' ? 'update-needs-older-core' : 'update-needs-newer-core'
  return 'unknown'
}

async function evalLocal(it, r, ctx) {
  const { cfg, sv, running, state, now, gh } = ctx
  const l = it.local || {}
  r.localGit = l.git ? { sha: l.sha ? l.sha.slice(0, 12) : '', branch: l.branch || '' } : undefined
  if (!l.exists) { r.status = 'unknown'; r.reason = 'the linked folder or its package.json is missing'; return r }
  const up = findUpstream(it, cfg)
  if (up) {
    r.upstream = `${up.owner}/${up.repo}`
    it.upstreamRepo = { owner: up.owner, repo: up.repo }
    const hexBase = /^[0-9a-f]{7,40}$/i.test(up.base) && !sv.valid(up.base)
    const baseVersion = up.base && !hexBase && sv.valid(up.base) ? sv.valid(up.base) : it.installed
    const { cands, head, tags, headPkg } = await gitCandidates(gh, up.owner, up.repo, { sv, running, installed: baseVersion, installedCommit: hexBase ? up.base : undefined })
    if (head) r.headSha = head
    r.baseVersion = baseVersion
    // same commit as upstream: nothing to do whatever the version says
    if (head && l.sha && head === l.sha) {
      r.status = 'up-to-date'; r.reason = 'the local folder is at the upstream head'
      r.latest = headPkg && headPkg.version ? headPkg.version : (tags[0] ? tags[0].version : '')
      r.links = buildLinks({ ...it, kind: 'local' }, it.installed, null)
      return r
    }
    const dec = decide(cands, { sv, running, installed: baseVersion, hold: cfg.holds[it.name], userState: userStateFor(state, it.name, now) })
    mergeDecision(r, dec, { ...it, kind: 'local' }, ctx)
    if (!r.latest && tags[0]) r.latest = tags[0].version
    if (r.status === 'up-to-date') r.reason = `no upstream release newer than ${baseVersion}`
    else if (r.status === 'update-compatible' || r.status === 'no-declared-range') r.reason = `upstream ${r.candidate.version} is newer than the recorded base ${baseVersion}; ${r.reason}`
    r.links = buildLinks({ ...it, kind: 'local' }, it.installed, dec.candidate)
    return r
  }
  const remote = githubRemote(l.origin)
  if (cfg.checkOwnRemotes && remote && l.sha) {
    it.upstreamRepo = remote
    r.upstream = `${remote.owner}/${remote.repo}`
    r.ownRemote = true
    const head = await gh.headSha(remote.owner, remote.repo)
    r.headSha = head
    r.links = buildLinks({ ...it, kind: 'local' }, it.installed, null)
    if (head === l.sha) { r.status = 'up-to-date'; r.reason = 'in sync with origin'; return r }
    let cmp = null
    try { cmp = await gh.compare(remote.owner, remote.repo, l.sha, head) } catch (e) { if (E.from(e).code === 'PLUPD_GITHUB_RATE_LIMITED') throw e }
    if (!cmp) { r.status = 'up-to-date'; r.reason = 'the local commit is not on origin (unpushed work)'; return r }
    if (cmp.status === 'behind' || cmp.status === 'identical') { r.status = 'up-to-date'; r.reason = `${cmp.behind || 0} local commit(s) not pushed`; return r }
    const pkg = await gh.packageAt(remote.owner, remote.repo, '')
    const g = gate(sv, running, pkg ? pkg.meta : {})
    r.status = GATE_STATUS(g, true)
    r.reason = `origin is ${cmp.ahead} commit(s) ahead${cmp.status === 'diverged' ? ' (diverged)' : ''}`
    r.latest = pkg && pkg.version ? pkg.version : ''
    r.latestCompatible = g.verdict === 'fail' ? '' : r.latest
    r.candidate = { version: r.latest, ref: { kind: 'head', value: head }, verdict: g.verdict, ranges: g.ranges }
    const us = userStateFor(state, it.name, now)
    if (['update-compatible', 'no-declared-range'].includes(r.status)) {
      r.manualHint = buildApply({ name: it.name, kind: 'local', cls: it.cls }, r.candidate).manualHint
      reapplyUserState([r], state, now)
    }
    return r
  }
  r.status = 'local'
  r.reason = cfg.checkOwnRemotes ? 'local folder without a github.com origin or commit' : 'local plugin, not checked (no upstream entry; checkOwnRemotes is off)'
  return r
}

/** Key an ignore applies to: the candidate version, or the origin head for own-remote checks. */
export function ignoreKey(r) {
  const c = r && r.candidate
  if (!c) return ''
  if (r.ownRemote && c.ref && c.ref.kind === 'head') return String(c.ref.value).slice(0, 12)
  return c.version
}

export const ACTIONABLE = ['update-compatible', 'no-declared-range', 'update-needs-newer-core', 'update-needs-older-core']

/** Re-derive ignored and snoozed after a user choice, without any network call. */
export function reapplyUserState(results, state, now = Date.now()) {
  for (const r of results) {
    const baseStatus = r.baseStatus || r.status
    if (!ACTIONABLE.includes(baseStatus) || !r.candidate) continue
    r.status = baseStatus
    delete r.baseStatus
    delete r.userReason
    const ignored = state.data.ignored[r.name]
    const snoozed = state.data.snoozed[r.name] || 0
    if (ignored && ignored === ignoreKey(r)) { r.baseStatus = baseStatus; r.status = 'ignored'; r.userReason = `version ${ignored} was ignored` }
    else if (snoozed > now) { r.baseStatus = baseStatus; r.status = 'snoozed'; r.userReason = `snoozed until ${new Date(snoozed).toISOString().slice(0, 10)}` }
  }
  return results
}

/** Evaluate all items. Returns the result list; a failed item becomes status unreachable. */
export async function evaluateAll(inv, ctx) {
  const gh = ctx.gh || createGithub(ctx.net, ctx.sv)
  const c = { ...ctx, gh }
  return mapPool(inv.items, 6, async (it) => {
    const r = base(it, ctx.cfg)
    try {
      switch (it.cls.kind) {
        case 'registry': return await evalRegistry(it, r, c)
        case 'github': return await evalGithub(it, r, c)
        case 'release': return await evalRelease(it, r, c)
        case 'local': return await evalLocal(it, r, c)
        default:
          r.status = 'manual'; r.code = 'PLUPD_SPEC_UNSUPPORTED'; r.reason = it.cls.reason || 'cannot be checked automatically'
          return r
      }
    } catch (e) { return errorResult(r, e) }
  })
}

export const COUNTED = (cfg) => (cfg.badgeCountsIncompatible ? ['update-compatible', 'update-needs-newer-core'] : ['update-compatible'])

export function summarize(results, cfg) {
  const counts = {}
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1
  const counted = COUNTED(cfg)
  return { counts, safe: results.filter((r) => r.status === 'update-compatible').length, badge: results.filter((r) => counted.includes(r.status)).length, total: results.length }
}
