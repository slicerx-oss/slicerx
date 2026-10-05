# Process: Speed

22 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `gap_infill_speed`

**Gap infill speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [30]
- Recommended range: 5 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)

### `initial_layer_infill_speed`

**Infill speed on the first layer**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [60]
- Recommended range: 5 to 300
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `initial_layer_speed`

**First layer speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [30]
- Recommended range: 5 to 300
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: A faster first layer saves time and risks poor adhesion. lower: A slower first layer sticks better

### `initial_layer_travel_speed`

**Initial layer travel speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["100%"]
- Recommended range: 1 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `inner_wall_speed`

**Inner wall speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [60]
- Recommended range: 5 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)
- Effect: higher: Faster inner walls save time. lower: Slower inner walls improve bonding

### `internal_bridge_speed`

**Internal bridge speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["150%"]
- Recommended range: 1 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `internal_solid_infill_speed`

**Solid infill speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [100]
- Recommended range: 5 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)

### `outer_wall_speed`

**Outer wall speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [60]
- Recommended range: 5 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Wall loops (`wall_loops`) is above 0
- Tier: Advanced, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)
- Effect: higher: A faster outer wall saves time and can show ringing. lower: A slower outer wall gives a cleaner surface

### `role_based_wipe_speed`

**Role based wipe speed**

- Type: boolean
- Default: on
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `slow_down_layers`

**Slow down layers**

- Type: integer
- Unit: layers
- Default: 0
- Recommended range: 0 to no maximum
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `slowdown_for_curled_perimeters`

**Slow down on curling walls**

- Type: list of booleans, one per extruder
- Default: [false]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)

### `small_perimeter_speed`

**Small perimeter speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["50%"]
- Recommended range: 1 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `small_perimeter_threshold`

**Small perimeter threshold**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `small_support_perimeter_speed`

**Small support perimeter speed**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["50%"]
- Recommended range: 1 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `small_support_perimeter_threshold`

**Small support perimeter threshold**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `sparse_infill_speed`

**Sparse infill speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [100]
- Recommended range: 5 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Infill density (`sparse_infill_density`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)
- Effect: higher: Faster infill saves time, limited by the hotend flow. lower: Slower infill costs time and helps little

### `support_interface_speed`

**Support interface speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [80]
- Recommended range: 1 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Enable support (`enable_support`) is on; and Enable support (`enable_support`) is on
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_speed`

**Support speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [80]
- Recommended range: 5 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Enable support (`enable_support`) is on
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `top_surface_speed`

**Top surface speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [100]
- Recommended range: 5 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Top shell layers (`top_shell_layers`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)
- Effect: higher: Faster top surfaces save time and roughen the finish. lower: Slower top surfaces look smoother

### `travel_speed`

**Travel speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [120]
- Recommended range: 20 to 1000
- Orca limits: 1 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: Faster travel saves time and can cause vibration. lower: Slower travel is quieter

### `travel_speed_z`

**Travel speed z** (develop mode)

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Develop only
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `wipe_speed`

**Wipe speed**

- Type: millimeters or percent (string such as "0.42" or "110%")
- Unit: mm/s
- Default: "80%"
- Recommended range: 0 to no maximum
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
