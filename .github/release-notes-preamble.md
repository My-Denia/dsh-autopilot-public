> This GitHub Release is NOTES-ONLY — no tarball is attached, deliberately.
> The installable package is on npm as `dsh-goal-autopilot`. The client half
> cannot be built on a CI runner (its type gate resolves externals through a
> sibling dsh checkout), and `npm pack` skips missing files silently, so a
> CI-built tarball would declare the `./client` export while shipping no
> `lib/client.js`. GitHub is therefore not the binary channel.

The tag was verified on the runner with the same four gate commands CI
runs on every pull request (host typecheck, test typecheck, unit tests,
host build) before this release was created.

0.2.0 adapts the plugin to dsh 0.2.0. On WSL2 with dsh 0.2.0-rc.2 and a
local mock model, the release check covered install without a compatibility
exemption, the 12 root autopilot tools, the skill listed in the session catalog, a needs-fix resume of the same executor, and the web client bundle. Not verified here: Desktop on macOS or Windows, Windows in general,
a full run with a real model through closeout, executor re-recognition
after a cold-resumed child, and the card in a browser.
