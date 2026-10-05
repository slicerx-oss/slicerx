# Process: G-code

8 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `exclude_object`

**Exclude object**

- Type: boolean
- Default: off
- Tier: Expert, output
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filename_format`

**Filename format**

The name of the exported G-code file. Placeholders in braces fill in when slicing ends, such as {input_filename_base}, {plate_name}, {plate_number}, {print_time}, {total_weight}, {timestamp} and any setting (for example {filament_type[initial_tool]}). Characters a file name cannot hold become _.

- Type: string
- Default: "{input_filename_base}_{filament_type[initial_tool]}_{print_time}.gcode"
- Tier: Expert, output
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `gcode_add_line_number`

**Add line numbers**

Puts N1, N2 and so on in front of every G-code command, for printers and hosts that check line numbers. Comments are not numbered, and binary G-code gets none.

- Type: boolean
- Default: off
- Tier: Expert, output
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `gcode_comments`

**Gcode comments**

- Type: boolean
- Default: off
- Tier: Expert, output
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `gcode_label_objects`

**Gcode label objects**

- Type: boolean
- Default: off
- Tier: Expert, output
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `notes`

**Notes**

Your own notes about this process profile. They are written as comments at the top of the G-code.

- Type: string
- Default: empty
- Tier: Expert, output
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `post_process`

**Post process**

- Type: list of strings, one per extruder
- Default: empty list
- Tier: Expert, output
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `process_change_extrusion_role_gcode`

**G-code on feature change**

G-code written each time the print moves to another feature, such as outer wall, sparse infill or support, after the printer's and the filament's own. It can read extrusion_role, last_extrusion_role, layer_num and layer_z.

- Type: G-code text
- Default: empty
- Tier: Expert, output
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
