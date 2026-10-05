# Filament: G-code

3 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `filament_change_extrusion_role_gcode`

**G-code on feature change**

G-code for this filament, written each time the print moves to another feature, after the printer's own. It can read extrusion_role, last_extrusion_role, layer_num and layer_z.

- Type: list of strings, one per extruder
- Default: [""]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_end_gcode`

**Filament end gcode**

- Type: list of strings, one per extruder
- Default: [" "]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_start_gcode`

**Filament start gcode**

- Type: list of strings, one per extruder
- Default: [" "]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
