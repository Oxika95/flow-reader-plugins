# Agent guide: flow-reader-plugins

Public repo: official source plugins for the Flow Reader Android app. Each top-level folder is one
plugin (`plugin.json` + `index.js`, CommonJS, sandboxed QuickJS in the app; optional `icon.png`
tab icon: single-colour silhouette on a transparent background). Published to GitHub
Pages as `index.json` on every push to `main`, so a push reaches users immediately.

Start at [CONTEXT.md](CONTEXT.md): task routing and the release rules. The app repo, checked out beside this
one as `../flow-reader`, holds the plugin contract and the checks; open `flow-reader.code-workspace` so its
rules load too.

## Layout

- `RoyalRoad/` - Royal Road plugin (`id: royalroad`, book ids `rr:*`).
- `Patreon/` - Patreon plugin (`id: patreon`, book ids `pt:*`; JSON:API, web sign-in, per-creator post
 index in `flow.storage`).
- `EdgeTts/` - Edge TTS plugin, adapted from Readest (keep its credit header).
- `test/host.mjs` - Node mirror of the app's `flow.*` host API (fetch, html, storage, secrets);
 `test/*.test.mjs` - plugin tests.
- `scripts/build-index.mjs` - validates manifests, writes `index.json` with sha256s; `HOST_API_VERSION`
 must match the app's `PLUGIN_HOST_API_VERSION`.
- `.github/workflows/publish.yml` - test, index check, Pages deploy.

## Commands

```sh
npm test # plugin tests (Node host)
npm run build # regenerate index.json
npm run check # fail if index.json is stale
```

Checks that live in the app repo (run them from `../flow-reader`):

```powershell
.\scripts\verify.ps1 # fast: includes plugin tests and the version-bump check when this repo changed
.\scripts\verify.ps1 -Full # adds `npm run check`, API version and host parity
node scripts/agent/contract-check.mjs # app runtime vs test/host.mjs vs plugin prelude; fails on mismatch
```

Find plugin code with `rg` from this folder, one plugin folder at a time (every plugin defines `pathOf`,
`search`, `loadChapter`), for example `rg -n '\bpathOf\(' RoyalRoad/`.

Run `contract-check` after any `flow.*` host change, and `verify -Full` before a release.

## Commits and pushes

- Commit with commit-mine, started from this repo's folder; `git add` and `git commit` are blocked:
  `node $HOME/.cursor/hooks/flow-agent/commit-mine.mjs -m "<plugin>: <msg>" --device "ran: ... | left for owner: ... | none: <reason>" [--also <path>...]`.
  It commits only the files this chat edited, plus `--also` paths, and needs the last passing verify stamp
  to match them. Files changed through Shell aren't tracked; pass them with `--also`.
- The first edit takes a per-chat lock for this repo. If another chat holds it, the edit is denied; don't work around
  a refusal, report it.
- **Pushing `main` publishes to users immediately** (GitHub Pages serves `index.json`). Push only with the owner's
  go-ahead, after `npm test`, `npm run build` and `npm run check` pass, and after any app release the plugins
  depend on is out.

## License

AGPL-3.0. `EdgeTts/` is adapted from Readest (also AGPL-3.0) and keeps its credit header.

This repo is public: no credentials, cookies, personal notes, or references to private repos.
