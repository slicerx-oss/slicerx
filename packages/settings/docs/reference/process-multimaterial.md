# Process: Multi material

42 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `bottom_surface_filament_id`

**Bottom surface filament id**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_prime_tower`

**Prime tower**

- Type: boolean
- Default: off
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)
- Effect: higher: A prime tower cleans the nozzle between colors and uses more filament. lower: Without a prime tower colors may bleed

### `enable_tower_interface_cooldown_during_tower`

**Enable tower interface cooldown during tower**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `enable_tower_interface_features`

**Prime tower interface options**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `flush_into_infill`

**Flush into infill**

- Type: boolean
- Default: off
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `flush_into_objects`

**Flush into objects**

- Type: boolean
- Default: off
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `flush_into_support`

**Flush into support**

- Type: boolean
- Default: on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `inner_wall_filament_id`

**Inner wall filament id**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `internal_solid_filament_id`

**Internal solid filament id**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `ooze_prevention`

**Ooze prevention**

- Type: boolean
- Default: off
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `outer_wall_filament_id`

**Outer wall filament id**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `prime_tower_auto_position`

**Place prime tower automatically**

Puts the prime tower on a free spot next to the objects, clear of the printer's no-go areas, and widens it when nothing else fits. Turn off to keep the tower where you put it.

- Type: boolean
- Default: on
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `prime_tower_brim_width`

**Prime tower brim width**

- Type: number
- Unit: mm
- Default: 3
- Recommended range: -1 to no maximum
- Values: `-1`
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `prime_tower_enable_framework`

**Prime tower enable framework**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `prime_tower_flat_ironing`

**Iron the prime tower flat**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `prime_tower_infill_gap`

**Prime tower infill gap**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 150
- Recommended range: 100 to no maximum
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `prime_tower_skip_points`

**Prime tower skip points**

- Type: boolean
- Default: on
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `prime_tower_width`

**Prime tower width**

- Type: number
- Unit: mm
- Default: 60
- Recommended range: 2 to no maximum
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `prime_volume`

**Prime volume**

- Type: number
- Unit: mm3
- Default: 45
- Recommended range: 1 to no maximum
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Hidden (profile key)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `single_extruder_multi_material_priming`

**Single extruder multi material priming**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `sparse_infill_filament_id`

**Sparse infill filament id**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `standby_temperature_delta`

**Standby temperature delta**

- Type: integer
- Unit: C (difference)
- Default: -5
- Recommended range: -1500 to 1500
- Used only when: Ooze prevention (`ooze_prevention`) is on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_filament`

**Support filament**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_interface_filament`

**Support interface filament**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `toolchange_cyclic_first_layer`

**Toolchange cyclic first layer**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `toolchange_cyclic_order`

**Toolchange cyclic order**

- Type: string
- Default: empty
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `toolchange_ordering`

**Toolchange ordering**

- Type: enum
- Default: "default"
- Values: `default` (Default), `cyclic` (Cyclic)
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `top_surface_filament_id`

**Top surface filament id**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wipe_tower_bridging`

**Wipe tower bridging**

- Type: number
- Unit: mm
- Default: 10
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_cone_angle`

**Wipe tower cone angle**

- Type: number
- Unit: degrees
- Default: 30
- Recommended range: 0 to 90
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_extra_flow`

**Wipe tower extra flow**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 100 to 300
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wipe_tower_extra_rib_length`

**Wipe tower extra rib length**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: no minimum to 300
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_extra_spacing`

**Wipe tower extra spacing**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 100 to 300
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_filament`

**Wipe tower filament**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_fillet_wall`

**Wipe tower fillet wall**

- Type: boolean
- Default: on
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_max_purge_speed`

**Wipe tower max purge speed**

- Type: number
- Unit: mm/s
- Default: 90
- Recommended range: 10 to no maximum
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wipe_tower_no_sparse_layers`

**Wipe tower no sparse layers**

- Type: boolean
- Default: off
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_rib_width`

**Wipe tower rib width**

- Type: number
- Unit: mm
- Default: 8
- Recommended range: 0 to 300
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_rotation_angle`

**Rotation of the wipe tower**

- Type: number
- Unit: degrees
- Default: 0
- Used only when: Prime tower (`enable_prime_tower`) is on
- Tier: Advanced, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_sparse_layers_combination`

**Wipe tower sparse layers combination**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_tower_wall_type`

**Wipe tower wall type**

- Type: enum
- Default: "rectangle"
- Values: `rectangle` (Rectangle), `cone` (Cone), `rib` (Rib)
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wiping_volumes_extruders`

**Wiping volumes extruders**

- Type: list of numbers, one per extruder
- Default: [70,70,70,70,70,70,70,70,70,70]
- Tier: Hidden (profile key)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
