### Fixed

- `slicerx_project_add_filament` 1.2.1 (from 1.2.0, in the server and the mimir tab): a color is refused as one the project already has in that material when the two look the same, judged by CIEDE2000 (sRGB, D65) under 6, instead of under 40 apart in RGB. A near-black beside black (#1a1a1a and #000000) and a light gray beside white (#e6e6e6 and #ffffff) are now refused, as off-whites and close buffs already were; a dark gray (#333333), silver (#cccccc) and two distinct reds (#a82a22 and #c8102e) are still added. The refusal's words are unchanged.
