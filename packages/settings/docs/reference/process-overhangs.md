# Process: Overhangs and bridges

29 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `bridge_angle`

**Bridge angle**

- Type: number
- Unit: degrees
- Default: 0
- Recommended range: 0 to 180
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `bridge_density`

**Bridge density**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 10 to 125
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `bridge_flow`

**Bridge flow ratio**

- Type: number
- Default: 1
- Recommended range: 0.5 to 1.5
- Orca limits: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `bridge_line_width`

**Bridge line width**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "100%"
- Recommended range: 0 to 100
- Tier: Expert, quality
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `bridge_no_support`

**Bridge no support**

- Type: boolean
- Default: off
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `bridge_speed`

**Bridge speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [25]
- Recommended range: 5 to 300
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `counterbore_hole_bridging`

**Bridge counterbore holes**

Bridges the step of a counterbore hole so it prints without supports. Partially bridge covers only part of the opening; sacrificial layer prints a full bridge layer you drill or cut out after printing.

- Type: enum
- Default: "none"
- Values: `none` (None), `partiallybridge` (Partially bridge), `sacrificiallayer` (Sacrificial layer)
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `detect_overhang_wall`

**Detect overhang wall**

- Type: boolean
- Default: on
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `enable_overhang_speed`

**Slow down on overhangs**

- Type: list of booleans, one per extruder
- Default: [false]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `extra_perimeters_on_overhangs`

**More walls under overhangs**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `make_overhang_printable`

**Make overhangs printable**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `make_overhang_printable_angle`

**Make overhang printable angle**

- Type: number
- Unit: degrees
- Default: 55
- Recommended range: 0 to 90
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `make_overhang_printable_hole_size`

**Make overhang printable hole size**

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `overhang_1_4_speed`

**Overhang 1 4 speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["0"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Slow down on overhangs (`enable_overhang_speed`) is on
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `overhang_2_4_speed`

**Overhang 2 4 speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["0"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Slow down on overhangs (`enable_overhang_speed`) is on
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `overhang_3_4_speed`

**Overhang 3 4 speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["0"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Slow down on overhangs (`enable_overhang_speed`) is on
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `overhang_4_4_speed`

**Overhang 4 4 speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["0"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Slow down on overhangs (`enable_overhang_speed`) is on
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `overhang_reverse`

**Overhang reverse**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `overhang_reverse_internal_only`

**Overhang reverse internal only**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `overhang_reverse_threshold`

**Overhang reverse threshold**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "50%"
- Recommended range: 0 to no maximum
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `thick_bridges`

**Thick bridges**

- Type: boolean
- Default: off
- Tier: Advanced, quality
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `wave_overhang_flow_mm3_per_mm`

**Wave overhang flow (mm3 per mm)**

- Type: number
- Default: 0.16
- Recommended range: 0.02 to 1.5
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wave_overhang_line_spacing`

**Wave overhang line spacing**

- Type: number
- Unit: mm
- Default: 0.35
- Recommended range: 0.05 to no maximum
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wave_overhang_max_iterations`

**Wave overhang maximum rings**

- Type: integer
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wave_overhang_min_length`

**Wave overhang minimum length**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wave_overhang_min_new_area`

**Wave overhang minimum new area (mm2)**

- Type: number
- Default: 0.01
- Recommended range: 0 to no maximum
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wave_overhang_perimeter_overlap`

**Wave overhang wall overlap**

- Type: number
- Unit: mm
- Default: 0.1
- Recommended range: 0 to no maximum
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wave_overhang_print_speed`

**Wave overhang speed**

- Type: number
- Unit: mm/s
- Default: 2
- Recommended range: 0.1 to no maximum
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wave_overhangs`

**Wave overhangs**

- Type: boolean
- Default: off
- Tier: Expert, effects
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)
