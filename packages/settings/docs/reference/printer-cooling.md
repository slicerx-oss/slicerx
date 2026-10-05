# Printer: Cooling

12 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `auxiliary_fan`

**Auxiliary fan**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `cooling_filter_enabled`

**Cooling filter enabled**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_pre_heating`

**Enable pre heating**

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

**Fan kickstart**

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fan_speedup_overhangs`

**Fan speedup overhangs**

- Type: boolean
- Default: on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fan_speedup_time`

**Fan speedup time**

- Type: number
- Default: 0
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `part_cooling_fan_min_pwm`

**Part cooling fan min pwm**

- Type: integer
- Unit: %
- Default: 0
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_air_filtration`

**Support air filtration** (develop mode)

- Type: boolean
- Default: on
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_chamber_temp_control`

**Support chamber temp control**

- Type: boolean
- Default: on
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_cooling_filter`

**Support cooling filter**

- Type: boolean
- Default: off
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_multi_bed_types`

**Several bed plates supported**

- Type: boolean
- Default: off
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)
