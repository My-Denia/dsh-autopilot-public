# Release

The installable artifact is the npm package; this repository is its source. 0.5.0
is configuration only, so the tarball is `cordis.patch.yml`, the skill, the docs
and the manifests: a release is one npm publish plus a tag. Nothing is attached
to the GitHub Release: the registry is the only install channel.

## Before publishing

- `main` is green: `pnpm install --frozen-lockfile` and `node --test`
  (CI runs the same two gates; the tests also parse `cordis.patch.yml`).
- `package.json` has the intended `version` and `engines.dsh` range.
- The working tree is clean; there is no build artifact to produce.
- The target host version has been verified: install the packed tarball into a
  throwaway profile, load it (`--dump-config`), and in a session confirm that
  `delegate` and the five role presets are present and that a depth-1 child is
  refused when it tries to delegate.

## Publish

Authentication is per maintainer machine; the repository holds no token.

```sh
npm login                      # or export a valid NODE_AUTH_TOKEN / _authToken
pnpm install --frozen-lockfile
npm publish --tag next         # pre-releases; omit --tag for a stable release
```

`npm publish` runs from `main`. If the registry answers `E401` (whoami) or
`E404` on `PUT`, the token is missing, expired or belongs to an account without
publish access to `dsh-goal-autopilot`; fix authentication rather than changing
the package.

## Verify

```sh
npm view dsh-goal-autopilot dist-tags          # next points at the new version
npm view dsh-goal-autopilot@<version> dist.integrity
```

Then install from the registry into a throwaway profile:

```sh
dsh plugin --profile verify add dsh-goal-autopilot@<version>
dsh --profile verify --dump-config
```

Check the loaded rows: `delegate`, `preset-goal-scout`, `preset-goal-worker`,
`preset-goal-executor-lead`, `preset-goal-planner`, `preset-goal-reviewer`.

## Tag

After the registry copy is verified:

```sh
git tag -a v<version> -m "dsh-goal-autopilot <version>"
git push origin v<version>
```

The `Release` workflow gates the tag on the same two commands and creates a
notes-only GitHub Release from `.github/release-notes-preamble.md` and the
changelog. It does not publish to npm and attaches no tarball.

## Rollback

`npm publish` cannot be undone, but the tag is movable:

```sh
npm dist-tag add dsh-goal-autopilot@<previous-version> latest
```

`latest` is the stable channel; pre-releases go to `next` and never move
`latest` without an explicit `npm dist-tag` change.
