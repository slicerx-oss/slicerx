# Process: Strength: walls, shells and infill

58 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `align_infill_direction_to_model`

**Turn infill with the model**

Turns the infill and the fixed bridge angles with the model when you rotate it on the plate, so the lines keep the same direction on the part.

- Type: boolean
- Default: off
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `alternate_extra_wall`

**Alternate extra wall**

- Type: boolean
- Default: off
- Tier: Advanced, strength
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `bottom_layer_direction`

**Bottom layer direction**

- Type: number
- Unit: degrees
- Default: -1
- Recommended range: -1 to 360
- Used only when: Bottom shell layers (`bottom_shell_layers`) is above 0
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `bottom_shell_layers`

**Bottom shell layers**

- Type: integer
- Unit: layers
- Default: 3
- Recommended range: 0 to 50
- Orca limits: 0 to none
- Tier: Expert, strength
- Changing it redoes: surfaces
- Easy mode: Set by the Detail control. Derived: ceil(bottom shell thickness / layer height).
- mimir class: edit (may change in a plate override)
- Effect: higher: Thicker bottom skin adds strength and time. lower: Thinner bottom skin saves time

### `bottom_shell_thickness`

**Bottom shell thickness**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to 10
- Orca limits: 0 to none
- Used only when: Spiral vase (`spiral_mode`) is off; and Bottom shell layers (`bottom_shell_layers`) is above 0
- Tier: Advanced, strength
- Changing it redoes: surfaces
- Easy mode: Set by the Detail control. Bottom skin in mm. The layer count is derived from it.
- mimir class: edit (may change in a plate override)

### `bottom_surface_density`

**Bottom surface density**

How densely the bottom surface is filled, in percent. 100 % gives a solid bottom; lower values space the lines out and save filament.

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 10 to 100
- Used only when: Bottom shell layers (`bottom_shell_layers`) is above 0
- Tier: Advanced, strength
- Changing it redoes: surfaces
- mimir class: read (not in the catalog: never written)

### `bottom_surface_fill_order`

**Order of bottom surface fill**

- Type: enum
- Default: "default"
- Values: `default` (Default), `outward` (Outward), `inward` (Inward)
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `bottom_surface_pattern`

**Bottom surface pattern**

- Type: enum
- Default: "monotonic"
- Values: `monotonic` (Monotonic), `monotonicline` (Monotonic line), `rectilinear` (Rectilinear), `alignedrectilinear` (Aligned rectilinear), `concentric` (Concentric), `hilbertcurve` (Hilbert curve), `archimedeanchords` (Archimedean chords), `octagramspiral` (Octagram spiral)
- Used only when: Bottom shell layers (`bottom_shell_layers`) is above 0
- Tier: Advanced, quality
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `center_of_surface_pattern`

**Center of surface pattern**

- Type: enum
- Default: "each_surface"
- Values: `each_surface` (Each surface), `each_model` (Each object), `each_assembly` (Each assembly)
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `detect_narrow_internal_solid_infill`

**Detect narrow internal solid infill**

- Type: boolean
- Default: on
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `ensure_vertical_shell_thickness`

**Keep shells thick on steep sides**

- Type: enum
- Default: "ensure_all"
- Values: `none` (None), `ensure_critical_only` (Critical only), `ensure_moderate` (Moderate), `ensure_all` (All)
- Tier: Expert, strength
- Changing it redoes: surfaces
- mimir class: edit (may change in a plate override)

### `extra_solid_infills`

**Extra solid infill layers**

Layers whose sparse infill prints solid, to stiffen tall parts. List layer numbers like 1,7,9. 5 makes every fifth layer solid, and 5#2 makes two layers solid every fifth layer. Leave empty for none.

