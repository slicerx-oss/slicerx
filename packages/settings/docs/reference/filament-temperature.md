# Filament: Temperature

27 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `activate_chamber_temp_control`

**Control chamber heating**

- Type: list of booleans, one per extruder
- Default: [false]
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `chamber_minimal_temperature`

**Chamber minimal temperature**

- Type: list of integers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to 1500
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `chamber_temperature`

**Chamber temperature**

- Type: list of integers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to 80
- Orca limits: 0 to 1500
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: A warmer chamber reduces warping on ABS and similar materials. lower: A cooler chamber suits PLA

### `cool_plate_temp`

**Bed temperature on the Cool Plate**

- Type: list of integers, one per extruder
- Unit: C
- Default: [35]
- Recommended range: 0 to 60
- Orca limits: 0 to 300
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: A hotter cool plate improves adhesion. lower: A cooler cool plate lowers adhesion

### `cool_plate_temp_initial_layer`

**Cool plate temp initial layer**

- Type: list of integers, one per extruder
- Unit: C
- Default: [35]
- Recommended range: 0 to 120
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `eng_plate_temp`

**Bed temperature on the Engineering Plate**

- Type: list of integers, one per extruder
- Unit: C
- Default: [45]
- Recommended range: 0 to 120
- Orca limits: 0 to 300
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: A hotter engineering plate improves adhesion and limits warping. lower: A cooler engineering plate raises warping risk

### `eng_plate_temp_initial_layer`

**Eng plate temp initial layer**

- Type: list of integers, one per extruder
- Unit: C
- Default: [45]
- Recommended range: 0 to 300
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_flush_temp`

**Filament flush temp**

- Type: list of integers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to 1500
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_flush_temp_fast`

**Filament flush temp fast**

- Type: list of integers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to 1500
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_pre_cooling_temperature`

**Filament pre cooling temperature**

- Type: list of integers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_pre_cooling_temperature_nc`

**Filament pre cooling temperature nc**

- Type: list of integers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to no maximum
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_preheat_temperature_delta`

**Filament preheat temperature delta**

- Type: list of numbers, one per extruder
- Unit: C
- Default: [0]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_tower_interface_print_temp`

**Filament tower interface print temp**

- Type: list of integers, one per extruder
- Unit: C
- Default: [-1]
- Recommended range: -1 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `hot_plate_temp`

**Bed temperature on the High Temp plate or smooth PEI**

- Type: list of integers, one per extruder
- Unit: C
- Default: [45]
- Recommended range: 0 to 120
- Orca limits: 0 to 300
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: A hotter bed improves adhesion and can warp the first layers upward if too hot. lower: A cooler bed lowers adhesion

### `hot_plate_temp_initial_layer`

**Hot plate temp initial layer**

- Type: list of integers, one per extruder
- Unit: C
- Default: [45]
- Recommended range: no minimum to 300
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `idle_temperature`

**Idle temperature**

- Type: list of integers, one per extruder
- Unit: C
- Default: [0]
- Recommended range: 0 to 1500
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `nozzle_temperature`

**Nozzle temperature**

- Type: list of integers, one per extruder
- Unit: C
- Default: [200]
- Recommended range: 150 to 350
- Orca limits: 0 to 1500
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: A hotter nozzle flows more freely and bonds layers better, with more stringing. lower: A cooler nozzle strings less and can under-extrude

### `nozzle_temperature_initial_layer`

**Hotend temperature for the first layer**

- Type: list of integers, one per extruder
- Unit: C
- Default: [200]
- Recommended range: 150 to 350
- Orca limits: 0 to 1500
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `nozzle_temperature_range_high`

**Nozzle temperature range maximum**

- Type: list of integers, one per extruder
- Unit: C
- Default: [240]
- Recommended range: 0 to 1500
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `nozzle_temperature_range_low`

**Nozzle temperature range minimum**

- Type: list of integers, one per extruder
- Unit: C
- Default: [190]
- Recommended range: 0 to 1500
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `supertack_plate_temp`

**Bed temperature on the SuperTack plate**

- Type: list of integers, one per extruder
- Unit: C
- Default: [35]
- Recommended range: 0 to 80
- Orca limits: 0 to 120
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `supertack_plate_temp_initial_layer`

**Supertack plate temp initial layer**

- Type: list of integers, one per extruder
- Unit: C
- Default: [35]
- Recommended range: 0 to 120
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `temperature_vitrification`

**Temperature vitrification**

- Type: list of integers, one per extruder
- Unit: C
- Default: [100]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `textured_cool_plate_temp`

**Bed temperature on the Textured Cool Plate**

- Type: list of integers, one per extruder
- Unit: C
- Default: [40]
- Recommended range: 0 to 60
- Orca limits: 0 to 300
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)

### `textured_cool_plate_temp_initial_layer`

**Textured cool plate temp initial layer**

- Type: list of integers, one per extruder
- Unit: C
- Default: [40]
- Recommended range: 0 to 120
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `textured_plate_temp`

**Bed temperature on textured PEI**

- Type: list of integers, one per extruder
- Unit: C
- Default: [45]
- Recommended range: 0 to 120
- Orca limits: 0 to 300
- Changing it redoes: G-code only
- mimir class: guarded (always shown in the diff; approval needed outside the filament range; refused past printer limits)
- Effect: higher: A hotter textured plate improves adhesion. lower: A cooler textured plate lowers adhesion

### `textured_plate_temp_initial_layer`

**Textured plate temp initial layer**

- Type: list of integers, one per extruder
- Unit: C
- Default: [45]
- Recommended range: 0 to 300
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
