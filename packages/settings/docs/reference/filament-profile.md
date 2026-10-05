# Filament: Profile metadata

7 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `compatible_prints`

**Compatible prints**

- Type: list of strings, one per extruder
- Default: empty list
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `compatible_prints_condition`

**Compatible prints condition**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `filament_extruder_compatibility`

**Filament extruder compatibility**

- Type: list of integers, one per extruder
- Default: [0]
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `filament_extruder_variant`

**Filament extruder variant**

- Type: list of strings, one per extruder
- Default: ["Direct Drive Standard"]
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `filament_notes`

**Filament notes**

- Type: list of strings, one per extruder
- Default: [""]
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `filament_plugin_config_overrides`

**Plugin capabilities**

- Type: string
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (never written)

### `filament_vendor`

**Filament vendor**

- Type: list of strings, one per extruder
- Default: ["(Undefined)"]
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)
