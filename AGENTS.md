# Agent guide: flow-reader-plugins

Public repo: official source plugins for the Flow Reader Android app. Each top-level folder is one
plugin (`plugin.json` + `index.js`, CommonJS, sandboxed QuickJS in the app). Published to GitHub
Pages as `index.json` on every push to `main`, so a push reaches users immediately.

Start at [CONTEXT.md](CONTEXT.md): task routing and the release rules.

## Layout

- `RoyalRoad/` - Royal Road plugin (`id: royalroad`, book ids `rr:*`).
- `Patreon/` - Patreon plugin (`id: patreon`, book ids `pt:*`; JSON:API, web sign-in, per-creator post
 index in `flow.storage`).
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

This repo is public: no credentials, cookies, personal notes, or references to private repos.