- Type: string
- Default: empty
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fill_multiline`

**Fill multiline**

- Type: integer
- Default: 1
- Recommended range: 1 to 10
- Used only when: Infill density (`sparse_infill_density`) is above 0
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `gap_fill_target`

**Gap fill target**

- Type: enum
- Default: "nowhere"
- Values: `everywhere` (Everywhere), `topbottom` (Top and bottom surfaces), `nowhere` (Nowhere)
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `gyroid_optimized`

**Stronger gyroid along Z**

Shortens the gyroid's waves along the height at low densities (below about 30 %), so the infill resists crushing from above better at about the same filament.

- Type: boolean
- Default: off
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `infill_anchor`

**Infill anchor**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "400%"
- Values: `0`, `1`, `2`, `5`, `10`, `1000`
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `infill_anchor_max`

**Infill anchor max**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Default: "20"
- Used only when: Infill density (`sparse_infill_density`) is above 0; and Infill pattern (`sparse_infill_pattern`) is not "line"
- Tier: Advanced, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `infill_combination`

**Combine infill layers**

Prints the sparse infill once every few layers, as one thicker layer, to save time. Layers combine up to the nozzle diameter or the combined infill maximum height; with sleipnir's variable layers, up to 0.75 of the nozzle.

- Type: boolean
- Default: off
- Used only when: Infill density (`sparse_infill_density`) is above 0
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: edit (may change in a plate override)

### `infill_combination_max_layer_height`

**Combined infill maximum height**

The tallest combined sparse infill layer, in mm or as a percent of the nozzle diameter. 100 % lets the infill reach the nozzle diameter.

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "100%"
- Recommended range: 0 to no maximum
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `infill_direction`

**Infill direction**

- Type: number
- Unit: degrees
- Default: 45
- Recommended range: 0 to 360
- Used only when: Infill density (`sparse_infill_density`) is above 0
- Tier: Advanced, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `infill_lock_depth`

**Infill lock depth**

- Type: number
- Unit: mm
- Default: 1
- Recommended range: 0 to 100
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `infill_overhang_angle`

**Infill overhang angle**

- Type: number
- Unit: degrees
- Default: 60
- Recommended range: 15 to 75
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `infill_shift_step`

**Infill shift step**

- Type: number
- Unit: mm
- Default: 0.4
- Recommended range: 0 to 10
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `infill_wall_overlap`

**Overlap between infill and walls**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 15
- Recommended range: 0 to 100
- Orca limits: none to none
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: edit (may change in a plate override)

### `interface_shells`

**Interface shells**

On parts printed in more than one filament, gives each filament region its own solid top and bottom shells where it meets another filament. Off lets the infill run across the border.

- Type: boolean
- Default: off
- Tier: Expert, strength
- Changing it redoes: surfaces
- mimir class: edit (may change in a plate override)

### `internal_bridge_angle`

**Internal bridge angle**

- Type: number
- Unit: degrees
- Default: 0
- Recommended range: 0 to 180
- Tier: Expert, strength
- Changing it redoes: surfaces
- mimir class: read (not in the catalog: never written)

### `internal_bridge_density`

**Internal bridge density**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 10 to 125
- Tier: Expert, strength
- Changing it redoes: surfaces
- mimir class: read (not in the catalog: never written)

### `internal_solid_infill_pattern`

**Pattern of internal solid infill**

- Type: enum
- Default: "monotonic"
- Values: `monotonic` (Monotonic), `monotonicline` (Monotonic line), `rectilinear` (Rectilinear), `alignedrectilinear` (Aligned rectilinear), `concentric` (Concentric), `hilbertcurve` (Hilbert curve), `archimedeanchords` (Archimedean chords), `octagramspiral` (Octagram spiral)
- Tier: Advanced, quality
- Changing it redoes: infill
- mimir class: edit (may change in a plate override)

### `lateral_lattice_angle_1`

**First lattice angle**

- Type: number
- Unit: degrees
- Default: -45
- Recommended range: -75 to 75
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `lateral_lattice_angle_2`

**Second lattice angle**

- Type: number
- Unit: degrees
- Default: 45
- Recommended range: -75 to 75
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `lightning_overhang_angle`

**Lightning overhang angle**

- Type: number
- Unit: degrees
- Default: 45
- Recommended range: 5 to 85
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `lightning_prune_angle`

**Lightning prune angle**

- Type: number
- Unit: degrees
- Default: 45
- Recommended range: 5 to 85
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `lightning_straightening_angle`

**Lightning straightening angle**

- Type: number
- Unit: degrees
- Default: 45
- Recommended range: 5 to 85
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `minimum_sparse_infill_area`

**Minimum sparse infill area**

- Type: number
- Default: 15
- Recommended range: 0 to no maximum
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `relative_bridge_angle`

**Relative bridge angle**

- Type: boolean
- Default: off
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `separated_infills`

**Separated infills**

- Type: boolean
- Default: off
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `skeleton_infill_density`

**Skeleton infill density**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 25
- Recommended range: 0 to 100
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `skeleton_infill_line_width`

**Skeleton infill line width**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "100%"
- Recommended range: 0 to no maximum
- Tier: Expert, strength
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `skin_infill_density`

**Skin infill density**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 25
- Recommended range: 0 to 100
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `skin_infill_depth`

**Skin infill depth**

- Type: number
- Unit: mm
- Default: 2
- Recommended range: 0 to 100
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `skin_infill_line_width`

**Skin infill line width**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "100%"
- Recommended range: 0 to no maximum
- Tier: Expert, strength
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `solid_infill_direction`

**Solid infill direction**

- Type: number
- Unit: degrees
- Default: 45
- Recommended range: 0 to 360
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `solid_infill_rotate_template`

**Solid infill angle template**

Angles for the top, bottom and internal solid infill lines, layer by layer, in degrees, such as 0,90. Bridges keep their own angle. Leave empty to use the solid infill direction.

- Type: string
- Unit: degrees
- Default: empty
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `sparse_infill_density`

**Infill density**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 20
- Recommended range: 0 to 100
- Tier: Simple, strength
- Changing it redoes: infill
- Easy mode: Set by the Strength control.
- mimir class: edit (may change in a plate override)
- Effect: higher: Denser infill adds strength, filament and time. lower: Sparser infill saves filament and time but weakens the part

### `sparse_infill_pattern`

**Infill pattern**

- Type: enum
- Default: "gyroid"
- Values: `rectilinear` (Rectilinear), `alignedrectilinear` (Aligned rectilinear), `zigzag` (Zig zag), `crosszag` (Cross zag), `lockedzag` (Locked zag), `line` (Line), `grid` (Grid), `triangles` (Triangles), `tri-hexagon` (Tri-hexagon), `cubic` (Cubic), `adaptivecubic` (Adaptive cubic), `quartercubic` (Quarter cubic), `supportcubic` (Support cubic), `lightning` (Lightning), `honeycomb` (Honeycomb), `3dhoneycomb` (3D honeycomb), `lateral-honeycomb` (Lateral honeycomb), `lateral-lattice` (Lateral lattice), `crosshatch` (Cross hatch), `tpmsd` (TPMS-D), `tpmsfk` (TPMS-FK), `gyroid` (Gyroid), `concentric` (Concentric), `hilbertcurve` (Hilbert curve), `archimedeanchords` (Archimedean chords), `octagramspiral` (Octagram spiral)
- Used only when: Infill density (`sparse_infill_density`) is above 0
- Tier: Advanced, strength
- Changing it redoes: infill
- Easy mode: Set by the Strength control. Gyroid is the default infill: even strength in every direction and no seams between layers.
- mimir class: edit (may change in a plate override)

### `sparse_infill_rotate_template`

**Sparse infill angle template**

Angles for the sparse infill lines, layer by layer, in degrees. 0,90 alternates two directions and 0,60,120 cycles three. +5 turns the lines 5 degrees more every layer, +5#5 every five layers. Leave empty to use the infill direction.

- Type: string
- Unit: degrees
- Default: empty
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `sparse_infill_smooth_factor`

**Smoothing of sparse infill**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 0
- Recommended range: 0 to 100
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `symmetric_infill_y_axis`

**Mirror infill across the Y axis**

- Type: boolean
- Default: off
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `top_bottom_infill_wall_overlap`

**Top and bottom infill to wall overlap**

How far the solid infill on the first and the topmost layer reaches into the walls, in percent of the gap between them. More overlap closes pinholes along the wall; too much makes the edge bulge. 25 to 30 % suits most prints.

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 25
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `top_layer_direction`

**Top layer direction**

- Type: number
- Unit: degrees
- Default: -1
- Recommended range: -1 to 360
- Used only when: Top shell layers (`top_shell_layers`) is above 0
- Tier: Expert, strength
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `top_shell_layers`

**Top shell layers**

- Type: integer
- Unit: layers
- Default: 4
- Recommended range: 0 to 50
- Orca limits: 0 to none
- Tier: Expert, strength
- Changing it redoes: surfaces
- Easy mode: Set by the Detail control. Derived: ceil(top shell thickness / layer height).
- mimir class: edit (may change in a plate override)
- Effect: higher: Thicker top skin closes sparse infill gaps and adds time. lower: Thinner top skin can show infill pattern through the top

### `top_shell_thickness`

**Top shell thickness**

- Type: number
- Unit: mm
- Default: 0.6
- Recommended range: 0 to 10
- Orca limits: 0 to none
- Used only when: Spiral vase (`spiral_mode`) is off; and Top shell layers (`top_shell_layers`) is above 0
- Tier: Advanced, strength
- Changing it redoes: surfaces
- Easy mode: Set by the Detail control. Top skin in mm. The layer count is derived from it.
- mimir class: edit (may change in a plate override)

### `top_surface_density`

**Top surface density**

How densely the top surface is filled, in percent. 100 % gives a solid, smooth top; lower values space the lines out and save filament, and 0 leaves the top open.

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 0 to 100
- Used only when: Top shell layers (`top_shell_layers`) is above 0
- Tier: Advanced, strength
- Changing it redoes: surfaces
- mimir class: read (not in the catalog: never written)

### `top_surface_expansion`

**Top surface expansion**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, strength
- Changing it redoes: surfaces
- mimir class: read (not in the catalog: never written)

### `top_surface_expansion_direction`

**Top surface expansion direction**

- Type: enum
- Default: "inward_and_outward"
- Values: `inward_and_outward` (Inward and outward), `inward` (Inward), `outward` (Outward)
- Tier: Expert, strength
- Changing it redoes: surfaces
- mimir class: read (not in the catalog: never written)

### `top_surface_expansion_margin`

**Top surface expansion margin**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to 10
- Tier: Expert, strength
- Changing it redoes: surfaces
- mimir class: read (not in the catalog: never written)

### `top_surface_fill_order`

**Order of top surface fill**

- Type: enum
- Default: "default"
- Values: `default` (Default), `outward` (Outward), `inward` (Inward)
- Tier: Expert, strength
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wall_loops`

**Wall loops**

- Type: integer
- Default: 2
- Recommended range: 1 to 20
- Orca limits: 0 to 1000
- Tier: Simple, strength
- Changing it redoes: perimeters
- Easy mode: Set by the Strength control.
- mimir class: edit (may change in a plate override)
- Effect: higher: More walls make the part stronger and add print time. lower: Fewer walls save time and filament but weaken the part
