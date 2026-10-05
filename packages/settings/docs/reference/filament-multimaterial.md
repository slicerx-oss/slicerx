# Filament: Multi material

25 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `filament_change_length`

**Filament change length**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_change_length_nc`

**Filament change length nc**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_flush_volumetric_speed`

**Filament flush volumetric speed**

- Type: list of numbers, one per extruder
- Unit: mm3/s
- Default: [0]
- Recommended range: 0 to 200
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_loading_speed`

**Filament loading speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [28]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_loading_speed_start`

**Filament loading speed start**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [3]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_minimal_purge_on_wipe_tower`

**Filament minimal purge on wipe tower**

- Type: list of numbers, one per extruder
- Unit: mm3
- Default: [15]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_multitool_ramming`

**Filament multitool ramming**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_multitool_ramming_flow`

**Filament multitool ramming flow**

- Type: list of numbers, one per extruder
- Unit: mm3/s
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_multitool_ramming_volume`

**Filament multitool ramming volume**

- Type: list of numbers, one per extruder
- Unit: mm3
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_prime_volume`

**Filament prime volume**

- Type: list of numbers, one per extruder
- Unit: mm3
- Default: [45]
- Recommended range: 1 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_prime_volume_nc`

**Filament prime volume nc**

- Type: list of numbers, one per extruder
- Unit: mm3
- Default: [60]
- Recommended range: 1 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_ramming_parameters`

**Filament ramming parameters**

- Type: list of strings, one per extruder
- Default: ["120 100 6.6 6.8 7.2 7.6 7.9 8.2 8.7 9.4 9.9 10.0| 0.05 6.6 0.45 6.8 0.95 7.8 1.45 8.3...
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_ramming_travel_time`

**Filament ramming travel time**

- Type: list of numbers, one per extruder
- Unit: s
- Default: [0]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_ramming_travel_time_nc`

**Filament ramming travel time nc**

- Type: list of numbers, one per extruder
- Unit: s
- Default: [0]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_ramming_volumetric_speed`

**Filament ramming volumetric speed**

- Type: list of numbers, one per extruder
- Unit: mm3/s
- Default: [-1]
- Recommended range: -1 to 200
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_ramming_volumetric_speed_nc`

**Filament ramming volumetric speed nc**

- Type: list of numbers, one per extruder
- Unit: mm3/s
- Default: [-1]
- Recommended range: -1 to 200
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_stamping_distance`

**Filament stamping distance**

- Type: list of numbers, one per extruder
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_stamping_loading_speed`

**Filament stamping loading speed**

- Type: list of numbers, one per extruder
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_toolchange_delay`

**Filament toolchange delay**

- Type: list of numbers, one per extruder
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_interface_pre_extrusion_dist`

**Filament tower interface pre extrusion dist**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_interface_pre_extrusion_length`

**Filament tower interface pre extrusion length**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_interface_purge_volume`

**Filament tower interface purge volume**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [20]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_ironing_area`

**Filament tower ironing area**

- Type: list of numbers, one per extruder
- Default: [4]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_unloading_speed`

**Filament unloading speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [90]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_unloading_speed_start`

**Filament unloading speed start**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [100]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
