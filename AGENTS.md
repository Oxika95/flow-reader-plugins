# Agent guide — flow-reader-plugins

Public repo: official source plugins for the Flow Reader Android app. Each top-level folder is one
plugin (`plugin.json` + `index.js`, CommonJS, sandboxed QuickJS in the app). Published to GitHub
Pages as `index.json` on every push to `main`, so a push reaches users immediately.

## Layout

- `RoyalRoad/` - Royal Road plugin (`id: royalroad`, book ids `rr:*`).
- `test/host.mjs` - Node mirror of the app's `flow.*` host API (fetch, html, storage, secrets);
  `test/*.test.mjs` - plugin tests.
- `scripts/build-index.mjs` - validates manifests, writes `index.json` with sha256s; `HOST_API_VERSION`
  must match the app's `PLUGIN_HOST_API_VERSION`.
- `.github/workflows/publish.yml` - test, index check, Pages deploy.

## Commands

```sh
npm test          # plugin tests (Node host)
npm run build     # regenerate index.json
npm run check     # fail if index.json is stale
```

## Contract (lives in the app repo)

When the app repo is checked out beside this one (`../flow-reader`):
`../flow-reader/docs/plugins/api.md`, `ui-contract.md`, `examples/media-card.md`, `schema/*.json`.
Cross-repo change checklist: `../flow-reader/docs/agent/map.md`.

## Rules

- Never change a published plugin's `id` or `bookIdPrefix` (they key users' books, data, sign-in).
- Bump `version` in `plugin.json` for every release; run `npm run build` and commit `index.json`.
- Plugins return JSON only: no UI, no app storage. Keep v1 fields (`status`, `rating`, `views`)
  alongside apiVersion 2 `card` slots.
- A `flow.*` API change starts in the app (`plugin/runtime/*`) and is mirrored in `test/host.mjs`.
  Ship the app first; plugins may only depend on what released app versions support.
- This repo is public: no credentials, cookies, personal notes, or references to private repos.
