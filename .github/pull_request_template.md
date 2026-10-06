## What this changes

<!-- One or two sentences. Link the issue: Fixes #123 -->

## Why

<!-- The problem or the reason for the approach. -->

## For users

<!-- If people using SlicerX will notice this: one plain line for the release notes, and add the user-facing label.
     If it fixes a reported bug, add a line: Reported-in: <link to the Discord thread or issue>
     If people must update for it (a hotfix or security fix), add the urgent label and a line: Urgent: <why>
     Leave this section empty for changes nobody will notice. -->

## How it was tested

<!-- Commands run, printers used, files sliced. For slicing changes, give slice time before and after on the reference plate. -->

## Checklist

- [ ] Commits follow Conventional Commits and are signed off (`git commit -s`)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `cargo clippy`, and `cargo test` pass
- [ ] Tests added or updated
- [ ] Screenshot or recording attached for UI changes
- [ ] Docs updated if behavior or a public interface changed
- [ ] Any code from another project is credited, and its license is compatible with Apache-2.0
- [ ] No secrets, keys, or private model files in the diff
- [ ] AI tools helped with this change (name them here: ...), and I have read [CONTRIBUTING-AI.md](../CONTRIBUTING-AI.md)
