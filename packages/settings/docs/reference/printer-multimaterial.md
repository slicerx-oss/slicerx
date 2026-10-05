# Printer: Multi material

21 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `cooling_tube_length`

**Cooling tube length**

- Type: number
- Unit: mm
- Default: 5
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `cooling_tube_retraction`

**Cooling tube retraction**

- Type: number
- Unit: mm
- Default: 91.5
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_filament_ramming`

**Enable filament ramming**

- Type: boolean
- Default: on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extra_loading_move`

**Extra loading move**

- Type: number
- Unit: mm
- Default: -2
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_max_nozzle_count`

**Nozzles per extruder** (develop mode)

- Type: list of integers, one per extruder
- Default: [1]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `group_algo_with_time`

**Group objects by print time** (develop mode)

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `high_current_on_filament_swap`

**High current on filament swap**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_load_filament_time`

**Machine load filament time**

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_tool_change_time`

**Machine tool change time**

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_unload_filament_time`

**Machine unload filament time**

- Type: number
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `manual_filament_change`

**Manual filament change**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `master_extruder_id`

**Master extruder id**

- Type: integer
- Default: 1
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `nozzle_flush_dataset`

**Nozzle flush dataset**

- Type: list of integers, one per extruder
- Default: [0]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `physical_extruder_map`

**Physical extruder map** (develop mode)

- Type: list of integers, one per extruder
- Default: [0]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `purge_in_prime_tower`

**Purge into the prime tower**

- Type: boolean
- Default: on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `single_extruder_multi_material`

**One extruder for several materials**

- Type: boolean
- Default: on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_fast_purge_mode`

**Fast purge available** (develop mode)

- Type: boolean
- Default: off
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `support_object_skip_flush`

**Skip flushing between objects**

- Type: boolean
- Default: off
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `tool_change_on_wipe_tower`

**Change tools on the wipe tower**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `toolchange_temperature_drop`

**Temperature drop allowed at a tool change**

How far under its printing temperature a print core may start printing after a tool change. It heats the rest of the way while it prints.

- Type: list of numbers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to 50
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wait_for_temp_on_wipe_tower`

**Wait for temp on wipe tower**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
