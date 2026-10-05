# Process: Quality and geometry

89 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `detect_thin_wall`

**Detect thin walls**

- Type: boolean
- Default: off
- Used only when: Wall generator (`wall_generator`) is not "arachne"
- Tier: Expert, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `dont_filter_internal_bridges`

**Filter small internal bridges**

Which small internal bridges are dropped so solid infill prints straight over the sparse infill. Filter suits most parts; limited and no filtering add bridges under slanted and curved tops, which reduces pillowing at some cost in time.

- Type: enum
- Default: "disabled"
- Values: `disabled` (Filter), `limited` (Limited filtering), `nofilter` (No filtering)
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `elefant_foot_compensation`

**Elephant foot compensation**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to 1
- Orca limits: 0 to none
- Tier: Advanced, quality
- Changing it redoes: contours
- mimir class: edit (may change in a plate override)
- Effect: higher: The first layer is pulled in more to counter elephant foot. lower: The first layer flares out more

### `elefant_foot_compensation_layers`

**Elefant foot compensation layers**

- Type: integer
- Unit: layers
- Default: 1
- Recommended range: 1 to no maximum
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `elefant_foot_layers_density`

**Elefant foot layers density**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 50 to 100
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_arc_fitting`

**Arc fitting**

- Type: boolean
- Default: off
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `enable_extra_bridge_layer`

**Extra bridge layers**

Prints a second bridge layer over bridges, so the solid layers above sag less and top surfaces show less pillowing. External bridges get a second layer in the same direction, internal bridges one at a right angle.

- Type: enum
- Default: "disabled"
- Values: `disabled` (Off), `external_bridge_only` (Over external bridges), `internal_bridge_only` (Over internal bridges), `apply_to_all` (Over all bridges)
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_mixed_color_sublayer`

**Enable mixed color sublayer**

