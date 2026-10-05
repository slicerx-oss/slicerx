# Licensing

## Apache-2.0

Everything SlicerX wrote is licensed under the Apache License 2.0. That covers the engine (`sx-core`), the `sx` command line tool, the C ABI (`libslicerx`), geometry, settings, printer connectors, the hub, mimir, the MCP server, the UI packages, the desktop and web apps, the SlicerX edition (`editions/slicerx`) and the examples. Each source file says so in its header:

```
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
```

The text is in `LICENSE-APACHE` at the root, next to `NOTICE`, and each package that is published on its own carries copies of both.

## What you must do

This is what the files in this repository say, not legal advice. `NOTICE`, `docs/licensing.md` and `REUSE.toml` have the full terms.

1. Keep the credit. Show "Made possible by SlicerX", linked to https://slicerx.app/support, on your About screen and in your docs. An edition config shows it for you and cannot drop it.
2. Path A, your own edition. The bundled printer profiles, printer pictures and Bambu certificates are AGPL-3.0-or-later, so an edition that ships them is an AGPL combined work as a whole. Publish its source (your fork: the SlicerX repository plus your config and brand files) and set `legal.sourceUrl` to it. Another app of yours, such as LayerMate, stays your own when it only launches the edition as a separate program and links none of its code.
3. Path B, embedding. `@slicerx/viewport` and `@slicerx/embed` are Apache-2.0 and can go into closed code. `@slicerx/mcp` carries AGPL profile data, so run it as its own process (the `slicerx-mcp` server) and offer its source. Do not bundle it into closed code.
4. Names. Use your own product name and logo. "SlicerX", its logo and the Nocturne artwork are trademarks (TRADEMARK.md).

## Credit: Made possible by SlicerX

The Apache License requires anyone who redistributes SlicerX, or a work built on it, to pass on the `NOTICE` file (section 4(d)). The NOTICE asks for the line "Made possible by SlicerX" with a link to https://slicerx.app/support wherever the product shows third-party credits: an About screen, a credits page or its documentation. A product with no such place ships the line in a NOTICE or credits file. This applies to the engine, the CAD layer, mimir, the MCP server, the apps and every other SlicerX package. The name SlicerX itself is a trademark: the credit line is allowed, but a fork must use its own name ([TRADEMARK.md](../TRADEMARK.md)). The Cargo `license` field and the npm `license` field say `Apache-2.0`.

## AGPL-3.0-or-later

These sets of data stay under the GNU Affero General Public License, version 3 or later, because they come from AGPL projects:

| Path | Why |
| --- | --- |
| `packages/profiles/` (`gcode.json`, `machine.json`, `process-speeds.json`, `filaments/`, `resolved/`) | The makers' stock printer, filament and process profiles, taken from the profile resources of OrcaSlicer and Bambu Studio (resolved by OrcaSlicer 2.4.2). The `maker_*` G-code families are the makers' own text as OrcaSlicer resolves it. |
| `packages/profiles/printer-images/` | The printer pictures, from the same AGPL sources. |
| `packages/connect/certs/bambu-ca.pem` | Bambu Lab's printer certificate authorities, listed in `REUSE.toml` as AGPL. |
| `packages/core/bench/compare/orca_base.json` | The settings OrcaSlicer 2.4.2 wrote for the parity reference, used only by the parity harness. |

JSON cannot carry a header, so `REUSE.toml` at the root records these paths, and the license text is in `LICENSES/AGPL-3.0-or-later.txt` and `packages/profiles/LICENSE`.

## LGPL-3.0-or-later

`packages/profiles/cura/ultimaker.json` holds the UltiMaker S series (S3, S5, S7, S6, S8): machine settings, print cores, quality preset speeds and G-code families, resolved from UltiMaker Cura's machine definitions, variants, materials and quality profiles by `packages/settings/scripts/gen-ultimaker.py` (Apache-2.0, our own code). Cura releases those resources under the GNU Lesser General Public License, version 3 or later, and the derived data keeps that license. `REUSE.toml` records the path; the text is in `LICENSES/LGPL-3.0-or-later.txt` and `packages/profiles/cura/LICENSE`, and the file's own `comment` and `license` fields name the source and the license. The LGPL lets this data ship in the AGPL app and inside `sx-profiles`, whose crate license is `AGPL-3.0-or-later AND LGPL-3.0-or-later`.

The material GUIDs the engine writes into an UltiMaker header (`packages/core/src/griffin.rs`) are the identifiers of UltiMaker's generic material profiles in `fdm_materials`, which UltiMaker publishes under CC0-1.0. No Cura or CuraEngine code is copied: the G-code the engine writes for these printers follows CuraEngine's behavior and the comments say which function, as with Orca.

No SlicerX code is translated or copied from OrcaSlicer, Bambu Studio, PrusaSlicer or Slic3r. Where a feature follows one of their algorithms, it is our own implementation, and the source comments name the function it follows.

The settings schema (`packages/settings/schema.json`, `defaults.json`, `legacy.json`, `prusa-map.json`) holds setting names, types, ranges, defaults and the legacy renames OrcaSlicer and PrusaSlicer accept. These are interoperability facts, with labels and help text written for SlicerX, and they are Apache-2.0 like the rest of the settings package.

## What this means for a build

- `sx-core`, `sx` and `libslicerx` do not use `packages/profiles`. A program that links them, or ships the binaries, can use either license.
- `sx-settings` reads the profiles through its default `stock-profiles` feature. Turn default features off to build it without them.
- `@slicerx/settings` imports `@slicerx/profiles`, so the SlicerX app ships the profiles. The app as distributed is a combined work under the AGPL, and a hosted build must offer its source (section 13). The edition config's `legal.sourceUrl` is required for that reason.
- Of the npm packages, `@slicerx/mcp` bundles the profiles (its printer tools read them) and is `Apache-2.0 AND AGPL-3.0-or-later AND LGPL-3.0-or-later`, with the AGPL and LGPL texts in its `dist/`. `@slicerx/viewport`, `@slicerx/embed` and `@slicerx/slicer` contain no profile data and are Apache-2.0.

## Third-party code

Vendored and bundled third-party code keeps its own license, and each one is compatible with distributing SlicerX under Apache-2.0. `NOTICE` and `THIRD-PARTY.md` list them: i_overlay and cpp_map (MIT or Apache-2.0), boostvoronoi (BSL-1.0), the STEP reader built from occt-import-js and Open CASCADE Technology (LGPL-2.1, loaded as a separate WebAssembly file, with a source offer), fonts under the SIL Open Font License, and the print watch model weights (Apache-2.0). The license files sit next to the code in `packages/vendor`.

## Contributions

Inbound is outbound. A contribution is licensed under the license of the files it changes: Apache-2.0 for SlicerX code, AGPL-3.0-or-later for the data in `packages/profiles`, LGPL-3.0-or-later for `packages/profiles/cura`. Contributors sign off each commit under the Developer Certificate of Origin (`git commit -s`), which states they have the right to submit the change under that license. See `CONTRIBUTING.md`.

## Trademarks

The licenses cover code and data, not the SlicerX name, logo or the Nocturne theme artwork. `NOTICE` has the trademark terms.
