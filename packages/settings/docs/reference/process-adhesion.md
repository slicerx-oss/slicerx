# Process: Adhesion: skirt, brim and raft

27 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `brim_ears_detection_length`

**Brim ears detection length**

- Type: number
- Unit: mm
- Default: 1
- Recommended range: 0 to no maximum
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `brim_ears_max_angle`

**Brim ears max angle**

- Type: number
- Unit: degrees
- Default: 125
- Recommended range: 0 to 180
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `brim_ears_outer_only`

**Brim ears on the outside only**

- Type: boolean
- Default: off
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `brim_flow_ratio`

**Brim flow ratio**

- Type: number
- Default: 1
- Recommended range: 0 to 2
- Used only when: Brim type (`brim_type`) is not "no_brim"
- Tier: Expert, adhesion
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `brim_object_gap`

**Gap between brim and part**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to 2
- Used only when: Brim type (`brim_type`) is not "no_brim"
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `brim_type`

**Brim type**

- Type: enum
- Default: "auto_brim"
- Values: `auto_brim` (Auto), `brim_ears` (Mouse ear), `painted` (Painted), `outer_only` (Outer brim only), `inner_only` (Inner brim only), `outer_and_inner` (Outer and inner brim), `no_brim` (No brim)
- Tier: Simple, adhesion
- Changing it redoes: paths
- Easy mode: Set by the Brim control.
- mimir class: edit (may change in a plate override)

### `brim_use_efc_outline`

**Brim use efc outline**

- Type: boolean
- Default: off
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `brim_width`

**Brim width**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to 30
- Orca limits: 0 to 100
- Used only when: Brim type (`brim_type`) is none of "no_brim", "auto_brim"
- Tier: Advanced, adhesion
- Changing it redoes: paths
- Easy mode: Set by the Brim control.
- mimir class: edit (may change in a plate override)
- Effect: higher: A wider brim holds the part better and costs more time. lower: A narrower brim frees more bed space

### `draft_shield`

**Draft shield**

- Type: enum
- Default: "disabled"
- Values: `disabled` (Off), `enabled` (On)
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `min_skirt_length`

**Min skirt length**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to no maximum
- Used only when: Skirt loops (`skirt_loops`) is above 0
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `raft_contact_distance`

**Raft contact distance**

- Type: number
- Unit: mm
- Default: 0.1
- Recommended range: 0 to no maximum
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `raft_expansion`

**Raft expansion**

- Type: number
- Unit: mm
- Default: 1.5
- Recommended range: 0 to no maximum
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `raft_first_layer_density`

**Raft first layer density**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 90
- Recommended range: 10 to 100
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `raft_first_layer_expansion`

**Raft first layer expansion**

- Type: number
- Unit: mm
- Default: 2
- Recommended range: 0 to no maximum
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `raft_layers`

**Raft layers**

- Type: integer
- Unit: layers
- Default: 0
- Recommended range: 0 to 10
- Orca limits: 0 to 100
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `single_loop_draft_shield`

**Single loop draft shield**

- Type: boolean
- Default: off
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `skirt_distance`

**Skirt distance**

- Type: number
- Unit: mm
- Default: 2
- Recommended range: 0 to 60
- Used only when: Skirt loops (`skirt_loops`) is above 0
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `skirt_height`

**Skirt height**

- Type: integer
- Unit: layers
- Default: 1
- Recommended range: no minimum to 10000
- Used only when: Skirt loops (`skirt_loops`) is above 0; and Draft shield (`draft_shield`) is not "enabled"
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `skirt_loops`

**Skirt loops**

- Type: integer
- Default: 1
- Recommended range: 0 to 10
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)
- Effect: higher: More skirt loops prime the nozzle longer. lower: No skirt skips priming

### `skirt_speed`

**Skirt speed**

- Type: number
- Unit: mm/s
- Default: 50
- Recommended range: 0 to no maximum
- Used only when: Skirt loops (`skirt_loops`) is above 0
- Tier: Expert, adhesion
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `skirt_start_angle`

**Skirt start angle**

- Type: number
- Unit: degrees
- Default: -135
- Recommended range: -180 to 180
- Tier: Expert, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `skirt_type`

**Skirt type**

- Type: enum
- Default: "combined"
- Values: `combined` (Combined), `perobject` (Per object)
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_ironing`

**Support ironing**

- Type: boolean
- Default: off
- Used only when: Enable support (`enable_support`) is on
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_ironing_flow`

**Support ironing flow**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 10
- Recommended range: 0 to 100
- Tier: Expert, supports
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_ironing_pattern`

**Support ironing pattern**

- Type: enum
- Default: "rectilinear"
- Values: `rectilinear` (Rectilinear), `concentric` (Concentric)
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_ironing_spacing`

**Support ironing spacing**

- Type: number
- Unit: mm
- Default: 0.1
- Recommended range: 0 to 1
- Tier: Expert, supports
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tree_support_brim_width`

**Brim size under tree support**

- Type: number
- Default: 3
- Recommended range: 0 to no maximum
- Used only when: Enable support (`enable_support`) is on; and Support type (`support_type`) is one of "tree(auto)", "tree(manual)"; and Tree support auto brim (`tree_support_auto_brim`) is off
- Tier: Advanced, adhesion
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)