- Type: boolean
- Default: off
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filter_out_gap_fill`

**Filter out gap fill**

- Type: number
- Unit: mm
- Default: 0
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `hole_to_polyhole`

**Print round holes as polyholes**

- Type: boolean
- Default: off
- Tier: Advanced, quality
- Changing it redoes: contours
- mimir class: edit (may change in a plate override)

### `hole_to_polyhole_max_edges`

**Hole to polyhole max edges**

- Type: integer
- Default: 50
- Recommended range: 3 to no maximum
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `hole_to_polyhole_threshold`

**Hole to polyhole threshold**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0.01"
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `hole_to_polyhole_twisted`

**Hole to polyhole twisted**

- Type: boolean
- Default: on
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `initial_layer_line_width`

**Line width on the first layer**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0.1 to 2
- Orca limits: 0 to 1000
- Automatic: The value 0 means automatic and is always allowed.
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `initial_layer_min_bead_width`

**Initial layer min bead width**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 85
- Recommended range: 0 to no maximum
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `initial_layer_print_height`

**First layer height**

- Type: number
- Unit: mm
- Default: 0.2
- Recommended range: 0.08 to 0.8
- Orca limits: 0 to none
- Tier: Advanced, quality
- Changing it redoes: layers (the whole slice)
- Easy mode: Set by the Detail control.
- mimir class: edit (may change in a plate override)
- Effect: higher: A thicker first layer hides bed unevenness but is harder to squish flat. lower: A thinner first layer needs a level bed

### `inner_wall_line_width`

**Line width of inner walls**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0.1 to 2
- Orca limits: 0 to 1000
- Automatic: The value 0 means automatic and is always allowed.
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `internal_bridge_flow`

**Internal bridge flow**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `internal_solid_infill_line_width`

**Line width of solid infill**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0.1 to 2
- Orca limits: 0 to 1000
- Automatic: The value 0 means automatic and is always allowed.
- Tier: Expert, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `ironing_angle`

**Ironing angle**

- Type: number
- Unit: degrees
- Default: 0
- Recommended range: 0 to 359
- Used only when: Ironing type (`ironing_type`) is not "no ironing"
- Tier: Expert, effects
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `ironing_angle_fixed`

**Ironing angle fixed**

- Type: boolean
- Default: off
- Tier: Expert, effects
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `ironing_expansion`

**Ironing expansion**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: -100 to 100
- Tier: Expert, effects
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `ironing_flow`

**Ironing flow**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 10
- Recommended range: 0 to 30
- Orca limits: 0 to 100
- Used only when: Ironing type (`ironing_type`) is not "no ironing"
- Tier: Expert, effects
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `ironing_inset`

**Ironing inset**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to 100
- Used only when: Ironing type (`ironing_type`) is not "no ironing"
- Tier: Expert, effects
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `ironing_pattern`

**Ironing pattern**

- Type: enum
- Default: "rectilinear"
- Values: `rectilinear` (Rectilinear), `concentric` (Concentric)
- Used only when: Ironing type (`ironing_type`) is not "no ironing"
- Tier: Expert, effects
- Changing it redoes: infill
- mimir class: read (not in the catalog: never written)

### `ironing_spacing`

**Ironing line spacing**

- Type: number
- Unit: mm
- Default: 0.1
- Recommended range: 0.05 to 0.5
- Orca limits: 0 to 1
- Used only when: Ironing type (`ironing_type`) is not "no ironing"
- Tier: Expert, effects
- Changing it redoes: infill
- mimir class: edit (may change in a plate override)

### `ironing_speed`

**Ironing speed**

- Type: number
- Unit: mm/s
- Default: 20
- Recommended range: 5 to 200
- Orca limits: 1 to none
- Used only when: Ironing type (`ironing_type`) is not "no ironing"
- Tier: Expert, effects
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `ironing_type`

**Ironing type**

- Type: enum
- Default: "no ironing"
- Values: `no ironing` (No ironing), `top` (Top surfaces), `topmost` (Topmost surface), `solid` (All solid layers)
- Tier: Advanced, effects
- Changing it redoes: infill
- mimir class: edit (may change in a plate override)
- Effect: higher: Ironing smooths chosen top surfaces and adds time. lower: Without ironing top surfaces print faster and rougher

### `is_infill_first`

**Is infill first**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `layer_height`

**Layer height**

- Type: number
- Unit: mm
- Default: 0.2
- Recommended range: 0.04 to 0.8
- Orca limits: 0 to none
- Tier: Simple, quality
- Changing it redoes: layers (the whole slice)
- Easy mode: Set by the Detail control. 0.28 to 0.08 mm on a 0.4 mm nozzle, scaled with the nozzle, kept between 0.2 and 0.75 of its diameter.
- mimir class: edit (may change in a plate override)
- Effect: higher: Thicker layers print faster and show more layer lines. lower: Thinner layers print slower and look smoother

### `line_width`

**Default line width**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0.1 to 2
- Orca limits: 0 to 1000
- Automatic: The value 0 means automatic and is always allowed.
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: Wider lines print faster and bond better. lower: Narrower lines resolve finer detail

### `max_travel_detour_distance`

**Max travel detour distance**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0 to no maximum
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `min_bead_width`

**Min bead width**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 85
- Recommended range: 0 to no maximum
- Used only when: Wall generator (`wall_generator`) is "arachne"
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `min_feature_size`

**Min feature size**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 25
- Recommended range: 0 to no maximum
- Used only when: Wall generator (`wall_generator`) is "arachne"
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `min_length_factor`

**Min length factor**

- Type: number
- Unit: mm
- Default: 0.5
- Recommended range: 0 to 25
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `min_width_top_surface`

**Min width top surface**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "300%"
- Recommended range: 0 to no maximum
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `only_one_wall_first_layer`

**Only one wall first layer**

- Type: boolean
- Default: off
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `only_one_wall_top`

**Single wall on the top surface**

- Type: boolean
- Default: off
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `outer_wall_line_width`

**Line width of outer walls**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0.1 to 2
- Orca limits: 0 to 1000
- Automatic: The value 0 means automatic and is always allowed.
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `precise_outer_wall`

**Precise wall**

- Type: boolean
- Default: off
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `precise_z_height`

**Precise Z height**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: layers (the whole slice)
- mimir class: edit (may change in a plate override)

### `resolution`

**Slice resolution** (develop mode)

- Type: number
- Unit: mm
- Default: 0.01
- Recommended range: 0.001 to 0.1
- Orca limits: 0 to none
- Tier: Develop only
- Changing it redoes: contours
- mimir class: edit (may change in a plate override)

### `scarf_angle_threshold`

**Scarf angle threshold**

- Type: integer
- Unit: degrees
- Default: 155
- Recommended range: 0 to 180
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `scarf_joint_speed`

**Scarf joint speed**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm/s
- Default: "100%"
- Recommended range: 1 to no maximum
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `scarf_overhang_threshold`

**Scarf overhang threshold**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 40
- Recommended range: 0 to no maximum
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `seam_gap`

**Seam gap**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "10%"
- Recommended range: 0 to no maximum
- Tier: Advanced, quality
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `seam_position`

**Seam position**

- Type: enum
- Default: "aligned"
- Values: `nearest` (Nearest), `aligned` (Aligned), `aligned_back` (Aligned back), `back` (Back), `random` (Random)
- Tier: Advanced, quality
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)
- Effect: higher: Changes where layer starts and ends are placed. lower: Changes where layer starts and ends are placed

### `seam_slope_conditional`

**Seam slope conditional**

- Type: boolean
- Default: off
- Tier: Advanced, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `seam_slope_entire_loop`

**Seam slope entire loop**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `seam_slope_inner_walls`

**Seam slope inner walls**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `seam_slope_min_length`

**Seam slope min length**

- Type: number
- Unit: mm
- Default: 20
- Recommended range: 0 to no maximum
- Used only when: Scarf joint seam (`seam_slope_type`) is not "none"; and Seam slope entire loop (`seam_slope_entire_loop`) is off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `seam_slope_start_height`

**Seam slope start height**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0 to no maximum
- Used only when: Scarf joint seam (`seam_slope_type`) is not "none"
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `seam_slope_steps`

**Seam slope steps**

- Type: integer
- Default: 10
- Recommended range: 1 to no maximum
- Used only when: Scarf joint seam (`seam_slope_type`) is not "none"
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `seam_slope_type`

**Scarf joint seam**

- Type: enum
- Default: "none"
- Values: `none` (None), `external` (Contour), `all` (Contour and hole)
- Used only when: Spiral vase (`spiral_mode`) is off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `slice_closing_radius`

**Slice closing radius** (develop mode)

- Type: number
- Unit: mm
- Default: 0.049
- Recommended range: 0 to no maximum
- Tier: Develop only
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `slicing_mode`

**Slicing mode**

- Type: enum
- Default: "regular"
- Values: `regular` (Regular), `even_odd` (Even-odd), `close_holes` (Close holes)
- Tier: Expert, quality
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `smart_layer`

**sleipnir**

Automatic variable layer height. Off keeps one layer height. Quality thins layers where curved and detailed surfaces need it; Strength thins layers where the part carries load and keeps them thick elsewhere.

- Type: enum
- Default: "quality"
- Values: `off` (Off), `quality` (sleipnir: Quality), `strength` (sleipnir: Strength)
- Tier: Simple, quality
- Changing it redoes: layers (the whole slice)
- Easy mode: Set by the sleipnir control. The sleipnir switch. On means Quality, or Strength when the Strength control is 70 or more.
- mimir class: edit (may change in a plate override)
- Effect: higher: sleipnir changes layer heights along the part. lower: One layer height throughout

### `smart_layer_max_height`

**sleipnir thickest layer**

The thickest layer sleipnir may use. Keep it at most three quarters of the nozzle diameter unless the material's research says otherwise.

- Type: number
- Unit: mm
- Default: 0.2
- Recommended range: 0.04 to 0.8
- Used only when: sleipnir (`smart_layer`) is not "off"
- Tier: Expert, quality
- Changing it redoes: layers (the whole slice)
- Easy mode: Set by the sleipnir control. At most half the nozzle in both modes, and about one and a half times the layer height the Detail slider gives, never closer than one step to the thinnest layer.
- mimir class: edit (may change in a plate override)
- Effect: higher: Plain areas print faster and look coarser. lower: Plain areas print slower and look smoother

### `smart_layer_max_step_ratio`

**sleipnir largest step**

The biggest change in layer height from one layer to the next, as a fraction of the previous layer. Smaller steps look smoother.

- Type: number
- Default: 0.25
- Recommended range: 0.05 to 1
- Used only when: sleipnir (`smart_layer`) is not "off"
- Tier: Expert, quality
- Changing it redoes: layers (the whole slice)
- mimir class: edit (may change in a plate override)
- Effect: higher: Layer height may jump more between layers. lower: Layer height changes in smaller steps

### `smart_layer_min_height`

**sleipnir thinnest layer**

The thinnest layer sleipnir may use. Keep it at least a quarter of the nozzle diameter unless the material's research says otherwise.

- Type: number
- Unit: mm
- Default: 0.15
- Recommended range: 0.04 to 0.8
- Used only when: sleipnir (`smart_layer`) is not "off"
- Tier: Expert, quality
- Changing it redoes: layers (the whole slice)
- Easy mode: Set by the sleipnir control. At least 20 percent of the nozzle in Quality and 30 percent in Strength, and about three quarters of the layer height the Detail slider gives (0.15 mm at 0.20 mm), at most one step under the thickest layer the nozzle allows.
- mimir class: edit (may change in a plate override)
- Effect: higher: Fine areas get thicker layers and less detail. lower: Fine areas get thinner layers and print slower

### `smart_layer_smoothing`

**sleipnir smoothing**

How strongly neighboring layer heights are blended. 0 follows the surface exactly, 100 gives the gentlest change.

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 70
- Recommended range: 0 to 100
- Used only when: sleipnir (`smart_layer`) is not "off"
- Tier: Expert, quality
- Changing it redoes: layers (the whole slice)
- mimir class: edit (may change in a plate override)
- Effect: higher: Layer height changes more gradually. lower: Layer height follows the surface more closely

### `smart_layer_smoothing_radius`

**sleipnir smoothing distance**

How far, along the height of the part, layer heights are blended. 0 picks eight times the thickest layer.

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to 20
- Used only when: sleipnir (`smart_layer`) is not "off"
- Tier: Expert, quality
- Changing it redoes: layers (the whole slice)
- mimir class: edit (may change in a plate override)
- Effect: higher: Layer height changes over a longer stretch. lower: Layer height changes over a shorter stretch

### `sparse_infill_line_width`

**Line width of sparse infill**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0.1 to 2
- Orca limits: 0 to 1000
- Automatic: The value 0 means automatic and is always allowed.
- Used only when: Infill density (`sparse_infill_density`) is above 0
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `staggered_inner_seams`

**Staggered inner seams**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `support_line_width`

**Support line width**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0 to 1000
- Used only when: Enable support (`enable_support`) is on
- Tier: Expert, quality
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `thick_internal_bridges`

**Thick internal bridges**

- Type: boolean
- Default: on
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `top_surface_line_width`

**Line width of top surfaces**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "0"
- Recommended range: 0.1 to 2
- Orca limits: 0 to 1000
- Automatic: The value 0 means automatic and is always allowed.
- Used only when: Top shell layers (`top_shell_layers`) is above 0
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `top_surface_pattern`

**Top surface pattern**

- Type: enum
- Default: "monotonicline"
- Values: `monotonic` (Monotonic), `monotonicline` (Monotonic line), `rectilinear` (Rectilinear), `alignedrectilinear` (Aligned rectilinear), `concentric` (Concentric), `hilbertcurve` (Hilbert curve), `archimedeanchords` (Archimedean chords), `octagramspiral` (Octagram spiral)
- Used only when: Top shell layers (`top_shell_layers`) is above 0
- Tier: Advanced, quality
- Changing it redoes: infill
- mimir class: edit (may change in a plate override)

### `tree_support_auto_brim`

**Tree support auto brim**

- Type: boolean
- Default: off
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `unsupported_wall_last`

**Unsupported wall last**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wall_direction`

