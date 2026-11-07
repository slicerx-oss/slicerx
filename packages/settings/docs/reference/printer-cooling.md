# Printer: Cooling

13 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `auxiliary_fan`

**Auxiliary fan**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `chamber_cooling_mode`

**Chamber cooling mode**

- Type: integer
- Default: none (the slice works it out when nothing sets it)
- Recommended range: 0 to 2
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `cooling_filter_enabled`

**Cooling filter**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_pre_heating`

**Preheat before a nozzle change**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fan_direction`

**Fan direction** (develop mode)

- Type: enum
- Default: "undefine"
- Values: `undefine` (Not set), `left` (Left), `right` (Right), `both` (Both)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fan_kickstart`

**Fan kick-start time**

- Type: number
- Unit: s
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fan_speedup_overhangs`

**Fan speed-up for overhangs only**

- Type: boolean
- Default: on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fan_speedup_time`

**Fan speed-up time**

- Type: number
- Unit: s
- Default: 0
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `part_cooling_fan_min_pwm`

**Lowest part cooling fan speed**

- Type: integer
- Unit: %
- Default: 0
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_air_filtration`

**Has air filtration** (develop mode)

- Type: boolean
- Default: on
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_chamber_temp_control`

**Has chamber temperature control**

- Type: boolean
- Default: on
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_cooling_filter`

**Has cooling filter**

- Type: boolean
- Default: off
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_multi_bed_types`

**Supports several bed plates**

- Type: boolean
- Default: off
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)
