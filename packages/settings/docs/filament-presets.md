# Filament presets

6845 presets in 1116 products, with the resolved values of OrcaSlicer 2.4.2's filament profiles (commit 8500fcdc). 2207 presets are not in 2.4.2 and keep their values from OrcaSlicer main (commit 97700c5a) or, for Bambu Lab, Bambu Studio (commit da8b44ee); each vendor file lists them under `fallback`, and `loadFilamentPreset` reports the source. Brands 2.4.2 has no preset for at all: INSLOGIC, JAYO, PlastAR, Printalot. Each preset carries every filament setting the profile sets: nozzle temperatures (first layer, other layers, range), bed temperatures per plate, chamber temperature, fan minimum and maximum, cooling thresholds and slowdown, overhang and bridge fan, flow ratio, pressure advance, maximum volumetric speed, retraction overrides, shrinkage, density, diameter, cost, the soluble and support flags, the filament start and end G-code, and the compatible printers.

The files are in `packages/profiles/filaments/`, one per vendor folder, plus `index.json`. A vendor file holds the vendor's common values, each product's own values and each printer variant's differences. `loadFilamentPreset(vendor, family, variant)` merges them and types the values; keys only some slicers define come back in `extras` in the profile's own format. `js/filaments.test.ts` locks the files, and a private script diffs them against the 2.4.2 profiles (and the fallback sources) and fails on any difference.

The Bambu Lab material id (`filament_id`) is Bambu Studio's, since 2.4.2 sets none.

Every filament setting is advanced in the schema, except the material (`filament_type`), the brand (`filament_vendor`) and the color (`default_filament_colour`).

## By vendor folder

| Vendor folder | Products | Presets | Brands |
| --- | --- | --- | --- |
| BBL | 235 | 2570 | Aliz, BETA, Bambu Lab, COEX 3D, FusRock, Generic, Numakers, Overture, Polymaker, SUNLU, addnorth, eSUN |
| OrcaFilamentLibrary | 399 | 968 | Aliz, BETA, Bambu Lab, COEX 3D, DREMC, Elas, Elegoo, Eolas Prints, FDplast, FILL3D, FilAr, FusRock, Generic, GreenGate3D, INSLOGIC, JAYO, NIT, Numakers, Overture, PlastAR, Polymaker, Printalot, SUNLU, Valment, addnorth, eSUN |
| Prusa | 48 | 548 | Generic, Prusa Polymers |
| Creality | 108 | 833 | Creality, Generic, Polymaker, eSUN |
| Elegoo | 45 | 219 | Elegoo, Generic |
| Qidi | 97 | 1405 | Bambu Lab, Generic, HATCHBOX, Overture, Polymaker, QIDI |
| Snapmaker | 117 | 199 | Generic, Polymaker, Snapmaker |
| Sovol | 31 | 55 | Generic |
| FLSun | 36 | 48 | Generic |

## By brand

| Brand | Products | Presets | Materials |
| --- | --- | --- | --- |
| Generic | 264 | 1677 | ABS, ABS-CF, ASA, ASA-CF, BVOH, CoPE, EVA, FLEX, HIPS, PA, PA-CF, PA-GF, PA6-CF, PC, PC-CF, PCTG, PE, PE-CF, PET, PET-CF, PETG, PETG-CF, PETG-GF, PHA, PLA, PLA-CF, PP, PP-CF, PP-GF, PPA-CF, PPA-GF, PPS, PPS-CF, PVA, SBS, TPU, TPU-AMS |
| Bambu Lab | 101 | 1446 | ABS, ABS-GF, ASA, ASA-AERO, ASA-CF, PA, PA-CF, PA-GF, PA6-CF, PC, PET-CF, PETG, PETG-CF, PLA, PLA-AERO, PLA-CF, PPA-CF, PPS-CF, PVA, TPU, TPU-AMS |
| QIDI | 55 | 818 | ABS, ABS-GF, ASA, ASA-AERO, ASA-CF, PA-S, PA12-CF, PA6-CF, PAHT-CF, PAHT-GF, PAHT-S, PC-ABS-FR, PEBA, PET-CF, PET-GF, PETG, PETG-CF, PETG-GF, PLA, PLA-CF, PPS-CF, PPS-GF, TPU, TPU-AERO, TPU-GF, UltraPA, UltraPA-CF25 |
| Polymaker | 151 | 697 | ABS, ASA, PA, PA-CF, PA-GF, PA6-CF, PET-CF, PETG, PETG-CF, PLA |
| Creality | 38 | 440 | ABS, ASA, PA, PA-CF, PC, PETG, PETG-CF, PETG-GF, PLA, PLA-CF, TPU |
| BETA | 88 | 400 | ABS, ASA, HIPS, PA-CF, PETG, PETG-CF, PLA, PLA-CF, TPU |
| Overture | 23 | 245 | ABS, ASA, PLA, TPU |
| Elegoo | 60 | 232 | ABS, ASA, PA, PC, PET-CF, PETG, PLA, TPU |
| COEX 3D | 28 | 187 | ABS, ASA, PA, PA-CF, PCTG, PETG, PLA, TPU |
| Snapmaker | 67 | 147 | ABS, ASA, Breakaway Support, PA-CF, PET, PETG, PETG-CF, PLA, PLA-CF, PVA, TPU |
| Prusa Polymers | 10 | 136 | ASA, PA, PA11-CF, PC, PC-CF, PETG, PLA, PVB |
| HATCHBOX | 3 | 84 | ABS, PETG, PLA |
| SUNLU | 14 | 62 | PETG, PLA |
| FilAr | 60 | 60 | PETG, PLA |
| addnorth | 54 | 54 | ABS, PA, PA-CF, PA6, PC, PETG, PETG-CF, PLA, PLA-CF, TPU |
| eSUN | 20 | 34 | ABS, ASA, PET, PETG, PLA, PLA-AERO, PLA-CF |
| Numakers | 2 | 19 | PLA |
| Eolas Prints | 18 | 18 | ABS, ASA, PETG, PLA, TPU |
| Aliz | 10 | 15 | PA-CF, PETG, PETG-CF, PLA |
| DREMC | 14 | 14 | ABS, ABS-GF, ASA, PA-CF, PA6-CF, PET-CF, PETG, PLA, PPA-CF, TPU |
| INSLOGIC | 4 | 12 | PA, PA-CF, PETG, PLA |
| JAYO | 3 | 12 | PETG, PLA |
| FusRock | 2 | 9 | ABS-GF |
| FILL3D | 7 | 7 | PA, PETG, PETG-CF, PLA, PP |
| FDplast | 6 | 6 | ABS, HIPS, PETG, PLA, SBS, TPU |
| Elas | 4 | 4 | ASA, PETG, PLA |
| Valment | 4 | 4 | PLA, PLA-CF |
| NIT | 3 | 3 | ABS, PETG, PLA |
| GreenGate3D | 1 | 1 | PETG |
| PlastAR | 1 | 1 | PLA |
| Printalot | 1 | 1 | ABS |
