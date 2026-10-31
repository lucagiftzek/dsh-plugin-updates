# Status notes (checkpoint)

Tests: `npm test` passes (80 tests: classify, compat gate on real registry fixtures, net/ETag/rate limit/allowlist, state, mocked registry+GitHub evaluation, host settings on fake 0.1.5, fake 0.2.1 and no-settings contexts, routes and doctor, tool compiled with the real defineTool, jsdom client boot incl. no betterSidebar, docs drift). Also green with `DSH_GLOBAL_PREFIX` pointing at a 0.2.1-rc.5 harness. Privacy scan clean.

Dry evaluation (read-only copy of a real profile, real registry and GitHub): done for 0.1.5-rc.1; for 0.2.1-rc.5 the cells for two GitHub-backed items (git dependency and archived fork) were cut short by the unauthenticated GitHub limit (60 per hour) and show `unreachable PLUPD_GITHUB_RATE_LIMITED`. Re-run later with `node test/dry-eval.mjs <profile-copy>` (ETag cache makes it cheap).

## TODO
- Re-run the dry evaluation after the GitHub limit resets and record the comparison in the roadmap.
- Optional: mount test against the real cordis loader of both harnesses (the suite uses fake contexts plus the real harness schemastery and defineTool).
- Verify `chatNotice` (default off) against the real agents/session API; it is best effort and untested live.
- Final review pass, then commit on the agreed branch. Not pushed, not linked into any profile.
