/** Defaults, seeds and the settings schema. No harness imports at module load. */

export const PLUGIN_ID = 'dsh-plugin-updates'
export const ROW_ID = 'plugin-updates'
export const PACKAGE_NAME = 'dsh-plugin-updates'
export const ALLOWED_HOSTS = Object.freeze(['registry.npmjs.org', 'api.github.com'])

/** Versions or ranges to avoid, from the audit. Value: a semver range, optionally "<range> when dsh <host range>". */
export const SEED_HOLDS = Object.freeze({
  'dsh-element-source': '>=0.2.0',
  'dsh-better-sidebar': '>=0.19.0 <0.28.0',
  'dsh-augmentor': '>=0.2.0',
  '@weibaohui/dsh-continue': '>=0.3.2 when dsh <0.2.0-0',
  // The author's declared ranges for 0.7.11 and later include 0.1.x, but those builds target the 0.1.7 seams.
  '@perrylink/dsh-github': '>=0.7.11 when dsh <0.1.7-0',
})

/** Local folder or package name to "owner/repo[@base]" (base: version or commit prefix, default the local package.json version). */
export const SEED_UPSTREAM = Object.freeze({
  'dsh-session-pin': 'PerryLink/dsh-session-pin',
  'dsh-ego-browser': 'Fisfzy/dsh-ego-browser',
  'dsh-adaptive-reasoning': 'ManoloRemiddi/dsh-adaptive-reasoning',
  'dsh-model-picker-table': 'ManoloRemiddi/dsh-model-picker-augmented@1.1.2',
  'dsh-session-manager': 'dream12347/dsh-session-manager',
  'dsh-augmentor': 'ManoloRemiddi/augmentor-agent',
})

export const SEED_NOTES = Object.freeze({
  'dsh-session-pin': 'The upstream repository is archived; its last release is final. Keep the local fork as the fallback.',
  'dsh-element-source': 'Release 0.2.x works only in the desktop app webview. On the web UI use 0.1.1.',
  'dsh-better-sidebar': 'Go straight to the build that matches the new core; the 0.19 to 0.27 builds are stepping stones.',
  '@perrylink/dsh-github': 'A fresh resolve of a caret range jumps to the 0.2.x line builds. Pin the version exactly while the core is 0.1.x.',
  'dsh-augmentor': 'The plugin, its companion and the browser extension move together as one set.',
})

export const DEFAULTS = Object.freeze({
  enabled: true,
  intervalHours: 12,
  initialDelaySeconds: 60,
  registry: 'https://registry.npmjs.org',
  allowHosts: [],
  githubTokenEnv: '',
  channels: ['latest'],
  holds: { ...SEED_HOLDS },
  upstream: { ...SEED_UPSTREAM },
  notes: { ...SEED_NOTES },
  afterInstall: {},
  checkOwnRemotes: false,
  snoozeDays: 7,
  badge: true,
  badgeCountsIncompatible: false,
  chatNotice: false,
  runningDshVersion: '',
})

/** Settings schema with live fields (DSH 0.2.x forms and 0.1.5 register both read it). */
export function settingsSchema(z, liveObject) {
  if (!z) return undefined
  const D = DEFAULTS
  return liveObject(z, {
    enabled: z.boolean().default(D.enabled).description('Master switch. Off stops the checks; the tab keeps the last result.'),
    intervalHours: z.number().default(D.intervalHours).description('Hours between automatic checks (minimum 1).'),
    initialDelaySeconds: z.number().default(D.initialDelaySeconds).description('Seconds to wait after start before the first check.'),
    registry: z.string().default(D.registry).description('Package registry base URL. Must be on the host allowlist.'),
    allowHosts: z.array(z.string()).default([...D.allowHosts]).description('Extra hosts that may be contacted (explicit opt-in).'),
    githubTokenEnv: z.string().default(D.githubTokenEnv).description('NAME of an environment variable that holds a GitHub token. Never the token itself.'),
    channels: z.array(z.string()).default([...D.channels]).description('Registry dist-tags to watch. Anything but latest is shown, never counted in the badge.'),
    holds: z.dict(z.string()).default({ ...D.holds }).description('Package name to a semver range to avoid, e.g. ">=0.2.0".'),
    upstream: z.dict(z.string()).default({ ...D.upstream }).description('Local plugin folder or package name to "owner/repo" of its upstream.'),
    notes: z.dict(z.string()).default({ ...D.notes }).description('Per package notes shown next to the result.'),
    afterInstall: z.dict(z.string()).default({ ...D.afterInstall }).description('Per package reminder printed with the apply command (for example a patch script to re-run).'),
    checkOwnRemotes: z.boolean().default(D.checkOwnRemotes).description('Compare plain local plugins with their github.com origin.'),
    snoozeDays: z.number().default(D.snoozeDays).description('Default snooze length in days.'),
    badge: z.boolean().default(D.badge).description('Show the count badge on the Updates tab.'),
    badgeCountsIncompatible: z.boolean().default(D.badgeCountsIncompatible).description('Also count updates that need a newer core.'),
    chatNotice: z.boolean().default(D.chatNotice).description('Post one short notice per new finding set, at most once a day.'),
    runningDshVersion: z.string().default(D.runningDshVersion).description('Test override of the detected DSH version. Leave empty.'),
  })
}

const str = (v, d = '') => (typeof v === 'string' ? v.trim() : d)
function strDict(v) {
  const out = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && val.trim() && k.length < 200) out[k] = val.trim().slice(0, 500)
  }
  return out
}
function strList(v, d) {
  if (!Array.isArray(v)) return [...d]
  return [...new Set(v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))]
}

/** Normalize whatever the settings store returned into safe values. Never throws. */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const D = DEFAULTS
  const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d }
  const channels = strList(r.channels, D.channels)
  return {
    enabled: r.enabled === undefined ? D.enabled : r.enabled !== false,
    intervalHours: num(r.intervalHours, D.intervalHours, 1, 24 * 30),
    initialDelaySeconds: num(r.initialDelaySeconds, D.initialDelaySeconds, 0, 3600),
    registry: str(r.registry, D.registry) || D.registry,
    allowHosts: strList(r.allowHosts, D.allowHosts).filter((h) => /^[a-z0-9.-]{1,253}$/i.test(h)).map((h) => h.toLowerCase()),
    githubTokenEnv: /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(str(r.githubTokenEnv)) ? str(r.githubTokenEnv) : '',
    channels: channels.includes('latest') ? channels : ['latest', ...channels],
    holds: r.holds === undefined ? { ...D.holds } : strDict(r.holds),
    upstream: r.upstream === undefined ? { ...D.upstream } : strDict(r.upstream),
    notes: r.notes === undefined ? { ...D.notes } : strDict(r.notes),
    afterInstall: strDict(r.afterInstall),
    checkOwnRemotes: r.checkOwnRemotes === true,
    snoozeDays: num(r.snoozeDays, D.snoozeDays, 1, 365),
    badge: r.badge === undefined ? D.badge : r.badge !== false,
    badgeCountsIncompatible: r.badgeCountsIncompatible === true,
    chatNotice: r.chatNotice === true,
    runningDshVersion: str(r.runningDshVersion),
  }
}
