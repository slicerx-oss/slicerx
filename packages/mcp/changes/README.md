# Change files

Each pull request that changes `@slicerx/mcp` for its users (a tool, its input or answer, a refusal, the CLI, the
server's options) adds one file here, named after its branch or topic with dashes, such as `feat-partner-routes.md`.
Leave CHANGELOG.md and TOOLS.md alone: the release folds these files into CHANGELOG.md and writes TOOLS.md again.

A change file has one or more of these headings, each followed by its entries written as CHANGELOG.md writes them:
the tool's MCP name and new version first, then what a client sees.

```md
### Added

- `slicerx_example_read` 1.0.0 reads the example from the hub: `id`, `name` and `state`. Simulated printers are refused with `not_supported`.

### Changed

- `slicerx_slice_file` 1.6.0 returns `example` with the sx engine.

### Fixed

- `slicerx_inspect_project` reads a project whose plate list is empty. Before, it was refused with `invalid_model`.
```

Use `### Breaking` or `### Removed` only for a breaking change or a tool taken away. A follow-up to an open pull request
edits that pull request's file. `node scripts/fold-changes.mjs packages/mcp --check` checks the files, and
`pnpm test:scripts` runs the same check.

At a release, `node scripts/fold-changes.mjs packages/mcp <version>` writes the version's section into CHANGELOG.md
(Breaking, Added, Changed, Removed, Fixed, newest file first under each), deletes the files it folded and writes
TOOLS.md from the tool list.
