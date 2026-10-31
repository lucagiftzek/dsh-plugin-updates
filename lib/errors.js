/**
 * Stable error catalog for dsh-plugin-updates (prefix PLUPD).
 * Codes are a permanent API: never rename, only add. Docs: docs/ERRORS.md.
 */
import { defineErrors } from './plugin-errors.js'

/** Remove anything that looks like a credential or a home path before text leaves the plugin. */
export function scrub(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, '[token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [token]')
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[credentials]@')
    .replace(/(\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)(?=\/|\b)/g, '~')
}

export const CATALOG = {
  PLUPD_PROFILE_NOT_FOUND: {
    status: 404,
    message: 'The profile package.json could not be found',
    hint: 'Check that the profile directory exists (default: $DSH_HOME/profiles/web). Set DSH_PLUGIN_UPDATES_PROFILE_DIR if your profile lives elsewhere.',
  },
  PLUPD_DSH_VERSION_UNKNOWN: {
    status: 503,
    message: 'The running DSH version could not be detected',
    hint: 'Without it no update can be called compatible. Set runningDshVersion in the plugin settings, or check that the @deepseek-ai/dsh package is resolvable.',
  },
  PLUPD_REGISTRY_UNREACHABLE: {
    status: 502,
    message: 'The package registry could not be reached',
    hint: 'Check outbound HTTPS to registry.npmjs.org. A failed lookup is shown as unreachable, never as up to date.',
  },
  PLUPD_GITHUB_UNREACHABLE: {
    status: 502,
    message: 'The GitHub API could not be reached',
    hint: 'Check outbound HTTPS to api.github.com. The package is shown as unreachable, never as up to date.',
  },
  PLUPD_REGISTRY_HOST_BLOCKED: {
    status: 403,
    message: 'A request target is not on the host allowlist',
    hint: 'Only registry.npmjs.org and api.github.com are contacted. Add another host to allowHosts only if you really want it.',
  },
  PLUPD_GITHUB_RATE_LIMITED: {
    status: 429,
    message: 'The GitHub API rate limit was reached',
    hint: 'Unauthenticated access allows 60 requests per hour. Wait for the reset, or set githubTokenEnv to the NAME of an environment variable that holds a token.',
  },
  PLUPD_SPEC_UNSUPPORTED: {
    status: 422,
    message: 'This dependency specifier cannot be checked automatically',
    hint: 'The package is listed as manual. Check it by hand, or add a hold or note for it.',
  },
  PLUPD_LOCKFILE_UNREADABLE: {
    status: 500,
    message: 'The lockfile exists but could not be read',
    hint: 'Check the file permissions of pnpm-lock.yaml in the profile. Git dependencies are compared without the pinned commit until it is readable.',
  },
  PLUPD_RESPONSE_TOO_LARGE: {
    status: 502,
    message: 'A registry or GitHub response exceeded the size limit',
    hint: 'The response was dropped at 8 MB. The package is shown as unreachable.',
  },
  PLUPD_STATE_WRITE_FAILED: {
    status: 500,
    message: 'The state file could not be written',
    hint: 'Check that the state directory is writable (default $DSH_HOME/dsh-plugin-updates). Results stay in memory until it is.',
  },
  PLUPD_REFRESH_COOLDOWN: {
    status: 429,
    message: 'A check ran very recently',
    hint: 'Wait for the cooldown (60 seconds) and press Check now again.',
  },
  PLUPD_DISABLED: {
    status: 409,
    message: 'The plugin is switched off',
    hint: 'Set enabled to true in the plugin settings (or unset DSH_PLUGIN_UPDATES_DISABLE).',
  },
  PLUPD_BAD_REQUEST: {
    status: 400,
    message: 'The request is malformed',
    hint: 'Send a JSON body with the documented fields.',
  },
  PLUPD_FORBIDDEN: {
    status: 403,
    message: 'The request was refused by the same-origin gate',
    hint: 'State-changing routes need the header X-Requested-With: dsh-plugin-updates, a JSON content type, a matching Origin and a loopback connection.',
  },
  PLUPD_PACKAGE_UNKNOWN: {
    status: 404,
    message: 'No such package in the last inventory',
    hint: 'Use a package name exactly as it appears in the list.',
  },
  PLUPD_INTERNAL: {
    status: 500,
    message: 'Unexpected internal error',
    hint: 'Collect the log line that starts with PLUPD_INTERNAL and report a bug.',
  },
}

export const E = defineErrors('PLUPD', CATALOG, { scrub })
