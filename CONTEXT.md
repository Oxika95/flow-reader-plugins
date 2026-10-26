# Task routing

Find the task, load only the listed files and sections. The contract lives in the app repo, checked
out beside this one as `../flow-reader`.

| Task | Load | Section/Scope |
| --- | --- | --- |
| Edge TTS (handshake, GEC, synth, voices) | `EdgeTts/`, `.cursor/rules/edgetts.mdc`, then [Readest edgeTTS.ts](https://github.com/readest/readest/blob/main/apps/readest-app/src/libs/edgeTTS.ts) (+ [workersWebSocket.ts](https://github.com/readest/readest/blob/main/apps/readest-app/src/libs/workersWebSocket.ts) for raw WS) | Port upstream; do not reinvent |
| Change a plugin's parsing or fetching | `<Plugin>/index.js`, `test/<plugin>.test.mjs` | Functions involved |
| Add a function or capability | `../flow-reader/docs/plugins/api-functions.md`, `api-features.md` | The function's section |
| Change `plugin.json` | `../flow-reader/docs/plugins/api-manifest.md` | Field table |
| Use a `flow.*` host call | `../flow-reader/docs/plugins/api-host.md` | `## Host API` |
| Media card slots, icons | `../flow-reader/docs/plugins/ui-contract.md`, `examples/media-card.md` | Slot tables |
| Mirror a host API change | `test/host.mjs`, `../flow-reader/docs/agent/cross-repo.md` | Full |
| Add a plugin | an existing plugin folder as a shape reference, `api-manifest.md` | Full |
| Publish | `## Release rules` below | Full |

## Release rules

- Never change a published plugin's `id` or `bookIdPrefix` (they key users' books, data, sign-in).
- Bump `version` in `plugin.json` for every release; run `npm run build` and commit `index.json`.
- Plugins return JSON only: no UI, no app storage. Stats and badges go in `card` slots.
- Alpha: the app accepts only the current `apiVersion` (`MIN_API_VERSION` = `HOST_API_VERSION`).
  A contract bump means republishing every plugin with the new `apiVersion` and a bumped `version`.
- A `flow.*` API change starts in the app (`plugin/runtime/*`) and is mirrored in `test/host.mjs`.
  Ship the app first; plugins may only depend on what released app versions support.
- Before pushing `main`: `npm test`, `npm run build`, `npm run check` all pass.
