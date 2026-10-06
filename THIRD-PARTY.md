# Third-party notices

SlicerX ships no code from OrcaSlicer, Bambu Studio, PrusaSlicer or Slic3r. The one thing it takes from them is the stock profile data described at the end. This file lists the third-party code, data and fonts that do ship. Each keeps its own license. The per-version list for a build is generated at release time into THIRD_PARTY_LICENSES. Licenses were checked with `cargo deny check` (policy in deny.toml) and `pnpm licenses list`.

## Vendored Rust crates (packages/vendor)

Each folder holds the upstream license files and a SOURCE.md with the exact changes. They are published on crates.io as sx-i-overlay, sx-boostvoronoi and sx-cpp-map, so the published sx-core builds with the same code; each keeps its original library name, license and authors.

| Crate | Version | License | Author | What we changed |
| --- | --- | --- | --- | --- |
| i_overlay | 9.0.0 | MIT or Apache-2.0 | Nail Sharipov | The list solver compares only segment pairs that changed after the first pass, and the cross solver checks shared end points first. Same output, about 7 percent fewer instructions on the benchmark plate. |
| boostvoronoi | 0.12.1 | BSL-1.0 | eadf | Faster `ExtendedInt` arithmetic (128-bit products for short operands, stack buffers, 12 inline chunks). Same output. Examples, benches, tests and optional integrations removed. |
| cpp_map | 0.2.0 | MIT or Apache-2.0 | eadf | Skip list levels come from a fixed-seed generator so a Voronoi diagram of the same outline is the same on every run. Unit tests removed. |

## STEP reader (packages/vendor/occt-import-js)

STEP files are read with occt-import-js 0.0.23 by Viktor Kovacs (LGPL-2.1), built on Open CASCADE Technology 7.6.1 by Open CASCADE SAS (LGPL-2.1 with the Open CASCADE exception 1.0). SlicerX makes use of facilities provided by the Open CASCADE Technology software. We build it from source with `packages/vendor/occt-import-js/build.sh` at pinned commits, with one small patch (each mesh says whether it is a solid), and commit the output with its SHA-256 in SOURCE.md. The WebAssembly file is a separate file that the app loads only when a STEP file is opened, so it can be rebuilt and replaced on its own. The license texts are in that folder. Each release attaches the complete source of the reader (occt-import-js and OCCT at the pinned commits, the patch and the build script), and SOURCE.md there has the full source offer.

## Rust dependencies worth naming

| Crate | License | Used for |
| --- | --- | --- |
| manifold-rust 0.15.0 | Apache-2.0 | Mesh booleans in sx-geom |
| ttf-parser 0.25.1 | MIT or Apache-2.0 | Reading the font for text solids in sx-geom. Marked unmaintained upstream (RUSTSEC-2026-0192); replacement planned. |
| str0m 0.24.0 | MIT or Apache-2.0 | WebRTC for camera and remote links in sx-link |
| aws-lc-rs and aws-lc-sys | ISC, Apache-2.0, MIT and BSD-3-Clause | TLS crypto through rustls. aws-lc-sys bundles AWS-LC, which carries several of these licenses. |
| openh264 (crate) 0.9.8 | BSD-2-Clause | Rust bindings for the decoder below |
| ort 2.0.0-rc.13 | MIT or Apache-2.0 | ONNX Runtime bindings for the print watch model |
| boostvoronoi, i_overlay, cpp_map | see above | Wall generation and polygon clipping |

## Downloaded at run time

OpenH264 by Cisco. On Linux, sx-link downloads Cisco's prebuilt `libopenh264-2.6.0-linux64.8.so` from ciscobinary.openh264.org on first use, checks its SHA-256 and loads it. Cisco pays the H.264 patent license for its own binaries, which is why SlicerX does not bundle or build a decoder. The library is BSD-2-Clause code with Cisco's binary license terms (https://www.openh264.org/BINARY_LICENSE.txt). macOS uses VideoToolbox and does not download anything.

## Model weights

The print watch runs SigLIP2 base (google/siglip2-base-patch16-224, Apache-2.0) exported to ONNX with float16 weights (packages/watch/model/export_siglip2.py). The 177 MB file `sx-watch-siglip2.onnx` is not in git. It ships beside the sx-watch binary.

## Fonts

- Hanken Grotesk SemiBold, Latin subset (packages/geom/fonts). Copyright The Hanken Grotesk Project Authors. SIL Open Font License 1.1, text in packages/geom/fonts/OFL.txt. The font declares no Reserved Font Name, so the subset keeps the name.
- The app bundles IBM Plex Sans, IBM Plex Mono, Inter and JetBrains Mono through @fontsource packages, all under OFL-1.1.

## JavaScript

- three.js 0.186.1 (MIT), used by the viewport in packages/ui/viewport.
- The npm workspace production dependencies are mostly MIT (756 of about 900 packages, including nested ones), with ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, OFL-1.1 (fonts), MPL-2.0 (lightningcss, mediabunny), BlueOak-1.0.0, Unlicense, 0BSD, CC-BY-4.0, CC0-1.0 and Python-2.0.
- Two packages need a note. @img/sharp-libvips (LGPL-3.0-or-later) is a prebuilt native library pulled in by image tooling and is dynamically linked. Remotion packages (their own license, free for individuals and small teams) are used only by the private film package and the private site, and are not part of the public tree.

## Credit

The aegis wall generator follows the method of preFlight's Athena walls (preFlight, `src/luminary/walls/athena`). It is a separate implementation written for SlicerX and contains no preFlight code.

## Stock profiles (packages/profiles)

The makers' stock printer, filament and process profiles (machine settings, start and end G-code, process speeds, filament presets and resolved profiles) come from the profile resources of OrcaSlicer (2.4.2 and main) and Bambu Studio, and keep their license, AGPL-3.0-or-later. They live in packages/profiles, apart from SlicerX code, and REUSE.toml lists them. The engine, the CLI and the C ABI do not use them; the app ships them. Setting key names follow those slicers so profiles and project files interchange. See docs/licensing.md.

The UltiMaker S3, S5, S7, S6 and S8 profiles (packages/profiles/cura/ultimaker.json) are resolved from UltiMaker Cura 5.13's machine definitions, print core variants, materials and quality profiles by packages/settings/scripts/gen-ultimaker.py, and keep Cura's license, LGPL-3.0-or-later. The material GUIDs the engine writes for these printers are those of UltiMaker's generic material profiles (fdm_materials, CC0-1.0).
