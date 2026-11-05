# packages/profiles (sx-profiles and @slicerx/profiles)

The stock printer, filament and process profile data that SlicerX ships, kept apart from the code that reads it because it carries a different license.

| Path | What it holds |
| --- | --- |
| `machine.json` | Machine settings per printer model (bed shape and origin, printable height, machine limits, retraction and z hop defaults, extruder offsets), from the makers' own profiles, checked against OrcaSlicer |
| `gcode.json` | Start, end, layer change, filament change, pause and time lapse G-code per printer family. Families named `maker_*` are the makers' own text as OrcaSlicer 2.4.2 resolves it; the others were written for SlicerX |
| `process-speeds.json` | Speeds, accelerations and jerk of the makers' own process presets, per printer and quality tier, plus the values a maker overlay writes into a preset for a model with no resolved presets (`overlays/creality-ender-3-v3.json`) |
| `filaments/` | Filament presets per vendor folder, with the resolved values of OrcaSlicer 2.4.2's filament profiles (Bambu Studio's for Bambu Lab where 2.4.2 has none), and `index.json` |
| `resolved/` | Per brand, the printer, filament and process settings OrcaSlicer 2.4.2 resolves for each model's stock presets |
| `overlays/bbl-2.8.json` | Bambu Studio 2.8's values for the settings the engine reads, where OrcaSlicer 2.4.2's resolution of the Bambu Lab presets differs: filament presets by name, and the printer, default filament and process tiers of each model and nozzle. `packages/settings/scripts/gen-resolved.ts` applies it last, and `packages/settings/scripts/apply-overlay.ts` applies it to `filaments/BBL.json` and `resolved/bambu-lab.json`, so regenerating either keeps it |
| `overlays/prusa-mk4is.json` | The lift and retraction of the maker's MK4 IS printer profile for the stock Prusa MK4 with the 0.4 mm nozzle (0.2 mm lift below Z 219, 0.7 mm retraction, 1 degree travel slope), whose resolved preset carries the generic values. `packages/settings/scripts/gen-resolved.ts` applies it last, and `packages/settings/scripts/apply-overlay.ts` applies it to `resolved/prusa.json` and to the printer settings in `machine.json`; the other MK4 nozzles keep their own values there |
| `overlays/prusa-brim.json` | The maker's brim for every process tier of every Prusa model and nozzle, where the presets have no key for it: every whole loop the brim width fits (`brim_loop_rounding` whole), grown from the first layer outline after elephant foot compensation (`brim_use_efc_outline`). `packages/settings/scripts/gen-resolved.ts` applies it last, and `packages/settings/scripts/apply-overlay.ts` applies it to `resolved/prusa.json` |
| `overlays/prusa-first-layer.json` | The first layer of the maker's Input Shaper print presets for the stock Prusa MK4 and MINI, every nozzle and tier, whose resolved presets carry the generic 120% first layer lines and no elephant foot compensation: 0.32 mm lines and no compensation on the 0.25 mm nozzle, 0.5, 0.68 and 1 mm lines with 0.2 mm compensation on the 0.4, 0.6 and 0.8 mm nozzles. `packages/settings/scripts/gen-resolved.ts` applies it last, and `packages/settings/scripts/apply-overlay.ts` applies it to `resolved/prusa.json` |
| `overlays/creality-ender-3-v3.json` | The first layer and support line widths of the maker's process presets for the plain Creality Ender-3 V3 with the 0.4 mm nozzle (0.5 and 0.42 mm), which has no resolved presets and so takes SlicerX's process, where both widths are automatic, with its rows of `process-speeds.json` over it. `packages/settings/scripts/apply-overlay.ts` writes it into those rows, so rerun it after `process-speeds.json` is written again |
| `printer-images/` | One picture per catalog printer model, named by the catalog id (`bambu-h2d.webp`): the makers' `*_cover.png` from OrcaSlicer's profile resources (commit 97700c5a), re-encoded as 240 px webp. The setup's model grid shows them; a model without one gets a drawn placeholder |
| `cura/ultimaker.json` | The UltiMaker S3, S5, S7, S6 and S8: machine settings, print cores per nozzle size, the quality presets' speeds and the G-code families, resolved from UltiMaker Cura 5.13's definitions, variants, materials and quality profiles by `packages/settings/scripts/gen-ultimaker.py` |

## License

The data files in this folder come from the profile resources of OrcaSlicer and Bambu Studio and are licensed under the GNU Affero General Public License, version 3 or later (`LICENSE`), like the profiles they come from. `REUSE.toml` at the repository root records this per path.

`cura/` is the exception. UltiMaker Cura publishes its machine definitions under the GNU Lesser General Public License, version 3 or later, so the data derived from them keeps that license (`cura/LICENSE`, which supplements the GNU GPL version 3 at https://www.gnu.org/licenses/gpl-3.0.html). The file's `comment` and `license` fields say so too. LGPL-3.0 data can be combined with the AGPL data and the Apache-2.0 code in the app, which is distributed under the AGPL as a whole.

The code that reads them (`packages/settings`, the app) is Apache-2.0. A program that ships this data, such as the SlicerX app, is a combined work and is distributed under the AGPL as a whole. The engine (`sx-core`), the `sx` command line tool and the C ABI (`libslicerx`) do not use this package and stay Apache-2.0 on their own. `sx-settings` reads it through its default `stock-profiles` feature; build it with `default-features = false` to leave the data out, and the printer profile functions then return the values written for SlicerX only.

See `docs/licensing.md` for the whole picture.

## Use

- Rust: `sx_profiles::{MACHINE, GCODE, PROCESS_SPEEDS}` are the JSON texts of the three files at the top. The filament and resolved files are megabytes and are read from disk or imported on demand.
- TypeScript: `import gcode from '@slicerx/profiles/gcode.json'`, and dynamic imports such as `import('@slicerx/profiles/filaments/BBL.json')`. `@slicerx/settings` does this for you.

The files are written by the settings package's scripts (`packages/settings/scripts/gen-resolved.ts` and others, then `apply-overlay.ts`) and locked by its tests. Do not edit them by hand.
