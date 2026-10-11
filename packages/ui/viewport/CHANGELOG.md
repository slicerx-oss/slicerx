# Changelog

All notable changes to `@slicerx/viewport` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `meshWorker` option and the `@slicerx/viewport/mesh-worker` entry: parts of 200,000 triangles or more build their creased normals and feature edges in workers, after a smooth shaded stand-in shows at once; `platerefined` event and `stats().refiningParts`.
- The plate reveal: on the first plate a window shows, the outline is traced from the front, the hit blooms and the grid lays down back to front, about 2 s. Later views, reduced motion and software graphics draw the plate at once; `reveal: false` turns it off.
- Packaging for npm: a library build (`dist/index.js`, `dist/palette.js`, `dist/summary.js`) with three external and the SXPV reader bundled, self-contained type declarations, and `readPreview` re-exported so a page can load a `.sxpv` file with this package alone.
- The viewport: Prepare mode with plate, transform, cut, paint, sketch and push and pull tools, and Preview mode with instanced SXPV toolpaths, color schemes and legends.
