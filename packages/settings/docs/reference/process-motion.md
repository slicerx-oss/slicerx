# Process: Acceleration, jerk and machine limits

21 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `accel_to_decel_enable`

**Cap acceleration change per move**

- Type: boolean
- Default: on
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `accel_to_decel_factor`

**Accel to decel factor**

- Type: percent (a number, 15 means 15%)
- Unit: %
- Default: 50
- Recommended range: 1 to 100
- Used only when: Cap acceleration change per move (`accel_to_decel_enable`) is on
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `bridge_acceleration`

**Bridge acceleration**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s2
- Default: ["50%"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `default_acceleration`

**Default acceleration**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [500]
- Recommended range: 100 to 50000
- Orca limits: 0 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)
- Effect: higher: Higher acceleration saves time and increases ringing. lower: Lower acceleration is quieter and cleaner

### `default_jerk`

**Default jerk**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0]
- Recommended range: 0 to 50
- Orca limits: 0 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `default_junction_deviation`

**Default junction deviation**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to 0.3
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `infill_jerk`

**Infill jerk**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [9]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `initial_layer_acceleration`

**First layer acceleration**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [300]
- Recommended range: 0 to 20000
- Orca limits: 0 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Default acceleration (`default_acceleration`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `initial_layer_jerk`

**Initial layer jerk**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [9]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `initial_layer_travel_acceleration`

**Initial layer travel acceleration**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s2
- Default: ["100%"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `initial_layer_travel_jerk`

**Initial layer travel jerk**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s
- Default: ["100%"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `inner_wall_acceleration`

**Inner wall acceleration**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [10000]
- Recommended range: 0 to 50000
- Orca limits: 0 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Wall loops (`wall_loops`) is above 0; and Default acceleration (`default_acceleration`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)

### `inner_wall_jerk`

**Inner wall jerk**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [9]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `internal_solid_infill_acceleration`

**Internal solid infill acceleration**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s2
- Default: ["100%"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `outer_wall_acceleration`

**Outer wall acceleration**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [500]
- Recommended range: 0 to 50000
- Orca limits: 0 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Wall loops (`wall_loops`) is above 0; and Default acceleration (`default_acceleration`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)

### `outer_wall_jerk`

**Outer wall jerk**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [9]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `sparse_infill_acceleration`

**Sparse infill acceleration**

- Type: list of millimeter or percent strings, one per extruder
- Unit: mm/s2
- Default: ["100%"]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Infill density (`sparse_infill_density`) is above 0; and Default acceleration (`default_acceleration`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)

### `top_surface_acceleration`

**Top surface acceleration**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [500]
- Recommended range: 0 to 50000
- Orca limits: 0 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Default acceleration (`default_acceleration`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- Easy mode: Scaled by the Speed control (speed presets quality 0.5x, balanced 1x, fast 1.24x, fastest 1.66x); never below its own value because of a flow or acceleration cap.
- mimir class: edit (may change in a plate override)

### `top_surface_jerk`

**Top surface jerk**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [9]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `travel_acceleration`

**Travel acceleration**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [10000]
- Recommended range: 0 to 50000
- Orca limits: 0 to none
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Used only when: Default acceleration (`default_acceleration`) is above 0
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `travel_jerk`

**Travel jerk**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [12]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Tier: Expert, speed
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
