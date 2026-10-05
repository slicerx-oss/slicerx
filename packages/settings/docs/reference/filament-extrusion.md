# Filament: Extrusion

13 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `adaptive_pressure_advance`

**Adaptive pressure advance**

- Type: list of booleans, one per extruder
- Default: [false]
- Used only when: Enable pressure advance (`enable_pressure_advance`) is on
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `adaptive_pressure_advance_bridges`

**Adaptive pressure advance bridges**

- Type: list of numbers, one per extruder
- Default: [0]
- Recommended range: no minimum to 2
- Used only when: Enable pressure advance (`enable_pressure_advance`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `adaptive_pressure_advance_model`

**Adaptive pressure advance model**

- Type: list of strings, one per extruder
- Default: ["0,0,0\n0,0,0"]
- Used only when: Enable pressure advance (`enable_pressure_advance`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `adaptive_pressure_advance_overhangs`

**Adaptive pressure advance overhangs**

- Type: list of booleans, one per extruder
- Default: [false]
- Used only when: Enable pressure advance (`enable_pressure_advance`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_pressure_advance`

**Enable pressure advance**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `filament_adaptive_volumetric_speed`

**Filament adaptive volumetric speed**

- Type: list of booleans, one per extruder
- Default: [false]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_flow_ratio`

**Flow ratio**

- Type: list of numbers, one per extruder
- Default: [1]
- Recommended range: 0.8 to 1.2
- Orca limits: 0 to 2
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: More flow fills gaps and can over-extrude. lower: Less flow prevents blobs and can under-extrude

### `filament_max_volumetric_speed`

**Max volumetric speed**

- Type: list of numbers, one per extruder
- Unit: mm3/s
- Default: [2]
- Recommended range: 0.5 to 80
- Orca limits: 0 to none
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: A higher limit allows faster printing while the hotend keeps up. lower: A lower limit slows fast features to protect extrusion

### `filament_shrink`

**Shrinkage compensation XY**

- Type: list of percents, one per extruder
- Unit: %
- Default: [100]
- Recommended range: 95 to 105
- Orca limits: 50 to 150
- Changing it redoes: contours
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `filament_shrinkage_compensation_z`

**Filament shrinkage compensation z**

- Type: list of percents, one per extruder
- Unit: %
- Default: [100]
- Recommended range: 50 to 150
- Changing it redoes: contours
- mimir class: read (not in the catalog: never written)

### `pellet_flow_coefficient`

**Pellet flow coefficient**

- Type: list of numbers, one per extruder
- Default: [0.4157]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `pressure_advance`

**Pressure advance**

- Type: list of numbers, one per extruder
- Default: [0.02]
- Recommended range: 0 to 1.5
- Orca limits: none to 2
- Used only when: Enable pressure advance (`enable_pressure_advance`) is on
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: Higher pressure advance sharpens corners and can gap them if too high. lower: Lower pressure advance rounds and bulges corners

### `volumetric_speed_coefficients`

**Volumetric speed coefficients**

- Type: list of strings, one per extruder
- Default: [""]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
