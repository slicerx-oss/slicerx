# Process: Advanced extrusion

27 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `bottom_solid_infill_flow_ratio`

**Bottom solid infill flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extrusion_rate_smoothing_external_perimeter_only`

**Smooth outer walls only**

Applies extrusion rate smoothing only to outer walls and overhangs, where speed changes show, and leaves the rest of the print at full speed.

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `first_layer_flow_ratio`

**First layer flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `gap_fill_flow_ratio`

**Gap fill flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `inner_wall_flow_ratio`

**Inner wall flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `interlocking_beam`

**Interlocking beam**

- Type: boolean
- Default: off
- Tier: Advanced, strength
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `interlocking_beam_layer_count`

**Interlocking beam layer count**

- Type: integer
- Default: 2
- Recommended range: 1 to no maximum
- Tier: Expert, strength
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `interlocking_beam_width`

**Interlocking beam width**

- Type: number
- Unit: mm
- Default: 0.8
- Recommended range: 0.01 to no maximum
- Tier: Expert, strength
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `interlocking_boundary_avoidance`

**Interlocking boundary avoidance**

- Type: integer
- Default: 2
- Recommended range: 0 to no maximum
- Tier: Expert, strength
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `interlocking_depth`

**Interlocking depth**

- Type: integer
- Default: 2
- Recommended range: 1 to no maximum
- Tier: Expert, strength
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `interlocking_orientation`

**Interlocking orientation**

- Type: number
- Unit: degrees
- Default: 22.5
- Recommended range: 0 to 360
- Tier: Expert, strength
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `internal_solid_infill_flow_ratio`

**Solid infill flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `max_volumetric_extrusion_rate_slope`

**Extrusion rate smoothing**

Limits how fast the volumetric flow may change, in mm3/s per second, so sudden speed changes leave no bulges or gaps. 0 turns it off. Fast printers with pressure advance rarely need it (try 300); slow printers without it start at 10 to 15 for direct drive and 5 to 10 for Bowden. Turns arc fitting off.

- Type: number
- Unit: mm3/s2
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `max_volumetric_extrusion_rate_slope_segment_length`

**Smoothing segment length**

Length of the steps a smoothed line is cut into, in mm. Shorter steps change the flow more smoothly but make the G-code larger. Raise it if the printer stutters.

- Type: number
- Unit: mm
- Default: 3
- Recommended range: 0.5 to 5
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `mmu_segmented_region_interlocking_depth`

**Painted color interlocking depth**

On every other layer, painted colors reach this deep instead, in mm, so the two filaments interlock and hold together better. 0 turns it off. Not used with beam interlocking.

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `mmu_segmented_region_max_width`

**Painted color depth**

How far painted colors reach in from the outside of the part, in mm. The inside prints in the part's own filament, which saves filament. 0 lets the color fill the whole painted region.

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, multicolor, shown with two or more filaments
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `outer_wall_flow_ratio`

**Outer wall flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `overhang_flow_ratio`

**Overhang flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `print_flow_ratio`

**Print flow ratio**

- Type: number
- Default: 1
- Recommended range: 0.01 to 2
- Tier: Advanced, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `scarf_joint_flow_ratio`

**Ramped seam flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `set_other_flow_ratios`

**Set the other flow ratios**

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `small_area_infill_flow_compensation`

**Small area flow compensation**

Lowers the flow of short solid infill lines, which tend to over-extrude in small areas. The small area flow model sets how much.

- Type: boolean
- Default: off
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `small_area_infill_flow_compensation_model`

**Small area flow model**

Pairs of line length in mm and flow factor, one pair per line, shortest first. A line takes the factor for its length, smoothly between the points, and full flow past the last length.

- Type: list of strings, one per extruder
- Default: ["0,0","\n0.2,0.4444","\n0.4,0.6145","\n0.6,0.7059","\n0.8,0.7619","\n1.5,0.8571","\n2,...
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `sparse_infill_flow_ratio`

**Sparse infill flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Used only when: Infill density (`sparse_infill_density`) is above 0
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_flow_ratio`

**Support flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Used only when: Enable support (`enable_support`) is on
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_interface_flow_ratio`

**Support interface flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `top_solid_infill_flow_ratio`

**Top solid infill flow ratio**

- Type: list of numbers, one per extruder
- Default: [1]
- Recommended range: 0 to 2
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, quality
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
