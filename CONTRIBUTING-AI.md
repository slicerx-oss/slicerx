# Contributing with AI tools

You can use AI coding assistants to contribute to SlicerX. We review those pull requests more closely, and the bar for what gets merged is the same as for any other change: you understand it, it is tested, and it reads like a person wrote it.

This page adds to [CONTRIBUTING.md](CONTRIBUTING.md). Everything there still applies.

## You own the change

- Read every line before you open the pull request. If you cannot explain why a line is there, take it out or find out.
- Run the code. A pull request that was never built or tested is closed.
- Answer review questions yourself. A reply pasted from a chat window does not count as understanding the code.
- Keep the change small and about one thing. Large generated diffs, drive-by rewrites and formatting sweeps are closed without review.
- Do not open pull requests in bulk, and do not let an agent open them for you without reading each one.

## Say that you used it

Tick the AI box in the pull request template and name the tools, for example "Claude Code for the parser, tests written by hand". Reviewers use it to decide where to look harder, and it does not count against you.

## How we review AI-assisted pull requests

Expect more questions and a slower review. We check:

- that the code does what the description says, with tests that fail without the change
- that nothing was invented: APIs, settings, file formats, config keys and printer behavior that do not exist
- that behavior copied from another slicer was worked out from its source and written fresh (see [Code from other projects](CONTRIBUTING.md#code-from-other-projects)), not reproduced from memory
- that the change fits the code around it instead of adding new layers, helpers or abstractions nobody asked for
- that everything a user or developer reads meets the writing standard below

We may ask you to split the change, cut it down, or walk through part of it.

## The writing standard

Anything a person reads has to sound like a person wrote it. That covers UI text, error messages, docs, READMEs, code comments, commit messages, pull request descriptions and changelog entries. AI tools write in a recognizable way, and we edit that out before anything ships.

Write it this way:

- State the point. Skip the run-up ("Let's dive in", "Here's the thing") and the one-line closer that repeats the paragraph.
- Plain verbs: is, are, has. Not "serves as", "boasts", "features", "stands as".
- No inflated words: pivotal, robust (unless it is a technical claim you can back up), seamless, leverage, comprehensive, testament, landscape, delve.
- No "not X, but Y" contrasts unless someone really believes X.
- Do not force things into groups of three. Use as many items as there are.
- No bold labels on every list item, no title case headings, no emojis, no arrows as decoration.
- No em dashes or en dashes; CI checks for them.
- American spelling.
- UI text in sentence case, with units, using the terms slicer users already know.

Code comments follow the same rule and one more: say why, and keep it short. Do not narrate what the next line does, write essays at the top of a module, or restate a function's name in its doc comment. The CAD engine (`packages/geom`) uses short lowercase comments; match the file you are in.

A quick test: read the text aloud. If it sounds like a product announcement or a chatbot answer, rewrite it.

## Code standards

These apply to every pull request. AI-assisted ones get checked against them line by line.

- Match the surrounding code: naming, error handling, structure, comment density.
- No dead code, commented-out code, placeholder TODOs or unused parameters.
- No new dependency without a reason in the pull request description, and its license must be compatible with Apache-2.0.
- Tests for the behavior, not for the implementation. Slicing changes include before and after numbers on the reference plate, and G-code changes update the golden files with an explanation.
- The engine stays deterministic: the same input gives the same bytes on every platform, in the browser and at any thread count. `check-wasm` must pass.
- No secrets, tokens or personal data in code, tests, logs or fixtures.
- Safety rules for printers do not change in a pull request about something else. An AI tool connected through mimir or the MCP server can never start a print, resume one or send raw G-code without the user's confirmation, and no change may weaken that.

## Licensing and provenance

Your sign-off (`git commit -s`) certifies that you have the right to submit the code under Apache-2.0. That includes code an assistant wrote for you. If a tool reproduced a recognizable block of code from somewhere else, find where it came from and either credit it with a compatible license or rewrite it.

## Before you open the pull request

- [ ] You read and understand every changed line.
- [ ] It builds, and the tests and checks in CONTRIBUTING.md pass.
- [ ] User-facing text, docs, comments and the description meet the writing standard.
- [ ] Nothing in it is invented or copied without credit.
- [ ] The AI box in the template is ticked, with the tools named.
