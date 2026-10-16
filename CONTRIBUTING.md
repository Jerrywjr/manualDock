# Contributing

Read the [current status and open issues](docs/project-status.md) and [module contracts](docs/architecture.md), then the [maintenance boundaries](AGENTS.md), then start with the [repository map](README.md#仓库结构与接手入口), then the [file responsibilities and regression map](docs/development.md#接手阅读顺序). Fix only the reported problem. Do not include unrelated refactoring, UI changes, dependency changes, or cleanup. Preserve existing workspace changes; explain and obtain agreement before expanding scope.

Keep changes within the existing directory layout. `extension/` is the authoritative runtime source; the copy under `skill/import-security-manuals/assets/extension/` is generated. Change the source, then run `npm run sync:assets`.

Use Node.js 22 or newer and Python 3. If dependencies are missing and installation is in scope, install locked dependencies with `npm ci`. Choose checks for the changed behavior; the commands below are available checks, not permission to expand a documentation-only task into a full browser run:

```sh
# Format only files changed for this task; replace these example paths.
node node_modules/prettier/bin/prettier.cjs --write extension/source-connector.js tests/source-connector.test.mjs
npm run sync:assets
npm run check
npm test
npm run test:openapi:browser
npm run test:browser
npm run test:workspace
npm run test:layout
```

Browser tests use synthetic local pages and an isolated Chromium profile. They must not reuse a personal browser profile, log in to a real device, or execute API examples. Set `TMPDIR` to an existing directory within the repository when all test writes must remain there. `MANUALDOCK_CHROMIUM_EXECUTABLE` can select an existing test browser.

For reliability changes, add a regression that fails before the fix. Keep chapter arrival and stable-body checks intact. A network error, a chapter-specific error, a storage conflict and a user pause have different recovery behavior. Never silently overwrite a saved chapter during archive restoration, re-create a deleted task from stale state, or describe synthetic tests as real-device compatibility proof.

Explain the changed behavior, the evidence used to diagnose the problem, and the checks actually run. Do not commit credentials, device page snapshots, browser profiles, generated packages or local test reports.

For behavior changes, keep regressions for previously accepted behavior and run the relevant paths again. Synchronize release versions in the manifest, panel label, package metadata, lockfile and generated mirror, then record changes in README. Documentation-only edits do not change the runtime version. Never treat an old report or a synthetic test as proof that the current real-device issue is resolved.

Keep `docs/modules.json` and `docs/project-status.md` current with changed ownership, dependencies, release version and unresolved evidence. `npm run check:handoff` and the read-only `npm run check:public` run through `npm run check`; neither proves real-device behavior. Do not restore removed UI controls from historical documentation.
