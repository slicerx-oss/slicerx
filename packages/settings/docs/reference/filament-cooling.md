# Filament: Cooling

30 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `activate_air_filtration`

**Activate air filtration**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `activate_air_filtration_during_print`

**Activate air filtration during print**

- Type: list of booleans, one per extruder
- Default: [true]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `activate_air_filtration_on_completion`

**Activate air filtration on completion**

- Type: list of booleans, one per extruder
- Default: [true]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `additional_cooling_fan_speed`

**Auxiliary fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [0]
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `additional_fan_full_speed_layer`

**Additional fan full speed layer**

- Type: list of integers, one per extruder
- Default: [0]
- Recommended range: 0 to 1000
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `close_additional_fan_first_x_layers`

**Close additional fan first x layers**

- Type: list of integers, one per extruder
- Unit: layers
- Default: [1]
- Recommended range: 0 to 1000
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `close_fan_the_first_x_layers`

**Fan off for the first layers**

- Type: list of integers, one per extruder
- Unit: layers
- Default: [1]
- Recommended range: 0 to 20
- Orca limits: 0 to 1000
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: The fan stays off longer, which helps adhesion. lower: The fan starts sooner, which cools the first layers

### `complete_print_exhaust_fan_speed`

**Complete print exhaust fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [80]
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `dont_slow_down_outer_wall`

**Dont slow down outer wall**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `during_print_exhaust_fan_speed`

**During print exhaust fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [60]
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_overhang_bridge_fan`

**Enable overhang bridge fan**

- Type: list of booleans, one per extruder
- Default: [true]
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `fan_cooling_layer_time`

**Fan cooling layer time**

- Type: list of numbers, one per extruder
- Default: [60]
- Recommended range: 0 to 1000
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `fan_max_speed`

**Part fan maximum**

- Type: list of numbers, one per extruder
- Unit: %
- Default: [100]
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: More part cooling improves small features and bridges. lower: Less part cooling improves layer bonding

### `fan_min_speed`

**Part fan minimum**

- Type: list of numbers, one per extruder
- Unit: %
- Default: [20]
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: More part cooling improves overhangs and bridges and can weaken layer bonding. lower: Less part cooling improves layer bonding

### `filament_cooling_before_tower`

**Filament cooling before tower**

- Type: list of numbers, one per extruder
- Unit: C
- Default: [10]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_cooling_final_speed`

**Filament cooling final speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [3.4]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_cooling_initial_speed`

**Filament cooling initial speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [2.2]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_cooling_moves`

**Filament cooling moves**

- Type: list of integers, one per extruder
- Default: [4]
- Recommended range: 0 to 20
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `first_x_layer_fan_speed`

**First x layer fan speed**

- Type: list of numbers, one per extruder
- Unit: %
- Default: [0]
- Recommended range: 0 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `full_fan_speed_layer`

**Layer where the fan reaches full speed**

The layer where the part cooling fan reaches full speed. From the first layer with the fan on, the fan and the overhang fan climb evenly up to this layer. 0 turns the climb off.

- Type: list of integers, one per extruder
- Unit: layers
- Default: [0]
- Recommended range: 0 to 50
- Orca limits: 0 to 1000
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `initial_layer_fan_speed`

**Initial layer fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [-1]
- Recommended range: -1 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `internal_bridge_fan_speed`

**Internal bridge fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [-1]
- Recommended range: -1 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `ironing_fan_speed`

**Ironing fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [-1]
- Recommended range: -1 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `overhang_fan_speed`

**Overhang fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [100]
- Recommended range: 0 to 100
- Used only when: Enable overhang bridge fan (`enable_overhang_bridge_fan`) is on
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: More fan on overhangs improves them. lower: Less fan on overhangs can curl them

### `overhang_fan_threshold`

**Overhang fan threshold**

How much a wall must overhang before the overhang fan speed applies. Bridges and overhang walls always get it; at 0% every outer wall does.

- Type: list of enum values, one per extruder
- Default: ["95%"]
- Values: `0%` (Every outer wall), `10%` (10 percent overhang), `25%` (25 percent overhang), `50%` (50 percent overhang), `75%` (75 percent overhang), `95%` (Bridges (95 percent))
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `reduce_fan_stop_start_freq`

**Avoid stopping the fan between layers**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `slow_down_for_layer_cooling`

**Slow printing on short layers to cool them**

- Type: list of booleans, one per extruder
- Default: [true]
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `slow_down_layer_time`

**Minimum layer time**

- Type: list of numbers, one per extruder
- Default: [5]
- Recommended range: 0 to 60
- Orca limits: 0 to 1000
- Used only when: Slow printing on short layers to cool them (`slow_down_for_layer_cooling`) is on
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)
- Effect: higher: Small layers slow down more to cool. lower: Small layers slow down less

### `slow_down_min_speed`

**Slowest speed when cooling a layer**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: [10]
- Recommended range: 1 to 100
- Orca limits: 0 to none
- Used only when: Slow printing on short layers to cool them (`slow_down_for_layer_cooling`) is on
- Changing it redoes: G-code only
- mimir class: edit (may change in a plate override)

### `support_material_interface_fan_speed`

**Support material interface fan speed**

- Type: list of integers, one per extruder
- Unit: %
- Default: [-1]
- Recommended range: -1 to 100
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
