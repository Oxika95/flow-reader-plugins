# Git hooks (flow-reader-plugins)

## Enable

Once per clone, with the owner's OK:

```sh
git config core.hooksPath scripts/git-hooks
```

Do not set this from an agent chat. Hooks under this path run instead of `.git/hooks`.

## `pre-push`

1. `npm test`
2. `npm run check` (index.json must match the plugins)
3. Fail if any path under `test/fixtures-raw/` is tracked (`git ls-files test/fixtures-raw`)
4. Secret-scan the commits being pushed. Looks for session/clearance cookie assignments,
   password literals, `Authorization` / `Bearer`, private keys, and long `token` / `secret`
   values. Hits are printed with values masked. Placeholders such as `KEY_PASSWORD = "password"`
   are allowlisted.

This hook stays self-contained (no call into the app repo's `verify.ps1`).

## Disable

```sh
git config --unset core.hooksPath
```
