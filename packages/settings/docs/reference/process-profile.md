# Process: Profile metadata

8 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `compatible_printers`

**Compatible printers**

- Type: list of strings, one per extruder
- Default: empty list
- Tier: Hidden (profile key)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `compatible_printers_condition`

**Compatible printers condition**

- Type: string
- Default: empty
- Tier: Hidden (profile key)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `inherits`

**Inherits**

- Type: string
- Default: empty
- Tier: Hidden (profile key)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `plugins`

**Plugins**

- Type: list of strings, one per extruder
- Default: empty list
- Tier: Hidden (profile key)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `print_extruder_id`

**Print extruder id**

- Type: list of integers, one per extruder
- Default: [1]
- Tier: Hidden (profile key)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `print_extruder_variant`

**Print extruder variant**

- Type: list of strings, one per extruder
- Default: ["Direct Drive Standard"]
- Tier: Hidden (profile key)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `print_plugin_config_overrides`

**Plugin capabilities**

- Type: string
- Default: empty
- Tier: Hidden (profile key)
- Changing it redoes: G-code only
- mimir class: read (never written)

### `slicing_pipeline_plugin`

**Slicing pipeline plugin**

- Type: list of strings, one per extruder
- Default: empty list
- Tier: Hidden (profile key)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
