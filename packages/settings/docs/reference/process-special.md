# Process: Special modes

24 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `calib_flowrate_topinfill_special_order`

**Special top infill order for flow tests** (develop mode)

- Type: boolean
- Default: off
- Tier: Develop only
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_wrapping_detection`

**Enable wrapping detection**

Runs the wrapping detection G-code on every layer, on printers that can detect filament wrapping around the nozzle.

- Type: boolean
- Default: off
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin`

**Fuzzy skin**

- Type: enum
- Default: "disabled_fuzzy"
- Values: `none` (Painted only), `external` (Contour), `hole` (Hole), `all` (Contour and hole), `allwalls` (All walls), `disabled_fuzzy` (Disabled)
- Tier: Advanced, effects
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)
- Effect: higher: Fuzzy skin roughens the outer wall for grip and hides layer lines. lower: Smooth outer walls

### `fuzzy_skin_first_layer`

**Fuzzy skin first layer**

- Type: boolean
- Default: off
- Used only when: Fuzzy skin (`fuzzy_skin`) is not "none"
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_layers_between_ripple_offset`

**Fuzzy skin layers between ripple offset**

- Type: integer
- Default: 1
- Recommended range: 1 to no maximum
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_mode`

**Fuzzy skin mode**

- Type: enum
- Default: "displacement"
- Values: `displacement` (Displacement), `extrusion` (Extrusion), `combined` (Combined)
- Used only when: Fuzzy skin (`fuzzy_skin`) is not "none"
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_noise_type`

**Fuzzy skin noise shape**

- Type: enum
- Default: "classic"
- Values: `classic` (Classic), `perlin` (Perlin), `billow` (Billow), `ridgedmulti` (Ridged multifractal), `voronoi` (Voronoi), `ripple` (Ripple)
- Used only when: Fuzzy skin (`fuzzy_skin`) is not "none"
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_octaves`

**Fuzzy skin octaves**

- Type: integer
- Default: 4
- Recommended range: 1 to 10
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_persistence`

**Fuzzy skin persistence**

- Type: number
- Default: 0.5
- Recommended range: 0.01 to 1
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_point_distance`

**Distance between fuzzy skin points**

- Type: number
- Unit: mm
- Default: 0.3
- Recommended range: 0.01 to 5
- Used only when: Fuzzy skin (`fuzzy_skin`) is not "none"
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_ripple_offset`

**Fuzzy skin ripple offset**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 50
- Recommended range: 0 to 100
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_ripples_per_layer`

**Fuzzy skin ripples per layer**

- Type: integer
- Default: 15
- Recommended range: 1 to no maximum
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_scale`

**Fuzzy skin scale**

- Type: number
- Unit: mm
- Default: 1
- Recommended range: 0.1 to 500
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `fuzzy_skin_thickness`

**Fuzzy skin thickness**

- Type: number
- Unit: mm
- Default: 0.2
- Recommended range: 0 to 2
- Used only when: Fuzzy skin (`fuzzy_skin`) is not "none"
- Tier: Advanced, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `preheat_steps`

**Preheat steps** (develop mode)

- Type: integer
- Default: 1
- Recommended range: 1 to 10
- Tier: Develop only
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `preheat_time`

**Preheat time**

- Type: number
- Default: 30
- Recommended range: 0 to 120
- Tier: Expert, effects
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `print_order`

**Print order**

- Type: enum
- Default: "default"
- Values: `default` (Default), `as_obj_list` (As object list)
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `print_sequence`

**Print sequence**

- Type: enum
- Default: "by layer"
- Values: `by layer` (By layer), `by object` (By object)
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `spiral_finishing_flow_ratio`

**Flow ratio at the end of a vase**

- Type: number
- Default: 0
- Recommended range: 0 to 1
- Used only when: Spiral vase (`spiral_mode`) is on
- Tier: Expert, effects
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `spiral_mode`

**Spiral vase**

- Type: boolean
- Default: off
- Tier: Advanced, effects
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)
- Effect: higher: Vase mode prints one continuous outer wall with no infill. lower: Normal layered printing

### `spiral_mode_max_xy_smoothing`

**Spiral mode max xy smoothing**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "200%"
- Recommended range: 0 to 1000
- Used only when: Spiral vase (`spiral_mode`) is on
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `spiral_mode_smooth`

**Smooth spiral**

- Type: boolean
- Default: off
- Used only when: Spiral vase (`spiral_mode`) is on
- Tier: Expert, effects
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `spiral_starting_flow_ratio`

**Flow ratio at the start of a vase**

- Type: number
- Default: 0
- Recommended range: 0 to 1
- Used only when: Spiral vase (`spiral_mode`) is on
- Tier: Expert, effects
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `timelapse_type`

**Timelapse**

- Type: enum
- Default: "0"
- Values: `0` (Traditional), `1` (Smooth)
- Tier: Expert, effects
- Changing it redoes: preview only
- mimir class: edit (may change in a plate override)
