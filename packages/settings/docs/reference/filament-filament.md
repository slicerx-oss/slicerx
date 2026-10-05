# Filament: Filament properties

10 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `default_filament_colour`

**Default filament color**

- Type: list of strings, one per extruder
- Default: [""]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_adhesiveness_category`

**Filament adhesiveness category**

- Type: list of integers, one per extruder
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_cost`

**Filament cost**

- Type: list of numbers, one per extruder
- Unit: money per kg
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_density`

**Filament density**

- Type: list of numbers, one per extruder
- Unit: g/cm3
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_diameter`

**Filament diameter**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [1.75]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_is_support`

**Filament is support**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_printable`

**Filament printable**

- Type: list of integers, one per extruder
- Default: [3]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_soluble`

**Filament soluble**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_type`

**Filament type**

- Type: list of strings, one per extruder
- Default: ["PLA"]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `required_nozzle_HRC`

**Required nozzle HRC**

- Type: list of integers, one per extruder
- Default: [0]
- Recommended range: 0 to 500
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
