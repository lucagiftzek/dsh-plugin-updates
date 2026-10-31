# Error codes: dsh-plugin-updates

Every HTTP error body and every failed tool result has this shape:

```json
{ "ok": false, "error": "<message>", "code": "PLUPD_REFRESH_COOLDOWN",
  "message": "A check ran very recently", "hint": "Wait for the cooldown (60 seconds) and press Check now again.",
  "docs": "docs/ERRORS.md#plupd_refresh_cooldown" }
```

Per package problems (a lookup that failed) appear on the package row as `status: "unreachable"` or `"manual"` with the same `code`, and are listed in `lastSweep.errors` of `GET status`. Log lines start with the code, so `grep PLUPD_` finds them. Codes are permanent: they are added, never renamed.

| Code | HTTP | Where it appears | Meaning | Agent action |
|---|---|---|---|---|
| PLUPD_PROFILE_NOT_FOUND | 404 | route `GET doctor` (check `profile`), sweep, log | No profile package.json at the expected path | Read-only: `ls "${DSH_HOME:-$HOME/.dsh}/profiles"`, then `node -e "JSON.parse(require('fs').readFileSync(process.argv[1]))" <profile>/package.json` ([details](#plupd_profile_not_found)) |
| PLUPD_DSH_VERSION_UNKNOWN | 503 | doctor check `dsh-version`, tool `plugin_updates` notes, log | Running DSH version not detected | Read-only: `dsh --version` ([details](#plupd_dsh_version_unknown)) |
| PLUPD_REGISTRY_UNREACHABLE | 502 | package status `unreachable`, doctor check `registry`, log | Registry request failed | Read-only: `curl -sS -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/-/ping` ([details](#plupd_registry_unreachable)) |
| PLUPD_GITHUB_UNREACHABLE | 502 | package status `unreachable`, doctor check `github`, log | GitHub request failed | Read-only: `curl -sS -o /dev/null -w "%{http_code}\n" https://api.github.com/rate_limit` ([details](#plupd_github_unreachable)) |
| PLUPD_REGISTRY_HOST_BLOCKED | 403 | package status `unreachable`, doctor check `hosts`, log | Request target not on the allowlist | Read-only: read `registry` in the settings ([details](#plupd_registry_host_blocked)) |
| PLUPD_GITHUB_RATE_LIMITED | 429 | package status `unreachable` (with `retryAfterSec`), doctor check `github`, log | GitHub rate limit reached | Read-only: `curl -s https://api.github.com/rate_limit` shows `remaining` and `reset` (this call is free) ([details](#plupd_github_rate_limited)) |
| PLUPD_SPEC_UNSUPPORTED | 422 | package status `manual` | Specifier cannot be checked automatically | Nothing to fix ([details](#plupd_spec_unsupported)) |
| PLUPD_LOCKFILE_UNREADABLE | 500 | doctor check `lockfile`, sweep problems, log | Lockfile exists but is unreadable | Read-only: `ls -l <profile>/pnpm-lock.yaml` ([details](#plupd_lockfile_unreadable)) |
| PLUPD_RESPONSE_TOO_LARGE | 502 | package status `unreachable`, log | Response above the 8 MB cap | Nothing to fix on your side ([details](#plupd_response_too_large)) |
| PLUPD_STATE_WRITE_FAILED | 500 | doctor check `state`, status field `stateWriteError`, log | State file not writable | Read-only: `ls -ld "${DSH_HOME:-$HOME/.dsh}/dsh-plugin-updates"; df -h "${DSH_HOME:-$HOME/.dsh}"` ([details](#plupd_state_write_failed)) |
| PLUPD_REFRESH_COOLDOWN | 429 | route `POST refresh` (HTTP 429), tool `plugin_updates` with `refresh` | Check now pressed too soon | Wait the number of seconds in `retryAfterSec`, then Check now again ([details](#plupd_refresh_cooldown)) |
| PLUPD_DISABLED | 409 | route `POST refresh` (HTTP 409) | Plugin switched off | Set `enabled` to true in the settings. ([details](#plupd_disabled)) |
| PLUPD_BAD_REQUEST | 400 | any route (HTTP 400, or 404 and 405 for unknown paths) | Malformed request | Send valid JSON with the documented fields ([details](#plupd_bad_request)) |
| PLUPD_FORBIDDEN | 403 | every `POST` route (HTTP 403) | Same-origin gate refused the request | Use the Updates tab, or send all of the headers listed in the hint from the same machine. ([details](#plupd_forbidden)) |
| PLUPD_PACKAGE_UNKNOWN | 404 | route `GET detail`, `POST ignore|snooze`, tool `plugin_updates` with `package` | Package not in the inventory | Use a name exactly as in `GET list?scope=all`, or run a check first. ([details](#plupd_package_unknown)) |
| PLUPD_INTERNAL | 500 | any route or tool, log | Unexpected internal error | Collect the log line that starts with `PLUPD_INTERNAL` (journal of `dsh web`) and the doctor output, and report a bug with both. ([details](#plupd_internal)) |

### PLUPD_PROFILE_NOT_FOUND
- **Meaning:** The profile package.json could not be found.
- **Where:** route `GET doctor` (check `profile`), sweep, log.
- **Likely causes:** The profile directory is not where the plugin looks (default `$DSH_HOME/profiles/<name>`), the name differs, or package.json is not valid JSON.
- **Agent action:** Read-only: `ls "${DSH_HOME:-$HOME/.dsh}/profiles"`, then `node -e "JSON.parse(require('fs').readFileSync(process.argv[1]))" <profile>/package.json`. Set `DSH_PLUGIN_UPDATES_PROFILE_DIR` to the real directory.
- **Needs the human:** Only to set an environment variable for `dsh web` and restart it.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-profile-not-found)

### PLUPD_DSH_VERSION_UNKNOWN
- **Meaning:** The running DSH version could not be detected.
- **Where:** doctor check `dsh-version`, tool `plugin_updates` notes, log.
- **Likely causes:** The `@deepseek-ai/dsh` package could not be resolved from the running process (unusual install layout).
- **Agent action:** Read-only: `dsh --version`. Set `runningDshVersion` in the plugin settings (or `DSH_PLUGIN_UPDATES_DSH_VERSION`) to that value. Until then nothing is called compatible.
- **Needs the human:** Restarting `dsh web` if the setting is a profile row edit.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-version-unknown)

### PLUPD_REGISTRY_UNREACHABLE
- **Meaning:** The package registry could not be reached.
- **Where:** package status `unreachable`, doctor check `registry`, log.
- **Likely causes:** No outbound HTTPS to the registry, a proxy or firewall, a registry rate limit (the plugin backs off), or an HTTP 5xx.
- **Agent action:** Read-only: `curl -sS -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/-/ping`. Fix connectivity, then press Check now.
- **Needs the human:** Network, proxy or firewall changes.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-all-unreachable)

### PLUPD_GITHUB_UNREACHABLE
- **Meaning:** The GitHub API could not be reached.
- **Where:** package status `unreachable`, doctor check `github`, log.
- **Likely causes:** No outbound HTTPS to api.github.com, a proxy, or an HTTP 5xx.
- **Agent action:** Read-only: `curl -sS -o /dev/null -w "%{http_code}\n" https://api.github.com/rate_limit`. Fix connectivity, then Check now.
- **Needs the human:** Network, proxy or firewall changes.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-all-unreachable)

### PLUPD_REGISTRY_HOST_BLOCKED
- **Meaning:** A request target is not on the host allowlist.
- **Where:** package status `unreachable`, doctor check `hosts`, log.
- **Likely causes:** The `registry` setting names a host outside the allowlist, or a redirect pointed to another host (a mirror, a CDN).
- **Agent action:** Read-only: read `registry` in the settings. Use `https://registry.npmjs.org`, or add the host to `allowHosts` only if you really want the plugin to contact it.
- **Needs the human:** Deciding to allow an extra host.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-host-blocked)

### PLUPD_GITHUB_RATE_LIMITED
- **Meaning:** The GitHub API rate limit was reached.
- **Where:** package status `unreachable` (with `retryAfterSec`), doctor check `github`, log.
- **Likely causes:** Unauthenticated GitHub access allows 60 requests per hour and the budget is shared by everything behind the same address. The plugin stops below 10 remaining.
- **Agent action:** Read-only: `curl -s https://api.github.com/rate_limit` shows `remaining` and `reset` (this call is free). Wait for the reset, or set `githubTokenEnv` to the NAME of an environment variable that holds a token and restart `dsh web`.
- **Needs the human:** Creating the token and exporting it to `dsh web`.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-rate-limited)

### PLUPD_SPEC_UNSUPPORTED
- **Meaning:** This dependency specifier cannot be checked automatically.
- **Where:** package status `manual`.
- **Likely causes:** The dependency specifier is a git remote outside github.com, a pinned URL tarball that is not a GitHub release asset, or something unrecognised. The plugin does not guess from the name.
- **Agent action:** Nothing to fix. Check that package by hand, or add a note for it in `notes`.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-manual)

### PLUPD_LOCKFILE_UNREADABLE
- **Meaning:** The lockfile exists but could not be read.
- **Where:** doctor check `lockfile`, sweep problems, log.
- **Likely causes:** pnpm-lock.yaml exists but cannot be read (permissions). Git dependencies then lack their pinned commit.
- **Agent action:** Read-only: `ls -l <profile>/pnpm-lock.yaml`. Make it readable by the user running `dsh web`.
- **Needs the human:** Changing file ownership.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-lockfile)

### PLUPD_RESPONSE_TOO_LARGE
- **Meaning:** A registry or GitHub response exceeded the size limit.
- **Where:** package status `unreachable`, log.
- **Likely causes:** A registry or GitHub response exceeded 8 MB. The plugin requests the abbreviated package document, so this means an unusual package or an unexpected server answer.
- **Agent action:** Nothing to fix on your side. The package stays `unreachable`; check it by hand.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-all-unreachable)

### PLUPD_STATE_WRITE_FAILED
- **Meaning:** The state file could not be written.
- **Where:** doctor check `state`, status field `stateWriteError`, log.
- **Likely causes:** The state directory (`$DSH_HOME/dsh-plugin-updates`) is not writable or the disk is full. Results stay in memory, but ETag caches and ignore/snooze choices are lost at restart.
- **Agent action:** Read-only: `ls -ld "${DSH_HOME:-$HOME/.dsh}/dsh-plugin-updates"; df -h "${DSH_HOME:-$HOME/.dsh}"`. Fix the permissions or free space.
- **Needs the human:** Changing ownership or freeing disk.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-state-write)

### PLUPD_REFRESH_COOLDOWN
- **Meaning:** A check ran very recently.
- **Where:** route `POST refresh` (HTTP 429), tool `plugin_updates` with `refresh`.
- **Likely causes:** A check ran less than 60 seconds ago.
- **Agent action:** Wait the number of seconds in `retryAfterSec`, then Check now again. The last result is always available without a refresh.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-cooldown)

### PLUPD_DISABLED
- **Meaning:** The plugin is switched off.
- **Where:** route `POST refresh` (HTTP 409).
- **Likely causes:** `enabled` is false in the settings.
- **Agent action:** Set `enabled` to true in the settings.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-disabled)

### PLUPD_BAD_REQUEST
- **Meaning:** The request is malformed.
- **Where:** any route (HTTP 400, or 404 and 405 for unknown paths).
- **Likely causes:** A malformed JSON body, an unknown or wrongly typed setting, or a setting write while the settings are read-only.
- **Agent action:** Send valid JSON with the documented fields. `GET /dsh-plugin-updates/api/settings` shows the keys, types and whether they are writable.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings)

### PLUPD_FORBIDDEN
- **Meaning:** The request was refused by the same-origin gate.
- **Where:** every `POST` route (HTTP 403).
- **Likely causes:** Missing `X-Requested-With: dsh-plugin-updates`, a non-JSON content type, an `Origin` that does not match the `Host`, or a connection that is not loopback (and the host offers no connection admission).
- **Agent action:** Use the Updates tab, or send all of the headers listed in the hint from the same machine.
- **Needs the human:** Only if you front DSH with a proxy that rewrites `Origin` or `Host`.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-forbidden)

### PLUPD_PACKAGE_UNKNOWN
- **Meaning:** No such package in the last inventory.
- **Where:** route `GET detail`, `POST ignore|snooze`, tool `plugin_updates` with `package`.
- **Likely causes:** The name is not in the last inventory (typo, or no check has run yet).
- **Agent action:** Use a name exactly as in `GET list?scope=all`, or run a check first.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-package-unknown)

### PLUPD_INTERNAL
- **Meaning:** Unexpected internal error.
- **Where:** any route or tool, log.
- **Likely causes:** An unexpected exception inside the plugin.
- **Agent action:** Collect the log line that starts with `PLUPD_INTERNAL` (journal of `dsh web`) and the doctor output, and report a bug with both.
- **Needs the human:** no
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-internal)
