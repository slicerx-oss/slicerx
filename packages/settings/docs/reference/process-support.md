# Process: Support

39 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `combine_brims`

**Combine brims**

- Type: boolean
- Default: off
- Used only when: Brim type (`brim_type`) is not "no_brim"
- Tier: Expert, adhesion
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_support`

**Enable support**

- Type: boolean
- Default: off
- Tier: Simple, supports
- Changing it redoes: paths
- Easy mode: Set by the Supports control.
- mimir class: edit (may change in a plate override)
- Effect: higher: Supports are added under overhangs. lower: Overhangs print without support

### `enforce_support_layers`

**Enforce support layers** (develop mode)

- Type: integer
- Unit: layers
- Default: 0
- Recommended range: 0 to 5000
- Tier: Develop only
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `independent_support_layer_height`

**Separate support layer height**

- Type: boolean
- Default: on
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `max_bridge_length`

**Max bridge length**

- Type: number
- Unit: mm
- Default: 10
- Recommended range: 0 to no maximum
- Tier: Expert, supports
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_angle`

**Support angle**

- Type: number
- Unit: degrees
- Default: 0
- Recommended range: 0 to 359
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_base_pattern`

**Support base pattern**

The pattern inside the support. Lightning grows thin branches that hold up only what needs it, inside slim, strong and hybrid tree supports; other supports print it as rectilinear. Hollow prints tree branches as walls only.

- Type: enum
- Default: "default"
- Values: `default` (Default), `rectilinear` (Rectilinear), `rectilinear-grid` (Rectilinear grid), `honeycomb` (Honeycomb), `lightning` (Lightning), `hollow` (Hollow)
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_base_pattern_spacing`

**Support base pattern spacing**

- Type: number
- Unit: mm
- Default: 2.5
- Recommended range: 0 to no maximum
- Used only when: Enable support (`enable_support`) is on
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_bottom_interface_spacing`

**Support bottom interface spacing**

- Type: number
- Unit: mm
- Default: 0.5
- Recommended range: 0 to no maximum
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_bottom_z_distance`

**Support bottom z distance**

- Type: number
- Unit: mm
- Default: 0.2
- Recommended range: 0 to no maximum
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_critical_regions_only`

**Support critical areas only**

- Type: boolean
- Default: off
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_expansion`

**Support expansion**

- Type: number
- Unit: mm
- Default: 0
- Used only when: Enable support (`enable_support`) is on
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_interface_bottom_layers`

**Support interface bottom layers**

- Type: integer
- Unit: layers
- Default: 0
- Recommended range: -1 to no maximum
- Values: `-1`
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_interface_loop_pattern`

**Support interface loop pattern**

- Type: boolean
- Default: off
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_interface_not_for_body`

**Support interface not for body**

- Type: boolean
- Default: on
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_interface_pattern`

**Support interface pattern**

- Type: enum
- Default: "auto"
- Values: `auto` (Default), `rectilinear` (Rectilinear), `concentric` (Concentric), `rectilinear_interlaced` (Rectilinear interlaced), `grid` (Grid)
- Used only when: Enable support (`enable_support`) is on; and Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_interface_spacing`

**Support interface spacing**

- Type: number
- Unit: mm
- Default: 0.5
- Recommended range: 0 to no maximum
- Used only when: Enable support (`enable_support`) is on; and Enable support (`enable_support`) is on
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `support_interface_top_layers`

**Interface layers under the part**

- Type: integer
- Unit: layers
- Default: 3
- Recommended range: 0 to 10
- Orca limits: 0 to none
- Values: `0`, `1`, `2`, `3`
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `support_object_first_layer_gap`

**Support object first layer gap**

- Type: number
- Unit: mm
- Default: 0.2
- Recommended range: 0 to 10
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_object_xy_distance`

**Support XY distance**

- Type: number
- Unit: mm
- Default: 0.35
- Recommended range: 0 to 5
- Orca limits: 0 to 10
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `support_on_build_plate_only`

