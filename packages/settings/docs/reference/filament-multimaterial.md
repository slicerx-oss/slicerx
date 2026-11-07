# Filament: Multi material

25 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `filament_change_length`

**Filament change length**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `filament_change_length_nc`

**Filament change length on a nozzle change**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: paths
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

**Filament loading speed at the start**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [3]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_minimal_purge_on_wipe_tower`

**Smallest purge on the prime tower**

- Type: list of numbers, one per extruder
- Unit: mm3
- Default: [15]
- Recommended range: 0 to no maximum
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `filament_multitool_ramming`

**Ramming before a tool change**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `filament_multitool_ramming_flow`

**Ramming flow before a tool change**

- Type: list of numbers, one per extruder
- Unit: mm3/s
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_multitool_ramming_volume`

**Ramming volume before a tool change**

- Type: list of numbers, one per extruder
- Unit: mm3
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: paths
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

**Filament prime volume on a nozzle change**

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

**Filament ramming travel time on a nozzle change**

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

**Filament ramming speed on a nozzle change**

- Type: list of numbers, one per extruder
- Unit: mm3/s
- Default: [-1]
- Recommended range: -1 to 200
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_stamping_distance`

**Push-in distance between cooling moves**

- Type: list of numbers, one per extruder
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_stamping_loading_speed`

**Push-in speed between cooling moves**

- Type: list of numbers, one per extruder
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_toolchange_delay`

**Wait after unloading**

- Type: list of numbers, one per extruder
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_interface_pre_extrusion_dist`

**Prime tower pre-extrusion distance between materials**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_interface_pre_extrusion_length`

**Prime tower pre-extrusion length between materials**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_interface_purge_volume`

**Prime tower purge length between materials**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [20]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_ironing_area`

**Prime tower ironing area between materials**

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

**Filament unloading speed at the start**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [100]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
