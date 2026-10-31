# Changelog

## Unreleased

- Fix: on DSH 0.2.1 the tools failed with "value is not lossless JSON" (undefined fields such as candidate.ref and retryAfterSec). Tool results are now sanitized at the tool boundary and error bodies are lossless; regression test test/lossless.test.mjs.

## 0.1.0

First release.

- Notify-only update checker for the plugins in a DSH profile. No install, no profile edit, no child process.
- Dependencies are classified by specifier: registry, `github:` and git URLs on github.com, GitHub release tarballs, `link:` and `file:` folders. Anything else is `manual`.
- Compatibility gate against the running DSH (`engines.dsh`, else DSH peer ranges, prereleases included), so a 0.2.x-only build is never offered to a 0.1.5 host. Caret trap detection.
- Holds (with an optional `when dsh <range>` clause), per package notes, ignore and snooze.
- Only registry.npmjs.org and api.github.com are contacted; redirects off the allowlist are refused. ETag caching, GitHub rate-limit handling, 12 hour default interval, manual Check now with a 60 second cooldown.
- Updates sidebar tab with a live badge (module-level poll), Settings section, read-only agent tool `plugin_updates`, doctor route and tool, bundled doctor skill, stable `PLUPD_` error codes.
- Works on DSH 0.1.5 (settings namespace) and 0.2.x (settings forms) from one code base.