**Only support from the bed**

- Type: boolean
- Default: off
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- Easy mode: Set by the Supports control.
- mimir class: edit (may change in a plate override)

### `support_remove_small_overhang`

**Support remove small overhang**

- Type: boolean
- Default: on
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_style`

**Support style**

- Type: enum
- Default: "default"
- Values: `default` (Default (grid or organic)), `grid` (Grid), `snug` (Snug), `organic` (Organic), `tree_slim` (Tree slim), `tree_strong` (Tree strong), `tree_hybrid` (Tree hybrid)
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `support_threshold_angle`

**Support threshold angle**

- Type: integer
- Unit: degrees
- Default: 30
- Recommended range: 0 to 90
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "normal(auto)", "tree(auto)"
- Tier: Advanced, supports
- Changing it redoes: paths
- Easy mode: Set by the Supports control.
- mimir class: edit (may change in a plate override)
- Effect: higher: Support is added for more gentle overhangs. lower: Support is limited to steeper overhangs

### `support_threshold_overlap`

**Support threshold overlap**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "50%"
- Recommended range: 0 to 100
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "normal(auto)", "tree(auto)"; and Support threshold angle (`support_threshold_angle`) is 0
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_top_z_distance`

**Vertical gap between support and part**

- Type: number
- Unit: mm
- Default: 0.2
- Recommended range: 0 to 1
- Orca limits: 0 to none
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)
- Effect: higher: Support separates more easily and leaves a rougher underside. lower: Support bonds tighter and leaves a smoother underside

### `support_type`

**Support type**

- Type: enum
- Default: "normal(auto)"
- Values: `normal(auto)` (Normal (auto)), `tree(auto)` (Tree (auto)), `normal(manual)` (Normal (manual)), `tree(manual)` (Tree (manual))
- Used only when: Enable support (`enable_support`) is on
- Tier: Advanced, supports
- Changing it redoes: paths
- Easy mode: Set by the Supports control. Organic tree supports. Painted keeps only the supports the user paints. Style and threshold are Advanced settings.
- mimir class: edit (may change in a plate override)

### `tree_support_angle_slow`

**Tree support angle slow**

- Type: number
- Unit: degrees
- Default: 25
- Recommended range: 10 to 85
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_branch_angle`

**Tree branch lean angle**

- Type: number
- Unit: degrees
- Default: 40
- Recommended range: 0 to 60
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_branch_angle_organic`

**Tree support branch angle organic**

- Type: number
- Unit: degrees
- Default: 40
- Recommended range: 0 to 60
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_branch_diameter`

**Tree branch thickness**

- Type: number
- Unit: mm
- Default: 5
- Recommended range: 1 to 10
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_branch_diameter_angle`

**Tree support branch diameter angle**

- Type: number
- Unit: degrees
- Default: 5
- Recommended range: 0 to 15
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_branch_diameter_organic`

**Tree support branch diameter organic**

- Type: number
- Unit: mm
- Default: 2
- Recommended range: 1 to 10
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_branch_distance`

**Distance between tree branches**

- Type: number
- Unit: mm
- Default: 5
- Recommended range: 1 to 10
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_branch_distance_organic`

**Tree support branch distance organic**

- Type: number
- Unit: mm
- Default: 1
- Recommended range: 1 to 10
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_tip_diameter`

**Tree support tip diameter**

- Type: number
- Unit: mm
- Default: 0.8
- Recommended range: 0.1 to 100
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_top_rate`

**Tree support top rate**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 30
- Recommended range: 5 to no maximum
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_wall_count`

**Tree support wall count**

- Type: integer
- Default: 0
- Recommended range: 0 to 2
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"
- Tier: Advanced, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_with_infill`

**Tree support infill**

Fills large hollow areas inside tree supports with infill.

- Type: boolean
- Default: off
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)
