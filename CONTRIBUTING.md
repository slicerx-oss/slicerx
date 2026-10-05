# Contributing to SlicerX

Contributions are welcome: bug fixes, printer profiles, connectors, translations, docs, and features. SlicerX is licensed under Apache-2.0, and contributions are accepted under the same license. Only the stock profile data in `packages/profiles` is AGPL-3.0-or-later (`docs/licensing.md`).

## Using AI tools

AI coding assistants are allowed. Read [CONTRIBUTING-AI.md](CONTRIBUTING-AI.md) first: AI-assisted pull requests get a closer review, and everything people read has to meet its writing standard.

## Before you start

- Small fixes: open a pull request directly.
- Anything larger than a day of work, or anything that changes a file format, a public interface (the npm package, the Rust crate, the CLI, the C ABI, the MCP tools) or the UI layout: open an issue first so we can agree on the approach. Large pull requests nobody discussed are the most likely to be declined.
- Printer support: use the printer support request template. A profile pull request needs a printed test, not only a config that loads.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Setting up

You need Node 24 or newer, pnpm 10 and Rust 1.98.1 (pinned in `rust-toolchain.toml`).

```
pnpm install
cargo build
pnpm dev
```

Before you push, run:

```
pnpm lint && pnpm typecheck && pnpm test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Sign your commits (DCO)

We use the Developer Certificate of Origin, not a CLA. Every commit needs a `Signed-off-by` line matching the commit author:

```
git commit -s -m "fix(core): clamp seam position to the layer polygon"
```

By signing off you certify the statement at https://developercertificate.org/: you wrote the change or have the right to submit it under the project license. You keep your copyright. To sign off earlier commits on your branch: `git rebase --signoff main`. CI rejects pull requests with unsigned commits.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) for every commit and for the pull request title, since we squash on merge and the title becomes the changelog entry.

```
type(scope): short imperative summary

Optional body: what changed and why, wrapped at 72 columns.

Signed-off-by: Your Name <you@example.com>
```

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes follow the layout: `core`, `ui`, `viewport`, `pilot`, `connect`, `settings`, `sx3mf`, `mcp`, `desktop`, `web`, `site`, `deps`.
- The summary is imperative, lowercase, without a trailing period, and 72 characters or fewer. Say what changed ("add", "fix", "remove").
- A breaking change adds `!` after the scope and a `BREAKING CHANGE:` footer.

## Pull requests

- Branch from `main` and name the branch `type/short-description`, for example `fix/seam-crash` or `feat/moonraker-queue`.
- Keep a pull request to one change, ideally under about 400 changed lines. Refactors go in their own pull request.
- Add or update tests. A bug fix needs a test that fails without the fix. A change that alters G-code output updates the golden files in the same pull request and explains why.
- Include a screenshot or short recording for any UI change, and the before and after slice time on the reference plate for any change to slicing.
- A change to a public surface (npm package, crate, CLI JSON, C ABI, MCP tools) adds a line to that package's `CHANGELOG.md`.
- Fill in the pull request template. A maintainer reviews within a week; ping the thread if it has been longer.

## Code and writing style

- New source files start with the license header:

  ```
  // SPDX-License-Identifier: Apache-2.0
  // Copyright (C) 2026 The SlicerX contributors
  ```

- Rust library code returns errors and does not panic on bad input; `unsafe` is limited to the FFI wrappers, each block with a `// SAFETY:` comment. TypeScript runs in strict mode, with no `any`, and validates data at boundaries with Zod.
- Comments explain why, not what.
- Use American English spelling in code, comments, docs, UI text and commit messages (color, center, license, canceled).
- Do not use em dashes or en dashes as punctuation; CI checks for them. Use a period, comma, colon or parentheses. Hyphens in compound words, identifiers and paths are fine.
- No emojis in code, docs, commits or issues.
- UI text uses sentence case and always shows units (mm, C, g, h m). Say exactly what a control does.
- Example content uses fictional names and neutral models, never third-party characters or real creators' work.

## Code from other projects

Do not paste code you did not write unless its license is compatible with Apache-2.0 and you say where it came from in the pull request. Do not copy code from OrcaSlicer, PrusaSlicer or Bambu Studio, or data other than their profiles into `packages/profiles`; read their behavior and write your own. Never copy from proprietary or source-available slicers or from decompiled binaries.

## Contribution licensing

Inbound is outbound: your contribution is licensed under the license of the files it changes, Apache-2.0 for SlicerX code and AGPL-3.0-or-later for the data in `packages/profiles`. Your sign-off (`git commit -s`) certifies you can submit it under that license. The SlicerX name and logo are not covered by the license; see the trademark note in the README.

## Conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
