# Release

The installable artifact is the npm package; this repository is its source. A
release is one npm publish plus a tag. Nothing is attached to the GitHub
Release: the registry is the only install channel.

## Before publishing

- `main` is green: `pnpm install --frozen-lockfile`, `pnpm run build`,
  `pnpm run check`, `pnpm test` (CI runs the same four gates).
- `package.json` has the intended `version` and `engines.dsh` range.
- The working tree is clean and `lib/` is built from that tree (the tarball
  ships `lib/`, and `lib/` is not tracked).
- The target host version has been verified: install the packed tarball into a
  throwaway profile and load it (`--dump-config`, then a headless run).

## Publish

Authentication is per maintainer machine; the repository holds no token.

```sh
npm login                      # or export a valid NODE_AUTH_TOKEN / _authToken
pnpm install --frozen-lockfile
pnpm run build
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

## Tag

After the registry copy is verified:

```sh
git tag -a v<version> -m "dsh-goal-autopilot <version>"
git push origin v<version>
```

The `Release` workflow gates the tag on the same four commands and creates a
notes-only GitHub Release from `.github/release-notes-preamble.md` and the
changelog. It does not publish to npm and attaches no tarball.

## Rollback

`npm publish` cannot be undone, but the tag is movable:

```sh
npm dist-tag add dsh-goal-autopilot@<previous-version> latest
```

`latest` is the stable channel; pre-releases go to `next` and never move
`latest` without an explicit `npm dist-tag` change.