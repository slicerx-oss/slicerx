# Printer: Acceleration, jerk and machine limits

35 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `hotend_cooling_rate`

**Hotend cooling rate**

- Type: list of numbers, one per extruder
- Default: [2]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `hotend_heating_rate`

**Hotend heating rate**

- Type: list of numbers, one per extruder
- Default: [2]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `input_shaping_damp_x`

**Input shaping damp x**

- Type: number
- Default: 0.1
- Recommended range: 0 to 1
- Used only when: Input shaping emit (`input_shaping_emit`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `input_shaping_damp_y`

**Input shaping damp y**

- Type: number
- Default: 0.1
- Recommended range: 0 to 1
- Used only when: Input shaping emit (`input_shaping_emit`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `input_shaping_emit`

**Input shaping emit**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `input_shaping_freq_x`

**Input shaping freq x**

- Type: number
- Unit: Hz
- Default: 0
- Recommended range: 0 to 1000
- Used only when: Input shaping emit (`input_shaping_emit`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `input_shaping_freq_y`

**Input shaping freq y**

- Type: number
- Unit: Hz
- Default: 0
- Recommended range: 0 to 1000
- Used only when: Input shaping emit (`input_shaping_emit`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `input_shaping_type`

**Input shaping type**

- Type: enum
- Default: "Default"
- Values: `Default`, `MZV`, `ZV`, `ZVD`, `ZVDD`, `ZVDDD`, `EI`, `EI2` (2-hump EI), `2HUMP_EI` (2-hump EI), `EI3` (3-hump EI), `3HUMP_EI` (3-hump EI), `DAA`, `Disable` (Off)
- Used only when: Input shaping emit (`input_shaping_emit`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_bed_mass_Y`

**Machine bed mass Y** (develop mode)

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_hotend_change_time`

**Machine hotend change time**

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_acceleration_e`

**Maximum acceleration E**

Maximum acceleration E. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [5000,5000]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_acceleration_extruding`

**Machine max acceleration**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [1500,1250]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (never written)

### `machine_max_acceleration_retracting`

**Machine max acceleration retracting**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [1500,1250]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_acceleration_travel`

**Machine max acceleration travel**

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [0,0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_acceleration_x`

**Maximum acceleration X**

Maximum acceleration X. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [1000,1000]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_acceleration_y`

**Maximum acceleration Y**

Maximum acceleration Y. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [1000,1000]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_acceleration_z`

**Maximum acceleration Z**

Maximum acceleration Z. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s2
- Default: [500,200]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_force_Y`

**Machine max force Y** (develop mode)

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_jerk_e`

**Maximum jerk E**

Maximum jerk E. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [2.5,2.5]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_jerk_x`

**Maximum jerk X**

Maximum jerk X. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [10,10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_jerk_y`

**Maximum jerk Y**

Maximum jerk Y. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [10,10]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_jerk_z`

**Maximum jerk Z**

Maximum jerk Z. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0.2,0.4]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_junction_deviation`

**Machine max junction deviation**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0.01]
- Recommended range: 0 to 0.3
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_printed_mass`

**Machine max printed mass** (develop mode)

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_speed_e`

**Maximum speed E**

Maximum speed E. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [120,120]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_speed_x`

**Highest X speed the machine allows**

Maximum speed X. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [500,200]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (never written)

### `machine_max_speed_y`

**Maximum speed Y**

Maximum speed Y. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [500,200]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_max_speed_z`

**Maximum speed Z**

Maximum speed Z. Written to the G-code when machine limits are emitted.

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [12,12]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_min_extruding_rate`

**Machine min extruding rate** (develop mode)

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0,0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_min_travel_rate`

**Machine min travel rate** (develop mode)

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [0,0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_prepare_compensation_time`

**Extra time allowed for preparation** (develop mode)

- Type: number
- Default: 260
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `max_resonance_avoidance_speed`

**Max resonance avoidance speed**

- Type: number
- Unit: mm/s
- Default: 120
- Recommended range: 0 to no maximum
- Used only when: Resonance avoidance (`resonance_avoidance`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `min_resonance_avoidance_speed`

**Min resonance avoidance speed**

- Type: number
- Unit: mm/s
- Default: 70
- Recommended range: 0 to no maximum
- Used only when: Resonance avoidance (`resonance_avoidance`) is on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `resonance_avoidance`

**Resonance avoidance**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `silent_mode`

**Silent mode** (develop mode)

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
