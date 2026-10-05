# Printer: Profile metadata

12 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `default_filament_profile`

**Default filament profile**

- Type: list of strings, one per extruder
- Default: empty list
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `default_print_profile`

**Default print profile**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `extruder_variant_list`

**Extruder variant list**

- Type: list of strings, one per extruder
- Default: ["Direct Drive Standard"]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `printer_extruder_id`

**Printer extruder id**

- Type: list of integers, one per extruder
- Default: [1]
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_extruder_variant`

**Printer extruder variant**

- Type: list of strings, one per extruder
- Default: ["Direct Drive Standard"]
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_model`

**Printer model**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_notes`

**Printer notes**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_structure`

**Printer structure**

- Type: enum
- Default: "undefine"
- Values: `undefine` (Not set), `corexy` (CoreXY), `i3` (Bed slinger (i3)), `hbot` (H-bot), `delta` (Delta)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_technology`

**Printer technology**

- Type: enum
- Default: "FFF"
- Values: `FFF`, `SLA`
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_variant`

**Printer variant**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `upward_compatible_machine`

**Upward compatible machine**

- Type: list of strings, one per extruder
- Default: empty list
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `use_3mf`

**Use 3mf**

- Type: boolean
- Default: off
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)
