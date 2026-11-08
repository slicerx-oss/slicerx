### Added

- The integrator kit ships the self-contained server: `slicerx-mcp-standalone/` and the same folder as `slicerx-mcp-standalone.zip`, listed under `files` in `kit-manifest.json` (with `version`, `folder` and `entry`) and in `SHA256SUMS.txt`. Every dependency is inlined, so `node slicerx-mcp-standalone/slicerx-mcp.mjs` runs with no `node_modules`. Ship that folder instead of bundling `dist/cli.js`, which is a launcher that loads the server and some dependencies at run time, so a bundle of it has no server in it or fails on first use. The STEP reader stays the optional `slicerx-step-reader.tgz`; point `SLICERX_STEP_READER_DIR` at its `package/dist` folder, and without it `slicerx_step_read` is refused with `not_supported` as before. The quickstart's new section "Ship the server without node_modules" covers it. The folder carries its license texts: `NOTICE`, `LICENSE-APACHE`, `THIRD-PARTY-LICENSES.txt` (each npm package the build inlines, with its version and license text) and the profile licenses.

### Fixed

- The package ships `dist/LICENSE-GPL-3.0.txt` beside the LGPL text of the UltiMaker profiles it carries, since the LGPL builds on the GPL and a combined work ships both texts.
