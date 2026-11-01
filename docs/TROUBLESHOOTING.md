# Troubleshooting dsh-plugin-updates

Checked on: DSH 0.1.5-rc.1 and 0.2.1-rc.5, plugin 0.1.0.

<a id="start-here"></a>
**Start here.** Ask your agent to load the `plugin-updates-doctor` skill, or run the doctor yourself (section 0).
Every error the plugin returns carries a `code`; look it up in [ERRORS.md](ERRORS.md).

## Quick index

| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | No Updates tab in the sidebar | server half not loaded or `dsh-better-sidebar` missing | [1](#t-tab-missing) |
| 2 | The tab says "No result yet", or Check now does nothing | first check not run yet, plugin off, cooldown | [2](#t-no-result) |
| 3 | Every package is "unreachable" | no outbound HTTPS, proxy, host blocked | [3](#t-all-unreachable) |
| 4 | Some packages are "unreachable" with a GitHub code | GitHub rate limit | [4](#t-rate-limited) |
| 5 | It offers (or hides) an update I did not expect | holds, gate rule, `no-declared-range`, DSH 0.1.5 has no gate | [5](#t-wrong-offer) |
| 6 | The badge number is stale or missing | badge setting, poll, snooze or ignore | [6](#t-badge) |
| 7 | "Running DSH version unknown" | unusual install layout | [7](#t-version-unknown) |
| 8 | "Profile package.json not found" | non-default profile directory | [8](#t-profile-not-found) |
| 9 | `PLUPD_REGISTRY_HOST_BLOCKED` | registry setting or a redirect to another host | [9](#t-host-blocked) |
| 10 | A package shows "manual" or "local" | specifier cannot be checked, or a plain local plugin | [10](#t-manual) |
| 11 | Settings do not save | read-only mode, wrong type, row override | [11](#t-settings) |
| 12 | `PLUPD_LOCKFILE_UNREADABLE` or `PLUPD_STATE_WRITE_FAILED` | file permissions or disk | [12](#t-lockfile) |
| 13 | `PLUPD_REFRESH_COOLDOWN`, `PLUPD_DISABLED`, `PLUPD_FORBIDDEN`, `PLUPD_PACKAGE_UNKNOWN` | rate limit of the button, switch off, gate, typo | [13](#t-cooldown) |
| 14 | `PLUPD_INTERNAL` | a bug | [14](#t-internal) |

## 0. Collect facts (read-only, always safe)

```bash
dsh --version
curl -s <dsh-url>/dsh-plugin-updates/api/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.host);for(const c of r.checks)console.log(c.status,c.id,c.detail||"",c.code||"")})'
curl -s <dsh-url>/dsh-plugin-updates/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s),null,1)))'
ls -la "${DSH_HOME:-$HOME/.dsh}/dsh-plugin-updates/"          # state.json, mode 0600
journalctl -u <your-dsh-unit> --since "1 day ago" | grep -E 'dsh-plugin-updates|PLUPD_' | tail -40
```

<a id="t-tab-missing"></a>
## 1. No Updates tab in the sidebar

**Likely causes** (most likely first)
1. The plugin is not loaded (not in the bundle list, or `dsh web` was not restarted): see C1 below.
2. `dsh-better-sidebar` is not installed. The tab needs it; the plugin works without it (route, tool and Settings section still exist).
3. The Settings section exists but the tab does not: an old browser tab. Reload the page.

**Diagnose** (read-only)
```bash
curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-plugin-updates/api/health      # 200 = server half loaded
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"; ls "$D/node_modules" | grep -E 'dsh-better-sidebar|dsh-plugin-updates'
```
`200` and no better-sidebar in the list is cause 2.

**Fix**
- Cause 1: follow C1 below **[HUMAN]** (restart).
- Cause 2: install `dsh-better-sidebar` (a build that matches your DSH line; this plugin can tell you which one is compatible once it runs).

**Verify:** the Updates tab appears; the badge shows after the first check.

**Related codes:** none.

<a id="t-no-result"></a>
## 2. "No result yet", or Check now does nothing

**Likely causes:** the first check runs `initialDelaySeconds` (60) after start, and after a restart it waits for the interval since the last check; `enabled` is false; Check now is rate limited to once per 60 seconds.

**Diagnose**
```bash
curl -s <dsh-url>/dsh-plugin-updates/api/status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log({enabled:r.enabled,checkedAt:r.checkedAt,checking:r.checking,next:r.nextCheckAt,last:r.lastSweep})})'
```

**Fix:** press Check now once and wait up to a minute (the page polls). Set `enabled` to true if it is false.

**Verify:** `checkedAt` is a recent timestamp.

**Related codes:** `PLUPD_REFRESH_COOLDOWN`, `PLUPD_DISABLED`.

<a id="t-all-unreachable"></a>
## 3. Every package is "unreachable"

**Likely causes:** (1) the machine has no outbound HTTPS to `registry.npmjs.org` and `api.github.com`; (2) a corporate proxy or firewall; (3) a registry rate limit (the plugin backs off); (4) the registry setting points off the allowlist (see 9).

**Diagnose**
```bash
curl -sS -o /dev/null -w 'registry %{http_code}\n' https://registry.npmjs.org/-/ping
curl -sS -o /dev/null -w 'github %{http_code}\n' https://api.github.com/rate_limit
```
`200` for both and still unreachable: read the codes in `lastSweep.errors` (section 0).

**Fix:** restore connectivity **[HUMAN]** (network, proxy, firewall), then press Check now.

**Verify:** packages show real statuses; the doctor checks `registry` and `github` are `ok`.

**Related codes:** `PLUPD_REGISTRY_UNREACHABLE`, `PLUPD_GITHUB_UNREACHABLE`, `PLUPD_RESPONSE_TOO_LARGE`.

<a id="t-rate-limited"></a>
## 4. GitHub packages are "unreachable" with a rate limit

**Cause:** unauthenticated GitHub access is 60 requests per hour per address. A first sweep of a large profile needs about 30 to 60 requests; later sweeps use ETags and are almost free. The plugin stops below 10 remaining and retries after the reset.

**Diagnose**
```bash
curl -s https://api.github.com/rate_limit | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).resources.core;console.log({limit:c.limit,remaining:c.remaining,resetsAt:new Date(c.reset*1000).toISOString()})})'
```

**Fix:** wait for the reset (the next automatic check completes the missing packages). For a permanent fix set `githubTokenEnv` to the NAME of an environment variable holding a read-only token and restart `dsh web` **[HUMAN]**. Never put the token in the settings.

**Verify:** `GET status` shows no `PLUPD_GITHUB_RATE_LIMITED` in `lastSweep.errors` after the next check.

**Related codes:** `PLUPD_GITHUB_RATE_LIMITED`.

<a id="t-wrong-offer"></a>
## 5. It offers, or hides, an update I did not expect

**Likely causes** (most likely first)
1. A **hold** hides it (`held`, or the version is listed in `heldVersions`). Holds are seeded from an audit; edit `holds`.
2. The newer version declares a DSH range your running core does not satisfy (`update-needs-newer-core`). That is the point of the plugin; update the core first.
3. The new version declares no DSH range at all (`no-declared-range`): the plugin cannot judge, so it does not count it in the badge.
4. You run DSH 0.1.x, which has **no compatibility gate**. "update-compatible" means declared compatible, not verified. Builds written for a different internal API can still declare a wide range; add a hold for them.
5. The running version was detected wrongly (see 7).

**Diagnose**
```bash
curl -s '<dsh-url>/dsh-plugin-updates/api/detail?pkg=<package>' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).package,null,1)))'
```
Look at `status`, `reason`, `candidate.ranges`, `blockedLatest`, `heldVersions`, `hold`.

**Fix:** edit `holds` or `notes` in the settings; for a wrong core version set `runningDshVersion`. Nothing here installs anything.

**Verify:** press Check now and re-read the package row.

**Related codes:** `PLUPD_DSH_VERSION_UNKNOWN`.

<a id="t-badge"></a>
## 6. The badge is stale or missing

**Likely causes:** `badge` is off; the count is zero (the badge hides at zero); every update is ignored or snoozed; the browser tab was suspended (the page polls status every 60 seconds while visible); `badgeCountsIncompatible` is off and the only updates need a newer core.

**Diagnose:** `GET status` and compare `badge`, `badgeEnabled` and `summary.counts`.

**Fix:** adjust the settings above; use Restore on ignored or snoozed rows; reload the page.

**Verify:** the number matches `summary.safe` (or `summary.badge`) within a minute.

<a id="t-version-unknown"></a>
## 7. "Running DSH version unknown"

**Cause:** the plugin reads the version of the `@deepseek-ai/dsh` package that runs it. A custom install layout can hide it.

**Fix:** set `runningDshVersion` to the output of `dsh --version` (for example `0.2.1`). Until then nothing is called compatible.

**Verify:** doctor check `dsh-version` is `ok`.

**Related codes:** `PLUPD_DSH_VERSION_UNKNOWN`.

<a id="t-profile-not-found"></a>
## 8. "Profile package.json not found"

**Cause:** the plugin reads `$DSH_HOME/profiles/<name>/package.json`. It takes the directory from the host (`profileContext`) when the host offers it, else from `DSH_PLUGIN_UPDATES_PROFILE_DIR`, else `DSH_PROFILE`, else `web`.

**Diagnose:** `ls "${DSH_HOME:-$HOME/.dsh}/profiles"`.

**Fix:** set `DSH_PLUGIN_UPDATES_PROFILE_DIR=<profile directory>` in the environment of `dsh web` and restart **[HUMAN]**.

**Related codes:** `PLUPD_PROFILE_NOT_FOUND`.

<a id="t-host-blocked"></a>
## 9. PLUPD_REGISTRY_HOST_BLOCKED

**Causes:** the `registry` setting is a mirror or private registry; or the registry answered with a redirect to another host.

**Fix:** use `https://registry.npmjs.org`. If you really run a private registry, add its host to `allowHosts` **[HUMAN decision]**: the plugin will then send package names to it.

**Related codes:** `PLUPD_REGISTRY_HOST_BLOCKED`.

<a id="t-manual"></a>
## 10. A package shows "manual" or "local"

**manual:** the specifier is a git remote outside github.com or a URL tarball that is not a GitHub release asset. The plugin refuses to guess from the package name. Check it by hand.

**local:** a `link:` or `file:` plugin with no `upstream` entry. By design nothing is checked. To compare a fork with its upstream add `upstream: { "<plugin>": "owner/repo" }`; to compare with its own github.com origin set `checkOwnRemotes` to true.

**Related codes:** `PLUPD_SPEC_UNSUPPORTED`.

<a id="t-settings"></a>
## 11. Settings do not save

See C3 below for the DSH line differences. Plugin specifics: the doctor check `settings` and `GET settings` show `mode` (`register` on 0.1.5, `forms` on 0.2.x, `config` read-only). In `config` mode edit the `plugin-updates` row in the profile `cordis.patch.yml` and restart **[HUMAN]**. A write with an unknown key or a wrong type is refused with `PLUPD_BAD_REQUEST`.

**Related codes:** `PLUPD_BAD_REQUEST`.

<a id="t-lockfile"></a>
## 12. Lockfile or state file problems

**Diagnose:** `ls -l <profile>/pnpm-lock.yaml "${DSH_HOME:-$HOME/.dsh}/dsh-plugin-updates"` and `df -h "${DSH_HOME:-$HOME/.dsh}"`.

**Fix:** make the files readable and the directory writable for the user that runs `dsh web`, or free disk space **[HUMAN]**. The plugin keeps working from memory; ignore and snooze choices persist only once the state file can be written.

<a id="t-state-write"></a>
**Related codes:** `PLUPD_LOCKFILE_UNREADABLE`, `PLUPD_STATE_WRITE_FAILED`.

<a id="t-cooldown"></a>
## 13. Cooldown, disabled, forbidden, unknown package

- `PLUPD_REFRESH_COOLDOWN`: wait `retryAfterSec`.
- `PLUPD_DISABLED`: set `enabled` to true.
- `PLUPD_FORBIDDEN`: a POST needs `X-Requested-With: dsh-plugin-updates`, `Content-Type: application/json`, a matching `Origin` and a loopback connection. Use the tab, or send all of them from the same machine.
- `PLUPD_PACKAGE_UNKNOWN`: use a name exactly as listed by `GET list?scope=all`.

<a id="t-disabled"></a>
<a id="t-forbidden"></a>
<a id="t-package-unknown"></a>

<a id="t-internal"></a>
## 14. PLUPD_INTERNAL

Collect the log line that starts with `PLUPD_INTERNAL` and the doctor output (section 0) and report a bug. Do not paste your profile or any environment variables.

<!-- dsh-common-install:v1 -->
## Common install problems on DSH

Placeholders: `<dsh-url>` is where your DSH web UI answers (for example
`http://127.0.0.1:3080`), `DSH_HOME` defaults to `~/.dsh`, the profile is `web`.

<a id="c1-not-loaded"></a>
### C1. The plugin does not appear at all (no tab, no settings, no tools)

**Causes:** (1) the package is installed but not in the profile's bundle list;
(2) it is in the list but `dsh web` was not restarted; (3) DSH refused it as
incompatible (engines or peer range); (4) its server entry threw at start;
(5) the entry is defined twice (`duplicate loader entry id`: a hand-written `insert` row in
the profile patch plus the package's own patch); (6) an old build without `dsh.bundle` in its
`package.json` (`declares no dsh.bundle`).

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n 'dsh-plugin-updates' || echo "NOT IN BUNDLES"
ls -la "$D/node_modules/dsh-plugin-updates" 2>/dev/null || echo "NOT INSTALLED"
dsh --profile web --dump-config 2>/dev/null | grep -n -i 'plugin-updates' | head    # composed tree, does not boot
# DSH log: the terminal running `dsh web`, or your service manager, e.g.
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'dsh-plugin-updates|plugin-updates|incompatible|skipped|exemption|duplicate loader entry|declares no dsh.bundle' | tail -40
```

**Fix:** install with `dsh plugin --profile web add @lucagiftzek/dsh-plugin-updates` (it adds the package to
`dsh.profile.bundles` when the package declares `dsh.bundle`; override values with a plain
`- id: plugin-updates` row, never a second `insert` row), then restart
`dsh web` **[HUMAN if your chat runs inside dsh web]**. If the log says the bundle
was skipped as incompatible, update the plugin; DSH 0.2.x also offers an exact-version
exemption (`dsh plugin allow-version`, see the log message), which must be granted
again after every DSH version change.

**Verify:** the tab or settings page appears; `curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-plugin-updates/api/doctor` prints `200`.

<a id="c2-route-404"></a>
### C2. Every plugin route answers 404

**Causes:** the plugin's server half is not loaded (C1), or it was updated and the
running `dsh web` still has the old server code (the client half hot-reloads, the
server half loads only at start). A 404 on ONE path while others answer means a
wrong path, not a load problem.

**Diagnose**
```bash
for p in api/doctor api/health api/does-not-exist; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' <dsh-url>/dsh-plugin-updates/$p)"; done
```
All 404 = route prefix not registered. `200` on doctor/health and `404` on the last = healthy.

**Fix:** restart `dsh web` **[HUMAN]**. If you open DSH through a browser login or a
reverse proxy, check the proxy forwards `/dsh-plugin-updates/` to DSH. After a restart the
web UI may ask you to open the launch URL again (the one `dsh web` prints, with its
one-time token); that is expected and unrelated to plugin routes.

<a id="c3-settings-not-saved"></a>
### C3. Settings do not save, or reset after a restart

**Causes by DSH line:**
- **0.1.5:** the plugin registers a settings namespace; values live in
  `$DSH_HOME/settings.yaml` under the plugin's section. A hand edit with a YAML error
  makes the whole file unreadable.
- **0.2.x:** settings are forms over the plugin's exported `Config`; values live in
  `$DSH_HOME/profiles/web/cordis.patch.yml` under the row `- id: plugin-updates` `config:`.
  (a) Only fields marked live (`volatile`) are editable in forms; others are edited in
  the row and remount the plugin. (b) The loader reads `Config` from the DEFAULT export
  when the module has one: a plugin that exports `default { name, apply }` without
  `Config` gets no form. (c) A plugin that touches `ctx.settings` without declaring
  `inject: ['settings']` throws on 0.2.x. (d) A home patch or command-line overlay that
  sets the same key wins, and the form write is refused. (e) On first boot 0.2.x renames
  `settings.yaml` to `settings.yaml.imported` and imports only sections whose name equals
  an entry id with all keys declared live; a `settings.yaml` that reappears (a script
  rewriting it) is imported AGAIN at every boot and overwrites profile rows.

**Diagnose**
```bash
dsh --version
curl -s <dsh-url>/dsh-plugin-updates/api/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.host);for(const c of r.checks)console.log(c.status,c.id,c.detail||"")})'
D="${DSH_HOME:-$HOME/.dsh}"; ls -la "$D/settings.yaml" "$D/settings.yaml.imported" 2>/dev/null
grep -n -A12 -- '- id: plugin-updates' "$D/profiles/web/cordis.patch.yml"   # 0.2.x row (may contain secrets: do not paste it anywhere)
```

**Fix:** use a plugin version that supports your DSH line (the doctor's `settingsMode`
must not be `config` on a normal install). On 0.2.x stop any script that rewrites
`settings.yaml`, and edit non-live fields in the row. Back up the file before any hand
edit (`cp file file.bak-$(date +%Y%m%d)`).

<a id="c4-gui-blank"></a>
### C4. After a DSH update the web UI does not render ("Failed to load plugins", blank page)

**Causes:** on 0.2.x an unmet REQUIRED client inject stops the whole GUI, not just one
plugin. Typical: a plugin requires `dsh-better-sidebar` (or another client service) and
that package was refused as too old for the new DSH. Older plugin builds that require
their sidebar host are affected; current ones inject it optionally.

**Diagnose:** browser devtools console (the first red error names the plugin), and the
DSH log for `skipped` / `incompatible` bundles (C1 command).

**Fix:** update `dsh-better-sidebar` (0.28 or newer for DSH 0.2.1) and the plugin;
or disable the failing bundle by row and restart **[HUMAN]**:
```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: plugin-updates
  disabled: true
```

<a id="c6-oom-install"></a>
### C6. The machine runs out of memory during an install

**Cause:** a profile-level `pnpm install` (or `npm i -g` of the harness) can grow to many
GB on a large profile; with swap full, the kernel or earlyoom kills unrelated services.

**Fix:** check `free -m` first, then install inside a memory-capped scope:
```bash
systemd-run --user --scope -p MemoryMax=3G dsh plugin --profile web add @lucagiftzek/dsh-plugin-updates
# pnpm only: add --child-concurrency 1 to reduce peak memory
```
A runaway then kills only itself. Check afterwards that your other services are up.

<a id="c7-stale-client"></a>
### C7. UI shows new options but they do nothing, or "restart dsh web" banners

**Cause:** the client half (browser bundle) hot-reloaded, the server half did not. Mixed
versions are tolerated by design, but new server features stay off until a restart.
**Fix:** restart `dsh web` when convenient **[HUMAN]**; reload the browser tab.
<!-- /dsh-common-install -->
