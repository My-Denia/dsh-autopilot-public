> This release is NOTES-ONLY — no tarball is attached, deliberately.
> The package's client half cannot be built on a CI runner (its type gate
> resolves externals through a sibling dsh checkout), and `npm pack` skips
> missing files silently, so a CI-built tarball would declare the
> `./client` export while shipping no `lib/client.js` — a silently broken
> artifact. Build from source on a machine with the sibling checkout, per
> the README. A real tarball unlocks when the client half becomes
> CI-buildable (externals typed against publishable artifacts).

The tag was verified on the runner with the same four gate commands CI
runs on every pull request (host typecheck, test typecheck, unit tests,
host build) before this release was created.
