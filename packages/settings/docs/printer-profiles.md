# Printer profiles

Each printer profile carries the machine settings of the maker's own profile for that model, checked against OrcaSlicer commit 97700c5: bed shape and origin, printable height, nozzle and extruder offsets, machine limits, retraction and z hop defaults, G-code flavor, extruder clearance, thumbnails and the rest of the numbers and choices. `packages/profiles/machine.json` holds them and `js/machine.test.ts` locks them. A private script diffs them against the maker's current profiles and fails on any difference.

Where the printer catalog and the maker's profile disagree, the profile's value is the one in the printer config (`printerConfig`). Start, end, layer change, filament change, pause and time lapse G-code (and the file start G-code where the maker has one) is the maker's own text as OrcaSlicer 2.4.2 resolves it for the printer's default filament (the owner reported the makers' permission on 2026-09-30), and written for SlicerX for printers Orca has no preset for. The shipped text is compared with Orca 2.4.2's resolved text for every printer that has a dump.

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
| Sovol SV04 | no maker profile to check against | written | catalog values only |
| FLSUN V400 | checked at 97700c5 | written | same bed and height |
| Other printer Klipper delta | no maker profile to check against | written | catalog values only |
| Other printer Klipper printer | no maker profile to check against | written | catalog values only |
| Other printer Printer behind OctoPrint | no maker profile to check against | written | catalog values only |
| Other printer Duet board | no maker profile to check against | written | catalog values only |
| Other printer Printer without a connection | no maker profile to check against | written | catalog values only |