**Wall direction**

- Type: enum
- Default: "ccw"
- Values: `ccw` (Counterclockwise), `cw` (Clockwise)
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wall_distribution_count`

**Wall distribution count**

- Type: integer
- Default: 1
- Recommended range: 1 to no maximum
- Used only when: Wall generator (`wall_generator`) is "arachne"
- Tier: Expert, quality
- Changing it redoes: perimeters
- mimir class: read (not in the catalog: never written)

### `wall_generator`

**Wall generator**

- Type: enum
- Default: "aegis"
- Values: `classic` (Classic), `arachne` (Arachne), `aegis`
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `wall_maximum_deviation`

**Wall maximum deviation**

- Type: number
- Unit: mm
- Default: 0.025
- Recommended range: 0.005 to 0.05
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wall_maximum_resolution`

**Wall maximum resolution**

- Type: number
- Unit: mm
- Default: 0.5
- Recommended range: 0.005 to 0.5
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wall_sequence`

**Wall printing order**

- Type: enum
- Default: "inner wall/outer wall"
- Values: `inner wall/outer wall` (Inner, then outer), `outer wall/inner wall` (Outer, then inner), `inner-outer-inner wall` (Inner, outer, inner)
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Advanced, quality
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)

### `wall_transition_angle`

**Wall transition angle**

- Type: number
- Unit: degrees
- Default: 10
- Recommended range: 1 to 59
- Used only when: Wall generator (`wall_generator`) is "arachne"
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `wall_transition_filter_deviation`

**Wall transition filter deviation**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 25
- Recommended range: 0 to no maximum
- Used only when: Wall generator (`wall_generator`) is "arachne"
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `wall_transition_length`

**Wall transition length**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 100
- Recommended range: 0 to no maximum
- Used only when: Wall generator (`wall_generator`) is "arachne"
- Tier: Expert, quality
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `wipe_before_external_loop`

**Wipe before the outer wall**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wipe_inward`

**Wipe inward**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wipe_inward_distance`

**Wipe inward distance**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm
- Default: "50%"
- Recommended range: 0 to 100
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wipe_on_loops`

**Wipe on loops**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `xy_contour_compensation`

**X-Y contour compensation**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: -0.5 to 0.5
- Orca limits: none to none
- Tier: Advanced, quality
- Changing it redoes: contours
- mimir class: edit (may change in a plate override)
- Effect: higher: Outer contours print larger. lower: Outer contours print smaller

### `xy_hole_compensation`

**X-Y hole compensation**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: -0.5 to 0.5
- Orca limits: none to none
- Tier: Advanced, quality
- Changing it redoes: contours
- mimir class: edit (may change in a plate override)
- Effect: higher: Holes print larger. lower: Holes print smaller

### `zaa_dont_alternate_fill_direction`

**Zaa dont alternate fill direction**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `zaa_enabled`

**Zaa enabled**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `zaa_min_z`

**Zaa min z**

- Type: number
- Unit: mm
- Default: 0.05
- Recommended range: 0 to 100
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `zaa_minimize_perimeter_height`

**Zaa minimize perimeter height**

- Type: number
- Unit: degrees
- Default: 35
- Recommended range: 0 to 90
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
