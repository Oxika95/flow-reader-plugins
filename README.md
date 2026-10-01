# flow-reader-plugins

Official source plugins for [Flow Reader](https://github.com/Oxika95/FlowReader). Each folder is one
plugin (`plugin.json` + `index.js`, sandboxed JavaScript). The app ships no plugins; it installs them
from this repository's published index:

```
https://oxika95.github.io/flow-reader-plugins/index.json
```

That URL is pre-added in Flow Reader under **Settings → Import → Plugins**.

| Folder | Plugin | Site |
| --- | --- | --- |
| [`RoyalRoad/`](RoyalRoad/) | Royal Road (`royalroad`, book ids `rr:*`) | royalroad.com |

## Writing a plugin

The contract lives in the app repo:

- [Plugin API](https://github.com/Oxika95/FlowReader/blob/master/docs/plugins/api.md): manifest, functions, `flow` host API
- [UI contract](https://github.com/Oxika95/FlowReader/blob/master/docs/plugins/ui-contract.md): what the app renders from your manifest
- [Media card example](https://github.com/Oxika95/FlowReader/blob/master/docs/plugins/examples/media-card.md): apiVersion 2 `card` slots and `cardAction`
- [JSON schemas](https://github.com/Oxika95/FlowReader/tree/master/docs/plugins/schema): `plugin.json`, `loadWork` result, `cardAction` result

Plugins never draw UI and never touch the app's storage. They fetch and parse a site through `flow.*`
and return plain JSON. With `apiVersion: 2` a plugin can fill the story media card's slots (stats,
badges, links, up to two rail and two footer actions); the app owns layout, theme, and the core
actions. Keep the v1 fields (`status`, `rating`, `views`) so older app versions still show them.
`npm run build` accepts `apiVersion` 1 or 2.

1. Create `YourSite/plugin.json` and `YourSite/index.js` (CommonJS: assign to `module.exports`).
2. Add tests under `test/` using the Node host in [`test/host.mjs`](test/host.mjs), which mirrors the
   app's `flow` API (Jsoup-style HTML nodes, non-throwing fetch, per-plugin secrets).
3. Bump `version` in `plugin.json` for every release; the app only offers higher versions as updates.
4. `npm run build` to regenerate `index.json` (sha256 of each file; the app refuses mismatches).

Never change a published plugin's `id` or `bookIdPrefix`: they key users' books, data, and sign-in.

## Commands

```sh
npm install
npm test          # plugin tests (Node host)
npm run build     # regenerate index.json
npm run check     # fail if index.json is stale (CI)
```

## Trying changes on a device

Debug builds of Flow Reader bundle this checkout when it sits next to the app repo
(`C:\Git\flow-reader-plugins` beside `C:\Git\flow-reader`), or wherever `-PflowPluginsDir=...` points,
and reinstall it whenever the files change:

```sh
cd ../flow-reader
./gradlew :app:installDebug
```

## Publishing

Pushing to `main` runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml): tests, index
check, then deploys `index.json` and each plugin folder to GitHub Pages. Enable Pages with
**Source: GitHub Actions** in the repository settings.
