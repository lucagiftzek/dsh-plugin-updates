/** Registry and GitHub lookups, reduced to the small values that get cached. */
import { reduceMeta } from './compat.js'
import { E } from './errors.js'
import { isPackageName, isRepoSeg, isTagName } from './classify.js'

const MAX_VERSIONS = 400

export function registryUrl(cfg, name) {
  if (!isPackageName(name)) throw E.raise('PLUPD_SPEC_UNSUPPORTED', { detail: 'invalid package name' })
  let base
  try { base = new URL(cfg.registry) } catch { throw E.raise('PLUPD_REGISTRY_HOST_BLOCKED', { detail: 'registry setting is not a URL' }) }
  const root = base.toString().replace(/\/+$/, '')
  return `${root}/${name.replace('/', '%2F')}`
}

/** Abbreviated packument -> { distTags, versions: { v: meta } } or null when the package does not exist. */
export async function fetchPackument(net, cfg, sv, name) {
  const url = registryUrl(cfg, name)
  const r = await net.get(url, {
    accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
    reduce: (text) => {
      const j = JSON.parse(text)
      const tags = {}
      for (const [t, v] of Object.entries(j['dist-tags'] || {})) if (typeof v === 'string' && sv.valid(v) && /^[A-Za-z0-9._-]{1,60}$/.test(t)) tags[t] = v
      const all = Object.entries(j.versions || {}).filter(([v]) => sv.valid(v))
      all.sort((a, b) => sv.rcompare(a[0], b[0]))
      const versions = {}
      for (const [v, meta] of all.slice(0, MAX_VERSIONS)) versions[v] = reduceMeta(meta)
      return { distTags: tags, versions }
    },
  })
  return r.data
}

/** Full document, used only by the detail view: publish dates and the repository link. */
export async function fetchFullDoc(net, cfg, sv, name) {
  const url = registryUrl(cfg, name)
  const r = await net.get(url, {
    cacheKey: url + '#full',
    reduce: (text) => {
      const j = JSON.parse(text)
      const time = {}
      const entries = Object.entries(j.time || {}).filter(([v, d]) => sv.valid(v) && typeof d === 'string')
      entries.sort((a, b) => sv.rcompare(a[0], b[0]))
      for (const [v, d] of entries.slice(0, 40)) time[v] = d
      let repo = null
      const ru = typeof j.repository === 'string' ? j.repository : j.repository && j.repository.url
      const m = typeof ru === 'string' && /github\.com[/:]([^/]+)\/([^/#\s]+?)(?:\.git)?(?:[#/].*)?$/i.exec(ru.replace(/^github:/, 'https://github.com/'))
      if (m && isRepoSeg(m[1]) && isRepoSeg(m[2])) repo = { owner: m[1], repo: m[2] }
      const nested = {}
      for (const [v, meta] of Object.entries(j.versions || {}).slice(-60)) { const n = meta && meta.dsh && meta.dsh.engines && meta.dsh.engines.dsh; if (typeof n === 'string' && sv.valid(v)) nested[v] = n }
      return { time, repo, nested }
    },
  })
  return r.data
}

/** Strip a tag to a version: v1.2.3, release-1.2.3, name@1.2.3. */
export function tagVersion(sv, tag) {
  const t = String(tag)
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(t) || /[@/_-]v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(t)
  return m && sv.valid(m[1]) ? sv.valid(m[1]) : null
}

export function createGithub(net, sv) {
  const base = (o, r) => {
    if (!isRepoSeg(o) || !isRepoSeg(r)) throw E.raise('PLUPD_SPEC_UNSUPPORTED', { detail: 'invalid repository name' })
    return `https://api.github.com/repos/${o}/${r}`
  }
  return {
    async tags(o, r) {
      const res = await net.get(`${base(o, r)}/tags?per_page=30`, {
        accept: 'application/vnd.github+json',
        reduce: (t) => (JSON.parse(t) || []).filter((x) => x && isTagName(x.name)).map((x) => ({ name: x.name, sha: x.commit && /^[0-9a-f]{40}$/.test(x.commit.sha) ? x.commit.sha : '' })),
      })
      return res.data || []
    },
    async releases(o, r) {
      const res = await net.get(`${base(o, r)}/releases?per_page=20`, {
        accept: 'application/vnd.github+json',
        reduce: (t) => (JSON.parse(t) || []).filter((x) => x && isTagName(x.tag_name)).map((x) => ({
          tag: x.tag_name, prerelease: Boolean(x.prerelease), draft: Boolean(x.draft),
          assets: (x.assets || []).map((a) => a && a.name).filter((n) => typeof n === 'string' && n.length < 200),
        })),
      })
      return res.data || []
    },
    async headSha(o, r) {
      const res = await net.get(`${base(o, r)}/commits/HEAD`, {
        accept: 'application/vnd.github.sha',
        reduce: (t) => { const s = String(t).trim(); if (!/^[0-9a-f]{40}$/.test(s)) throw new Error('bad sha'); return s },
      })
      return res.data || ''
    },
    /** package.json at a ref (empty = default branch HEAD) reduced to { version, meta }. */
    async packageAt(o, r, ref = '') {
      if (ref && !isTagName(ref) && !/^[0-9a-f]{7,40}$/.test(ref)) throw E.raise('PLUPD_SPEC_UNSUPPORTED', { detail: 'invalid ref' })
      const res = await net.get(`${base(o, r)}/contents/package.json${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, {
        accept: 'application/vnd.github.raw+json',
        reduce: (t) => { const j = JSON.parse(t); return { version: sv.valid(j.version) || '', meta: reduceMeta(j) } },
      })
      return res.data
    },
    async compare(o, r, baseSha, headSha) {
      if (!/^[0-9a-f]{7,40}$/.test(baseSha) || !/^[0-9a-f]{7,40}$/.test(headSha)) return null
      const res = await net.get(`${base(o, r)}/compare/${baseSha}...${headSha}`, {
        accept: 'application/vnd.github+json',
        reduce: (t) => { const j = JSON.parse(t); return { status: String(j.status || ''), ahead: Number(j.ahead_by) || 0, behind: Number(j.behind_by) || 0 } },
      })
      return res.data
    },
  }
}
