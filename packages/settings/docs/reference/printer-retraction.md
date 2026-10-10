# Printer: Retraction

25 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `deretract_speed_extruder_change`

**Deretract speed extruder change** (develop mode)

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `deretraction_speed`

**Deretraction speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0]
- Recommended range: 0 to 120
- Orca limits: none to none
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `long_retractions_when_cut`

**Long retractions when cut** (develop mode)

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `parking_pos_retraction`

**Parking pos retraction**

- Type: number
- Unit: mm
- Default: 92
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_after_wipe`

**Retract after wipe**

- Type: list of percents, one per extruder
- Unit: %
- Default: [0]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_before_wipe`

**Retract before wipe**

- Type: list of percents, one per extruder
- Unit: %
- Default: [100]
- Used only when: Wipe while retracting (`wipe`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_length_toolchange`

**Retract length toolchange**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_lift_above`

**Retract lift above**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Used only when: Z hop height (`z_hop`) is above 0
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_lift_below`

**Retract lift below**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Used only when: Z hop height (`z_hop`) is above 0
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_lift_enforce`

**Retract lift enforce**

- Type: list of enum values, one per extruder
- Default: ["All Surfaces"]
- Values: `All Surfaces` (All surfaces), `Top Only` (Top only), `Bottom Only` (Bottom only), `Top and Bottom` (Top and bottom)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_lift_toolchange`

**Lift at a tool change**

How far the nozzle lifts before a tool change and stays lifted until it reaches the next print move.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to 10
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_restart_extra`

**Retract restart extra**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_restart_extra_toolchange`

**Retract restart extra toolchange**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_speed_toolchange`

**Retraction speed at a tool change**

How fast the filament pulls back by the tool change retraction length, beyond the usual retraction.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0]
- Recommended range: 0 to 120
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retract_when_changing_layer`

**Retract at each layer change**

- Type: list of booleans, one per extruder
- Default: [false]
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `retraction_distances_when_cut`

**Retraction distances when cut** (develop mode)

- Type: list of numbers, one per extruder
- Default: [18]
- Recommended range: 10 to 18
- Automatic: The value 0 means automatic and is always allowed.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retraction_length`

**Retraction length**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0.8]
- Recommended range: 0 to 10
- Orca limits: none to none
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: Longer retraction reduces stringing and risks clogs. lower: Shorter retraction can leave strings

### `retraction_minimum_travel`

**Shortest travel that triggers a retraction**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [2]
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `retraction_speed`

**Retraction speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [30]
- Recommended range: 5 to 120
- Orca limits: none to none
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: Faster retraction reduces stringing and can grind the filament. lower: Slower retraction can ooze

### `use_firmware_retraction`

**Use firmware retraction**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wipe`

**Wipe while retracting**

- Type: list of booleans, one per extruder
- Default: [false]
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `wipe_distance`

**Wipe distance**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [1]
- Recommended range: 0 to no maximum
- Used only when: Wipe while retracting (`wipe`) is on
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `wipe_tower_type`

**Prime tower type**

- Type: enum
- Default: "type1"
- Values: `type1` (Type 1), `type2` (Type 2)
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `z_hop`

**Z hop height**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0.4]
- Recommended range: 0 to 2
- Orca limits: 0 to 5
- Used only when: Use firmware retraction (`use_firmware_retraction`) is off
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: More lift avoids scarring on travel and slows printing. lower: No lift is faster and can scar top surfaces

### `z_hop_types`

**Z hop type**

- Type: list of enum values, one per extruder
- Default: ["Slope Lift"]
- Values: `Auto Lift` (Auto), `Normal Lift` (Normal), `Slope Lift` (Slope), `Spiral Lift` (Spiral)
- Used only when: Z hop height (`z_hop`) is above 0
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
