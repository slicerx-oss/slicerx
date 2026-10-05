# Printer: G-code

16 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `before_layer_change_gcode`

**Before layer change gcode**

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `change_extrusion_role_gcode`

**G-code on feature change**

G-code written each time the print moves to another feature, such as outer wall, sparse infill or support. It can read extrusion_role, last_extrusion_role, layer_num and layer_z.

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `change_filament_gcode`

**Change filament gcode**

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `emit_machine_limits_to_gcode`

**Emit machine limits to gcode**

- Type: boolean
- Default: on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_start_gcode`

**Tool start G-code**

G-code written right after the printer selects a tool, at the start and at every tool change. current_extruder is the tool just selected.

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `file_start_gcode`

**File start gcode**

G-code at the very top of the file, before the header. Use it for lines a printer or host reads first.

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `layer_change_gcode`

**Layer change gcode**

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_end_gcode`

**Machine end gcode**

- Type: G-code text
- Default: "M104 S0 ; turn off temperature\nG28 X0  ; home X axis\nM84     ; disable motors\n"
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_pause_gcode`

**Machine pause gcode**

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_start_gcode`

**Machine start gcode**

- Type: G-code text
- Default: "G28 ; home all axes\nG1 Z5 F5000 ; lift nozzle\n"
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `printing_by_object_gcode`

**Printing by object gcode**

G-code run before each object after the first when printing by object, over the next object before the nozzle comes down. {current_object_idx} is the object's place in the plate list.

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `template_custom_gcode`

**Template custom gcode**

- Type: G-code text
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `thumbnails`

**Thumbnails**

- Type: list of strings, one per extruder
- Default: ["48x48/PNG","300x300/PNG"]
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `thumbnails_format`

**Thumbnails format**

- Type: enum
- Default: "PNG"
- Values: `PNG`, `JPG`, `QOI`, `BTT_TFT` (BTT TFT), `COLPIC` (ColPic)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `time_lapse_gcode`

**Time lapse gcode**

G-code for a timelapse frame on every layer. Most printers run it right after the layer change. Bambu Lab printers run it at the start of the layer, or on bed slingers once the walls of the first part with infill are done, and wrap it in the layer's object mask so skipped objects skip it too.

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wrapping_detection_gcode`

**Wrapping detection gcode**

G-code for the printer's filament wrapping check, run on every layer before its first filament when wrapping detection is on.

- Type: G-code text
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
