# Filament: Retraction

22 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `filament_deretraction_speed`

**Filament deretraction speed**

Overrides the printer's deretraction speed for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_long_retractions_when_cut`

**Filament long retractions when cut**

Overrides the printer's long retractions when cut for this filament. Empty uses the printer's value.

- Type: list of booleans, one per extruder
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_after_wipe`

**Filament retract after wipe**

- Type: list of percents, one per extruder
- Unit: %
- Default: [0]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_before_wipe`

**Filament retract before wipe**

Overrides the printer's retract before wipe for this filament. Empty uses the printer's value.

- Type: list of percents, one per extruder
- Unit: %
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_length_nc`

**Filament retract length nc**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to 18
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_length_toolchange`

**Filament retract length toolchange**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_lift_above`

**Filament retract lift above**

Overrides the printer's retract lift above for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_lift_below`

**Filament retract lift below**

Overrides the printer's retract lift below for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_lift_enforce`

**Filament retract lift enforce**

Overrides the printer's retract lift enforce for this filament. Empty uses the printer's value.

- Type: list of enum values, one per extruder
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Values: `All Surfaces` (All surfaces), `Top Only` (Top only), `Bottom Only` (Bottom only), `Top and Bottom` (Top and bottom)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_restart_extra`

**Filament retract restart extra**

Overrides the printer's retract restart extra for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_restart_extra_toolchange`

**Filament retract restart extra toolchange**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retract_when_changing_layer`

**Filament retract when changing layer**

Overrides the printer's retract at each layer change for this filament. Empty uses the printer's value.

- Type: list of booleans, one per extruder
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retraction_distances_when_cut`

**Filament retraction distances when cut**

Overrides the printer's retraction distances when cut for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Default: empty list
- Recommended range: 10 to 18
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retraction_length`

**Filament retraction length**

Overrides the printer's retraction length for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retraction_minimum_travel`

**Filament retraction minimum travel**

Overrides the printer's shortest travel that triggers a retraction for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_retraction_speed`

**Filament retraction speed**

Overrides the printer's retraction speed for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_wipe`

**Filament wipe**

Overrides the printer's wipe while retracting for this filament. Empty uses the printer's value.

- Type: list of booleans, one per extruder
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_wipe_distance`

**Filament wipe distance**

Overrides the printer's wipe distance for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_z_hop`

**Filament Z hop height**

Overrides the printer's z hop height for this filament. Empty uses the printer's value.

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Recommended range: 0 to 5
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_z_hop_types`

**Filament z hop types**

Overrides the printer's z hop type for this filament. Empty uses the printer's value.

- Type: list of enum values, one per extruder
- Default: empty list
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Values: `Auto Lift` (Auto), `Normal Lift` (Normal), `Slope Lift` (Slope), `Spiral Lift` (Spiral)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `long_retractions_when_ec`

**Long retractions when ec**

- Type: list of booleans, one per extruder
- Default: [false]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `retraction_distances_when_ec`

**Retraction distances when ec**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [10]
- Recommended range: 0 to 10
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
