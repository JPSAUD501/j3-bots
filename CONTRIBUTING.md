# Contributing to J3 Bots

Thank you for helping. This file says how to build and check a change, what a change has to meet, and how a contribution is licensed. For anything larger than a small fix, open an issue first, so the approach can be agreed before you spend time on it.

Security problems are not reported here: see [SECURITY.md](SECURITY.md).

## Build and check

You need the Node release named in `engines.node` in the root `package.json`, the pnpm release named in `packageManager`, and Git.

```sh
pnpm install
pnpm typecheck
pnpm lint        # also checks every source file's SPDX header
pnpm fmt:check   # `pnpm fmt` rewrites the files it would change
pnpm test
pnpm knip        # unused files, dependencies and exports
```

These are the checks CI runs on every pull request. CI also builds the release archive for x64 and arm64 and runs it, runs the desktop app's smoke test, and checks that every commit is signed off ([below](#sign-off)).

To run J3 Bots from a checkout, see [Running on a Raspberry Pi](docs/operations/running-on-a-pi.md).

## What a change has to meet

Read [AGENTS.md](AGENTS.md), then [docs/README.md](docs/README.md) and the [engineering standards](docs/engineering/standards.md). In short:

- **The project's words.** Bot, conversation, session, engine and wake mean what [Concepts](docs/product/concepts.md) says, in code, interface text and docs.
- **TypeScript, strict.** No `any`, no cast to quiet the compiler, and data from outside the process decoded with a schema.
- **Boundaries.** Only `packages/engine-t3` knows T3 Code. Clients talk only to the J3 Bots server, through `packages/contracts`.
- **Tests of behavior that can break.** No test for what the types already guarantee, and none that asserts something removed stays removed.
- **The cause fixed**, not worked around.
- **An SPDX header**, `SPDX-License-Identifier: AGPL-3.0-or-later`, at the top of every source file you add.
- **One problem per pull request.** Its title has a conventional-commit prefix and says what changed for the person using J3 Bots. Its body gives the problem, the fix and how you verified it. The pull request template asks for the rest, including [Hit every surface](docs/engineering/standards.md#changes).
- **Docs that say what the code does.** A change that makes a document wrong rewrites it in the same pull request.
- **Original text.** No prompts, code or assets copied from another product unless its license allows it, and then with attribution ([Prior art](docs/research/prior-art.md)).

## Sign-off

Every commit carries a `Signed-off-by` line with its author's name and e-mail address:

```
Signed-off-by: Ada Example <ada@example.com>
```

`git commit -s` adds it, from your `user.name` and `user.email`. To sign off commits you have already made, run `git rebase --signoff` onto the branch your pull request targets and push again with `--force-with-lease`.

By signing off, you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/) for that commit. In short, you certify that:

1. you wrote the contribution, in whole or in part, and have the right to submit it under the open source license the file names; or
2. it is based on earlier work that, as far as you know, is under an appropriate open source license, and that license gives you the right to submit it, with your changes, under the same license; or
3. someone who certified 1, 2 or 3 gave it to you, and you have not changed it;
4. you understand that the project and the contribution are public, and that a record of the contribution, with the personal information you submit with it and your sign-off, is kept indefinitely and may be redistributed.

The full text at that link is what you certify; the list above only summarizes it.

Code taken from elsewhere must be under a license that allows distribution through app stores, such as MIT, BSD or Apache-2.0. Code from another project that is available only under the GPL or the AGPL cannot come in: it could not be distributed with the app-store permission below.

CI refuses a pull request with a commit whose message has no `Signed-off-by` line with that commit's author's e-mail address. Merge commits, and commits already on the base branch, are not checked.

### How contributions are licensed

J3 Bots is offered under the GNU Affero General Public License, version 3 or later ([LICENSE](LICENSE)), with the additional permission in [APP-STORE-PERMISSION](APP-STORE-PERMISSION), which allows distribution through app stores. A contribution submitted to J3 Bots comes in under those same terms, the permission included. Your sign-off certifies that you have the right to submit it. There is no separate contributor agreement. Why the project chose this is in [decision 0008](docs/decisions/0008-license.md).

### Contributions made with AI tools

A contribution written with an AI assistant or agent follows every rule above, and the human who submits it signs off every commit. Signing off means you have read the change, you stand behind it, and you can certify the Developer Certificate of Origin for it, including that it copies nothing its license does not let you submit. An AI tool cannot sign off. Naming it in a `Co-authored-by` line is welcome, and does not replace your sign-off.

## How a pull request is merged

A maintainer squash-merges a pull request into `main`, so its commits become one. The squash commit's message keeps every `Signed-off-by` line of the pull request's commits: GitHub's default squash message, which this repository uses, holds each commit's full message, and the maintainer keeps those lines when editing it.
