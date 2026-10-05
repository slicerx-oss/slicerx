# Changelog

All notable changes to `@slicerx/viewport` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Packaging for npm: a library build (`dist/index.js`, `dist/palette.js`, `dist/summary.js`) with three external and the SXPV reader bundled, self-contained type declarations, and `readPreview` re-exported so a page can load a `.sxpv` file with this package alone.
- The viewport: Prepare mode with plate, transform, cut, paint, sketch and push and pull tools, and Preview mode with instanced SXPV toolpaths, color schemes and legends.
