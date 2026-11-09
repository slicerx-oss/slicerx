# Printer profiles

Each printer profile carries the machine settings of the maker's own profile for that model, checked against OrcaSlicer commit 97700c5: bed shape and origin, printable height, nozzle and extruder offsets, machine limits, retraction and z hop defaults, G-code flavor, extruder clearance, thumbnails and the rest of the numbers and choices. `packages/profiles/machine.json` holds them and `js/machine.test.ts` locks them. A private script diffs them against the maker's current profiles and fails on any difference.

Where the printer catalog and the maker's profile disagree, the profile's value is the one in the printer config (`printerConfig`). Start, end, layer change, filament change, pause and time lapse G-code (and the file start G-code where the maker has one) is the maker's own text as OrcaSlicer 2.4.2 resolves it for the printer's default filament (the owner reported the makers' permission on 2026-09-30), and written for SlicerX for printers Orca has no preset for. The shipped text is compared with Orca 2.4.2's resolved text for every printer that has a dump.

The Sovol SV04 has no maker profile to read, so its machine settings are written from Sovol's published firmware source (Marlin 2.0.9.2, `Marlin/Configuration.h` and `Marlin/Configuration_adv.h` of https://github.com/Sovol3d/SV04-IDEX-3D-Printer-Mainboard-Source-code at commit 1867fcba, read 2026-11-09; `machine.json` names them under `makerDocs`): two extruders with 0.4 mm nozzles, the 300 x 300 x 400 mm volume Sovol states for it, extruder offsets of zero (the firmware runs in its auto-park mode and applies the carriage offset itself), and the firmware's speed, acceleration and jerk limits. Its G-code family `sovol_sv04` was written for SlicerX and is in `packages/profiles/gcode-written.json`: the start heats both nozzles together when the plate uses both and primes each along its own edge of the bed, and a tool change is a `T` command followed by a wait for the new tool's temperature, with no manual swap. These values are estimated, not from Sovol: the right tool's prime line (X 298, Y 10 to 140 and back at X 297.6), the left tool's prime line (X 2, Y 10 to 140 and back at X 2.4), the prime height (Z 0.28) and length (10 mm each way), the travel height before each prime (Z 5), the 150 °C nozzle temperature while homing, the end's first lift (2 mm above the print), the present move (Y at 80 percent of the bed, Y 240) and the last lift (70 mm above the print, at most 10 mm under the top). Every one of these moves is inside the bed and inside the X range both carriages reach (the left one X -62 to 302, the right one X 0 to 362), and the end lifts before it moves; `packages/core/tests/sv04_tool_changes.rs` checks that on the sliced G-code. The limits are the firmware's compiled defaults, so a printer whose settings were changed from its screen or saved with `M500` may differ. This profile has not been run on a real SV04. Duplication and mirror modes are not covered.

| Model | Machine settings | G-code | Bed and height |
| --- | --- | --- | --- |
| Bambu Lab X1 Carbon | checked at 97700c5 | maker template | catalog 256x256x256 mm, profile 256x256x250 mm |
| Bambu Lab X1 | checked at 97700c5 | maker template | catalog 256x256x256 mm, profile 256x256x250 mm |
| Bambu Lab X1E | checked at 97700c5 | maker template | catalog 256x256x256 mm, profile 256x256x250 mm |
| Bambu Lab P1P | checked at 97700c5 | maker template | catalog 256x256x256 mm, profile 256x256x250 mm |
| Bambu Lab P1S | checked at 97700c5 | maker template | catalog 256x256x256 mm, profile 256x256x250 mm |
| Bambu Lab P2S | checked at 97700c5 | maker template | same bed and height |
| Bambu Lab A1 | checked at 97700c5 | maker template | same bed and height |
| Bambu Lab A1 mini | checked at 97700c5 | maker template | same bed and height |
| Bambu Lab H2D | checked at 97700c5 | maker template | same bed and height |
| Bambu Lab H2C | checked at 97700c5 | maker template | same bed and height |
| Bambu Lab H2S | checked at 97700c5 | maker template | same bed and height |
| Prusa Research MK4S | checked at 97700c5 | maker template | same bed and height |
| Prusa Research MK4 | checked at 97700c5 | maker template | same bed and height |
| Prusa Research MK3.9 | no maker profile to check against | written | catalog values only |
| Prusa Research MINI+ | checked at 97700c5 | maker template | same bed and height |
| Prusa Research Core One | checked at 97700c5 | maker template | same bed and height |
| Prusa Research XL | checked at 97700c5 | maker template | same bed and height |
| Prusa Research XL, 5 toolheads | checked at 97700c5 | maker template | same bed and height |
| Creality K1 | checked at 97700c5 | maker template | same bed and height |
| Creality K1C | checked at 97700c5 | written | same bed and height |
| Creality K1 Max | checked at 97700c5 | maker template | same bed and height |
| Creality K1 SE | checked at 97700c5 | written | same bed and height |
| Creality K2 Plus | checked at 97700c5 | maker template | same bed and height |
| Creality Ender-3 V3 | checked at 97700c5 | written | same bed and height |
| Creality Ender-3 V3 Plus | checked at 97700c5 | written | same bed and height |
| Creality Ender-3 V3 SE | checked at 97700c5 | maker template | same bed and height |
| Creality Ender-3 V3 KE | checked at 97700c5 | maker template | catalog 220x220x240 mm, profile 220x220x245 mm |
| Creality Creality Hi | checked at 97700c5 | written | same bed and height |
| Creality Ender-3 with OctoPrint | checked at 97700c5 | maker template | same bed and height |
| Elegoo Centauri Carbon | checked at 97700c5 | maker template | same bed and height |
| Elegoo Neptune 4 | checked at 97700c5 | maker template | same bed and height |
| Elegoo Neptune 4 Pro | checked at 97700c5 | maker template | same bed and height |
| Elegoo Neptune 4 Plus | checked at 97700c5 | maker template | catalog 320x320x385 mm, profile 325x325x385 mm |
| Elegoo Neptune 4 Max | checked at 97700c5 | maker template | catalog 420x420x480 mm, profile 426x426x480 mm |
| Anycubic Kobra X | checked at 97700c5 | maker template | same bed and height |
| Snapmaker U1 | checked at 97700c5 | maker template | catalog 270x270x270 mm, profile 270x270x270.05 mm |
| Snapmaker A150 | no maker profile to check against | written | catalog values only |
| Snapmaker A250 | checked at 97700c5 | maker template | catalog 230x250x235 mm, profile 230x250x230 mm |
| Snapmaker A350 | checked at 97700c5 | maker template | catalog 320x350x330 mm, profile 320x350x325 mm |
| Snapmaker J1 | checked at 97700c5 | maker template | catalog 300x200x200 mm, profile 324x200x200 mm |
| Snapmaker Artisan | checked at 97700c5 | maker template | same bed and height |
| Qidi Q1 Pro | checked at 97700c5 | maker template | same bed and height |
| Qidi X-Plus 4 | checked at 97700c5 | maker template | same bed and height |
| Voron Design Voron 0.1 | checked at 97700c5 | written | same bed and height |
| Voron Design Voron 2.4 250 | checked at 97700c5 | maker template | same bed and height |
| Voron Design Voron 2.4 300 | checked at 97700c5 | maker template | same bed and height |
| Voron Design Voron 2.4 350 | checked at 97700c5 | maker template | same bed and height |
| Voron Design Voron Trident 250 | checked at 97700c5 | maker template | same bed and height |
| Voron Design Voron Trident 300 | checked at 97700c5 | maker template | same bed and height |
| Voron Design Voron Trident 350 | checked at 97700c5 | maker template | same bed and height |
| Voron Design Voron Switchwire 250 | checked at 97700c5 | maker template | same bed and height |
| Sovol SV08 | checked at 97700c5 | maker template | same bed and height |
| Sovol SV04 | written from the maker's firmware source, read 2026-11-09 | written | same bed and height |
| FLSUN V400 | checked at 97700c5 | written | same bed and height |
| Other printer Klipper delta | no maker profile to check against | written | catalog values only |
| Other printer Klipper printer | no maker profile to check against | written | catalog values only |
| Other printer Printer behind OctoPrint | no maker profile to check against | written | catalog values only |
| Other printer Duet board | no maker profile to check against | written | catalog values only |
| Other printer Printer without a connection | no maker profile to check against | written | catalog values only |
