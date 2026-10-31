---
name: plugin-updates-doctor
description: Diagnose and fix dsh-plugin-updates problems step by step (install, settings, unreachable packages, rate limits, wrong or missing updates). Load it when a plugin_updates tool or route fails, an error carries a PLUPD_ code, or the user reports a missing Updates tab, a stale badge, or an update that looks wrong.
---

# dsh-plugin-updates doctor

## Rules
- Read-only checks first. Never print secrets (a GitHub token is only ever named by its variable, never read out).
- Never restart `dsh web` yourself: the chat you are in may run inside it. Ask the human.
- Never run `pnpm add`, `pnpm update` or `dsh plugin add` to "fix" an update finding. This plugin only notifies; applying is the human's decision, with the memory-capped command from the tool's `applyHint`.
- Steps marked [HUMAN] need the human (restart, network, proxy, tokens, deciding to allow another host).
- Stop and report after a fix; verify with the step given.

## 0. Facts (read-only)
1. Plugin dir: `node -p "require('path').dirname(require.resolve('dsh-plugin-updates/package.json', {paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"`
2. Doctor: `curl -s <dsh-url>/dsh-plugin-updates/api/doctor` (or the tool `plugin_updates_doctor`).
3. Status: `curl -s <dsh-url>/dsh-plugin-updates/api/status` (running version, last check, problems, counts).
4. One package: `curl -s '<dsh-url>/dsh-plugin-updates/api/detail?pkg=<name>'`.
5. Docs in the plugin dir: `docs/TROUBLESHOOTING.md` (symptoms) and `docs/ERRORS.md` (codes).

## 1. Decision tree
- Every route answers 404 -> the server half is not loaded: TROUBLESHOOTING "Common install problems", C1 and C2. [HUMAN] to restart.
- No Updates tab but `GET health` is 200 -> `dsh-better-sidebar` is missing or the page is stale: TROUBLESHOOTING entry 1.
- Doctor `status: fail`:
  - check `dsh-version` -> code `PLUPD_DSH_VERSION_UNKNOWN`: set `runningDshVersion` to the output of `dsh --version` (entry 7).
  - check `profile` -> code `PLUPD_PROFILE_NOT_FOUND`: find the real profile directory, set `DSH_PLUGIN_UPDATES_PROFILE_DIR` [HUMAN, needs a restart] (entry 8).
  - check `hosts` -> code `PLUPD_REGISTRY_HOST_BLOCKED`: use `https://registry.npmjs.org`; adding `allowHosts` is a [HUMAN] decision (entry 9).
- Doctor `warn`:
  - `registry` or `github` check -> connectivity: `curl -sS -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/-/ping` and `https://api.github.com/rate_limit` (entries 3 and 4).
  - `state` -> `PLUPD_STATE_WRITE_FAILED`: permissions or disk (entry 12).
  - `last-sweep` lists codes -> look each one up in `docs/ERRORS.md`.
- Packages show `unreachable` with `PLUPD_GITHUB_RATE_LIMITED` -> wait for the reset (`retryAfterSec`), or [HUMAN] set `githubTokenEnv` to the NAME of an environment variable (entry 4).
- "It offers, or hides, an update I did not expect" -> read `detail` for that package: `status`, `reason`, `candidate.ranges`, `blockedLatest`, `heldVersions`, `hold` (entry 5). Remember DSH 0.1.x has no gate: "update-compatible" there means declared compatible.
- Settings do not save -> `GET settings` shows `mode` and `writable`; entry 11 and C3.
- `PLUPD_REFRESH_COOLDOWN` -> wait `retryAfterSec` and use the last result meanwhile.
- `PLUPD_INTERNAL` -> collect the `PLUPD_INTERNAL` log line and the doctor output, report a bug.

## 2. Fixes you may apply
- Edit plugin settings through the settings UI or `POST /dsh-plugin-updates/api/settings` (custom header and JSON required): `holds`, `notes`, `upstream`, `runningDshVersion`, `enabled`, `intervalHours`, `badge`.
- Run a check: tool `plugin_updates` with `refresh: true` (60 second cooldown).
- Ignore or snooze a version through the Updates tab when the human asks.

## 3. Steps that need the human
- Restarting `dsh web` (server half changes, environment variables).
- Network, proxy or firewall changes; creating and exporting a GitHub token.
- Allowing an extra host in `allowHosts`.
- Applying any update: show the list, then the command from `applyHint`; the human runs it.

## 4. Report back
Say which check failed (id and `PLUPD_` code), the cause you found, what you changed (settings keys only, no values of secrets), and what the human must still do. For update findings, quote the status, installed and candidate versions, and the `applyHint` unchanged.
