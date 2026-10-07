# Tool changer simulation in Preview

Preview plays a print move by move. On a printer with more than one tool, the moment the toolhead changes tools is a sequence of its own: travel to the rack or the purge chute, park the tool it carries, pick the next one, come back. This note records what we know about how each supported machine does that, which numbers are measured and which are estimated, and how the simulation uses them. The simulation lives in `packages/ui/viewport/src/toolchanger.ts` (the sequence and the motion model), `packages/ui/viewport/src/toolhead.ts` (the meshes) and `packages/app/src/lib/preview-timeline.ts` (where the changes sit on the playback clock).

Sources are listed per machine. "Measured" means a number that comes from the machine's own profile, firmware configuration or G-code; "estimated" means a value we chose because no source gives it, kept in one place so it can be corrected.

## Bambu Lab H2D (two nozzles, one active at a time)

How it works. The toolhead carries two complete hotends side by side. Only one touches the print: a lifting rail raises the idle nozzle a few millimeters and a flow blocker (a small flap under the nozzles that moves sideways with the switch) covers it so it cannot drip. Switching nozzles happens inside the toolhead; the gantry does not visit a rack. Each nozzle has its own filament path from its AMS. A change between two filaments on the same nozzle is an AMS swap (cut, retract, load, flush), the same as on a single-nozzle Bambu printer.

Where the change happens. The profile's change G-code lifts Z by 3 mm (`G1 Z{max_layer_z + 3.0} F1200`), stops the part fans, sets the flush and cutter parameters (`M620.10`, `M620.11`) and hands over to the firmware with `T[next_filament_id] H[next_hotend]`. After the `T` the G-code resumes at the back of the bed (`G1 Y320 F30000`, `G1 Y295`, `G1 Y265`, then `G1 Z{max_layer_z + 3.0} F3000`), so the firmware leaves the head at the rear, at the purge chute and nozzle wiper. The chute is on the rear left: the profile's fallback purge position is `M620.14 X95.5 Y336` (X 95.5 mm, Y 336 mm, beyond the 320 mm bed depth). Those positions are measured (they are in the profile). The order of the firmware's internal steps (cut, retract, lift and swap the nozzle, load, purge, wipe) is documented by the wiki and reviews but their individual durations are not, so the simulation spreads the documented switch time over them (estimated split).

Numbers.

| Value | Source | Status |
| --- | --- | --- |
| Bed 350 x 320 mm, printable height 325 mm; left nozzle reaches X 0 to 325, right nozzle X 25 to 350 | `extruder_printable_area` in the machine profile | measured |
| Switch time 5.6 s (`machine_switch_extruder_time`), load 26 s, unload 26 s | machine profile; Bambu Studio `GCodeProcessor::process_filament_change` adds the switch time when the extruder changes and unload plus load when the filament in that extruder changes | measured |
| Travel 500 mm/s (`travel_speed`), travel acceleration 9000 mm/s2, max 20000 mm/s2 | machine and process profiles | measured |
| Z lift 3 mm at 1200 mm/min before the change, return at 3000 mm/min | change G-code | measured |
| Chute position X 95.5, Y 336; exit moves Y 320, 295, 265 | change G-code | measured |
| Nozzle spacing 24 mm, idle nozzle lifted 2.5 mm, flow blocker travel 12 mm | no public drawing; chosen to read clearly at Preview scale | estimated |

Sources: machine profile and change G-code template in Bambu Studio 2.8.4 resources (`Bambu Lab H2D 0.4 nozzle template change_filament_gcode.json`); `src/libslic3r/GCode/GCodeProcessor.cpp`, `process_filament_change`; wiki.bambulab.com H2 series pages on the nozzle lifting rail, the nozzle flow blocker and the purge wiper; forum.bambulab.com threads on the flow blocker.

## Bambu Lab H2C (Vortek hotend rack)

How it works. The left nozzle is fixed, as on the H2D. The right side of the toolhead is a bay for a Vortek induction hotend: the hotend carries no heater wiring, a coil in the bay heats it and carries its data. Spare hotends wait on a rack on the right side of the chamber, two rows of three positions, one position of which is empty while a hotend is on the toolhead (six hotends, one on the toolhead plus five on the rack). The rack is motorized: a stepper and belt lift the two rows so the row holding the wanted hotend comes level with the toolhead (the gantry is at a fixed height; the bed moves in Z). A latch actuator in the rack lifts a metal unlocking shaft; combined with the toolhead's own motion this pulls the latch to release the hotend and pushes it back to lock the next one. The firmware parks the current hotend in the lowest numbered empty position, the one closest to the toolhead.

Sequence (from the wiki's workflow page, in its order): unlock the latch; place the hotend from the toolhead in an empty position; take the new hotend; lock the latch. Around that, the same cut, retract, load and flush steps as the H2D, since each hotend keeps its own filament; the AMS retracts the old filament while the hotend swap runs and feeds the new one afterward. Hotends enter the bay from the front, which is why the rack has two rows instead of one long row.

Where the change happens. The change G-code is the H2D's with the hotend id added (`T[next_filament_id] H[next_hotend]`, `M620.11 ... B[current_hotend]`), a cooling target for the hotend that goes back on the rack (`M620.15`), and the same rear exit moves written as `G387 Y320 J1 F10000`, `G387 Y295 J1 F30000`, `G387 Y265 J1 F18000`. The rack's exact coordinates are not published. The right nozzle's printable X ends at 330 mm on the H2C against 350 mm on the H2D, so the rack takes the strip from about X 332 to the right wall. Our rack stands at X 352 mm (22 mm past the bed, so a hotend printing at the right edge clears the parked ones), its three positions at Y 150, 210 and 270 mm (60 mm apart, the rear half of the chamber, in front of the chute's Y), lower row at the toolhead's height and upper row 96 mm above it, which clears the toolhead's cover when the head works the lower row. The head waits 28 mm left of a position while the rows move, so they pass beside it, and after parking it backs off along the front of the rack before it goes to the next position, so it never brushes the hotend it just left. Every position but one holds a hotend: the print's own, then spares the print does not use, with the empty position right after the print's own; the firmware's rule (park in the lowest numbered empty position) then decides where each hotend goes. All of that is estimated and marked as such in the code.

Numbers.

| Value | Source | Status |
| --- | --- | --- |
| Bed 330 x 320 mm; right nozzle X 25 to 330 | `extruder_printable_area` | measured |
| 6 hotends, 2 rows of 3, 1 on the toolhead plus 5 on the rack; rack lifts; latch actuator | wiki, "Introduction to the Workflow of the Induction Hotend Rack" | measured (count and layout), no coordinates |
| `machine_switch_extruder_time` 5 s, `machine_hotend_change_time` 0 s, load 15 s, unload 15 s, `extruder_max_nozzle_count` [1, 6] | machine profile | measured |
| Hotend heat up about 8 s by induction | Tom's 3D, product reviews | reported, not used for timing (the profile's times already cover it) |
| Rack X 352, positions Y 150, 210, 270; upper row 96 mm up; dock approach 28 mm in X, latch stroke 6 mm in Y | no source | estimated |
| Dock moves at 60 mm/s with 2000 mm/s2, travel at profile speed and acceleration | U1's dock speeds used as a reference for the slow part; Bambu publishes none | estimated |

Sources: Bambu Studio 2.8.4 machine profile and change G-code template for the H2C; wiki.bambulab.com/en/h2c/manual/induction-hotend-rack-workflow; toms3d.org, "The H2C is Bambu's 7-hotend patent evasion masterpiece" (2026-01-23); tomshardware.com H2C review; the owner's H2C project (`owner-profiles`), whose change G-code is byte identical to the shipped template.

## Snapmaker U1 (four toolheads, pick and park)

How it works. Four complete toolheads park in a dock across the back of the frame. The carriage drives to the dock, pushes the toolhead it carries into its slot, a mechanical lock releases it, the carriage moves to the next slot, pushes onto the waiting toolhead, the lock engages and it leaves. Steel ball kinematic couplings seat each head in the same place. No separate motor: the lock and release come from the carriage's motion.

Where the change happens. The firmware is Klipper with Snapmaker's additions; the printer's own configuration gives the dock geometry and speeds. Each extruder section carries `xy_park_position` (the dock slot), `y_idle_position`, `horizontal_move_x` (the sideways stroke that locks and releases), `retract_x_dist`, `fast_move_speed`, `slow_move_speed`, `grab_speed`, `switch_accel` and `insertion_buffer_dist`. The slicer's change G-code lifts Z (`G91`, `G1 Z1.5 F600`, 2 mm more in `position[2]`), waits for the next tool's temperature, then `T<n>`; the firmware does the docking.

Numbers.

| Value | Source | Status |
| --- | --- | --- |
| Dock slots at (35.0, 332.2), (102.7, 332.2), (170.2, 332.2), (237.7, 332.2) mm | `xy_park_position` of extruder, extruder1, extruder2, extruder3 | measured |
| `y_idle_position` 250 mm, `horizontal_move_x` 10 mm, `retract_x_dist` 1.5 mm, `insertion_buffer_dist` 5 mm | printer configuration | measured |
| `fast_move_speed` 400 mm/s, `slow_move_speed` 60 mm/s, `grab_speed` 10 mm/s, `switch_accel` 5000 mm/s2 | printer configuration | measured |
| Axis limits X 0 to 271, Y 0 to 335, Z -6 to 275; `max_velocity` 500, `max_accel` 20000, `square_corner_velocity` 8 | printer configuration | measured |
| `machine_tool_change_time` 5 s | Orca machine profile | measured |
| Z lift 1.5 mm plus 2 mm at 600 mm/min | change G-code | measured |
| Swap time about 5 s (maker), 10 to 12 s (independent reviews) | Snapmaker product page; Tom's Hardware and 3DBite reviews | reported; the simulation's own move timing lands at about 6 s plus the profile's 5 s |
| Toolhead body 42 x 38 x 60 mm, dock plate 20 mm deep | no drawing | estimated |

Sources: the Snapmaker U1's Klipper configuration as backed up by a user (github.com/wakuwakumiwaku/U1-printercfg, `printer.cfg`, 2026-10); Snapmaker's firmware source (github.com/Snapmaker/u1-klipper); OrcaSlicer main (`Snapmaker U1 (0.4 nozzle).json`, `fdm_U1.json`); snapmaker.com product page; tomshardware.com and 3dbite.com U1 reviews.

## Prusa XL (up to five toolheads, dock along the back)

How it works. Each toolhead is a complete Nextruder that parks in a dock on the back frame. The carriage drives in front of the dock, pushes the toolhead in, slides sideways so the dock's pins take it and the coupling lets go, and backs out without it; then it drives to the next dock, pushes in, slides sideways the other way to lock that toolhead and pulls it out. A sensor in each dock reports parked and picked; the firmware waits for it after each seat.

Where the change happens. PrusaSlicer's change G-code lifts Z by 2 mm (`position[2] + 2.0`, `M217 Z{max(zhop, 2.0)}` in the start), moves at up to 350 mm/s, waits for the next tool's temperature (`M109 ... T<n>`) and calls `T<n> S1 L0 D0`; the firmware does the docking (Prusa-Firmware-Buddy, `toolchanger_xl.cpp`, `park()` and `pickup()`).

| Value | Source | Status |
| --- | --- | --- |
| Docks at X 25 + 82 i, Y 455 (`DOCK_DEFAULT_FIRST_X_MM`, `DOCK_OFFSET_X_MM`, `DOCK_DEFAULT_Y_MM`) | `toolchanger_utils.h` | measured (factory default; each printer calibrates its own) |
| Safe Y 360 with a tool, 425 without (`SAFE_Y_WITH_TOOL`, `SAFE_Y_WITHOUT_TOOL`) | same | measured |
| Park: in at dock X - 10, unlock at - 9, seat at + 0.5, then the dock X; pick: pre-insert at dock Y - 5, lock at dock X - 11.8 and - 12.8, clear at - 9.9 | `PARK_X_OFFSET_1..3`, `PICK_Y_OFFSET`, `PICK_X_OFFSET_1..3` | measured |
| 50 mm/s at 400 mm/s2 in the dock, 300 mm/s approach, travel 400 mm/s, 200 ms sensor wait | `SLOW_MOVE_MM_S`, `SLOW_ACCELERATION_MM_S2`, `PARKING_FINAL_MAX_SPEED`, `TRAVEL_MOVE_MM_S`, `WAIT_TIME_TOOL_PARKED_PICKED` | measured |
| Toolhead body 54 x 50 x 84 mm, dock panel and pin blocks | product photos (prusa3d.com, 3dwithus.com hands-on) | estimated |

The model: black toolheads with the hotend fan on the front, the side blower, the extruder on top with its orange label and a band in the filament color, hung behind the black carriage; the dock is a perforated black panel with a pin block behind each toolhead. `test/toolhead.test.ts` plays parks and picks across the dock and checks nothing of the head enters the dock or a parked toolhead.

## UltiMaker S3, S5, S7, S6, S8 (two print cores, the right one on the lift switch)

How it works. The head holds two print cores side by side, 22 mm apart. The left core is fixed. The right core rides on the lift switch, a spring loaded ring in the head with a lever that sticks out of the head's right side. The switch bay, a white bracket on the printer's right wall, works the lever: the firmware moves the head so the lever sits in the bay and runs it along the bay, which turns the ring and lowers the right core (to print with it) or lifts it out of the way (to print with the left one). The firmware does the switch on `T`, applies each core's Z offset itself and primes a core the first time it prints with `G280`. It applies no X or Y offset: the slicer writes the right core's moves 22 mm to the left of where it prints, which is why the head in Preview stands 22 mm left of the path while the right core prints.

Where the change happens. The engine writes what CuraEngine 5.13 writes for these machines (`packages/core/src/griffin.rs`, after `GCodeExport::switchExtruder`, `startExtruder` and `writePrimeTrain`, checked against CuraEngine's own output in `packages/settings/tests/ultimaker_gcode.rs`): retract the usual 6.5 mm, then on to the switch length at the switch speed; travel to the leaving core's switching position (Cura's `machine_extruder_end_pos`); lift 2 mm; `G92 E0`, `T`, `G92 E0`; wait for the new core's initial temperature (`M109`), park the old core at standby (`M104 T`); prime (`G280 S1`) the first time, else prime back the switch length beyond the usual retraction; set the printing temperature. Heimdall plays that: the moves the G-code writes, then the firmware's switch, then the wait, then the return.

The firmware's own moves are not published. Cura gives each core a switching position, and on the S5, S7, S6 and S8 the two differ only in Y: X 330, Y 237 for the left core and Y 219 for the right one. Heimdall takes that as the lever's stroke along the bay: the firmware runs the head into the bay, 10 mm to the right of the switching position, moves it along Y from one core's position to the other's while the bay holds the lever's pin, which swings the lever by 40 degrees either way and moves the right core through its whole stroke, then backs out. The lever's length follows from the stroke: 9 mm either side over 40 degrees is a 14 mm lever. On the S3 Cura uses one position for both cores (X 180, Y 180), which is not at the bay. Preview takes the head from there to a bay placed where the S5's sits on its frame: on the right wall at the bed's right edge, 3 and 21 mm in from the back (X 230, Y 187 and Y 169). That place is estimated. The UltiMaker 3, the S3's predecessor, has its two switching positions at the right edge too (X 213, Y 207 and 189).

Numbers.

| Value | Source | Status |
| --- | --- | --- |
| Beds S3 230 x 190 x 200 mm, S5, S7, S6, S8 330 x 240 x 300 mm; flavor Griffin (S3, S5, S7) or Cheetah (S6, S8) | Cura 5.13 `ultimaker_s*.def.json` (`machine_width`, `machine_depth`, `machine_height`, `machine_gcode_flavor`) | measured |
| Right core offset X 22 mm, Y 0 | `machine_nozzle_offset_x`, `_y` of the right extruder definition | measured |
| Switching positions: X 330, Y 237 (left core) and Y 219 (right core); S3 X 180, Y 180 for both | `machine_extruder_start_pos_*`, `machine_extruder_end_pos_*` | measured |
| S3 bay: X 230, Y 187 and Y 169, the S5's positions relative to the bed's back right corner | the S5 and UltiMaker 3 switching positions | estimated |
| Lowered right nozzle 1.5 mm under the left one | `machine_nozzle_head_distance` 2.7 (left) and 4.2 (right) | measured |
| Retraction 6.5 mm at 45 mm/s; switch length 16 mm (AA cores, the heat zone length), 12 mm (BB), 16.5 mm (AA 0.8); switch speed 20 mm/s; prime back at 20 mm/s (15 on the S6 and S8) | `retraction_amount`, `retraction_speed`, `switch_extruder_retraction_amount`, `switch_extruder_retraction_speeds`, `switch_extruder_prime_speed`, resolved through Cura's variant and quality profiles | measured |
| Lift 2 mm before the switch, at 10 mm/s | `retraction_hop_after_extruder_switch_height`, `speed_z_hop` | measured |
| Initial printing temperature 10 degrees under the printing temperature (15 on the S6 and S8 with PLA); standby 100 degrees under it unless the filament sets one | `material_initial_print_temperature`, `material_standby_temperature` in `ultimaker.def.json` and the quality profiles | measured |
| Head outline x -41.4 to 63.3, y -45.8 to 36 mm from the left nozzle; gantry 55 mm over the tip; head bottom 2.7 mm over the left tip | `machine_head_with_fans_polygon`, `gantry_height`, `machine_nozzle_head_distance` | measured |
| X shaft 10 mm, Y shaft 8 mm; four M2.5 x 75 bolts through the housing | S5 repair manual, lift switch spring | measured (sizes the head's height) |
| Lift switch stroke 3 mm (the right core 1.5 mm over the left tip when lifted) | user reports; no UltiMaker figure | estimated |
| Lever 14 mm, 40 degrees either way; the head runs 10 mm into the bay; lever moves at 50 mm/s and 1000 mm/s2 | follows from the measured positions where it can; the rest chosen | estimated |
| Print core 14 x 32 x 60 mm | product photos with the box size (126.7 x 121.3 x 21.5 mm) for scale | estimated |

Cura's own time estimate gives the switch no time of its own (`machine_extruder_change_duration` 0), and the engine follows it; heimdall's switch takes the time of its moves.

What differs from Cura on purpose. Cura plans each idle core's temperature from its heating model (`Preheat.cpp`): the old core goes to whatever temperature it can still come back from in time, and both cores start cooling to their final printing temperature before a switch. SlicerX parks the old core at standby and heats the next one ahead of its switch the way Orca does (`ooze_prevention`, `preheat_time`, from Cura's heat up speed). The header's print time, volumes and extent are SlicerX's own estimate, and `GENERATOR.NAME` is SlicerX. The material GUID is that of UltiMaker's generic profile for the filament type.

Sources: UltiMaker Cura 5.13.0 resources (`definitions/ultimaker*.def.json`, `extruders/ultimaker_s*_extruder_*.def.json`, `variants/ultimaker_s*_*.inst.cfg`, `quality/ultimaker_s*/`, `materials/generic_*.xml.fdm_material`); CuraEngine 5.13.0 (`src/gcodeExport.cpp`), run on the same plate for the reference G-code; the UltiMaker S3 and S5 user manual (lift switch calibration); the S5 repair manual, lift switch spring; the UltiMaker 3 print head assembly repair manual; the print core AA product data sheet and its photos.

The model: the white head after the repair manual photos. The front fan bracket hangs in front of the cores with its dark grille and white slats; the side fan brackets reach the outline's full width with their vents, and the ducts under them point at the nozzles; the bearing housing closes the top with the two Bowden clamps; the cable cover and the head cable sit at the back. The cores stand in a cavity open below, each a brass nozzle and heater block, the black housing with its label, the finned heat sink in its black frame with the chip's contacts on the back, the clear top plate and the steel feed tube. The Bowden tubes show each core's filament. The lever swings on the right wall; the bay is a white block with a slot for the lever's pin. `test/ultimaker.test.ts` plays both switches and checks that no two parts of the head overlap (a print core and the lever are each one assembly), that nothing of the head enters the bay, that the pin stays in the slot while the head runs along it, and that the right core moves through its whole stroke.

## Bambu Lab A1, A1 mini, X1, P1, H2S (one nozzle, filament swap at the chute)

How it works. One nozzle; the AMS swaps the filament. The change G-code takes the head to the cutter, hands the swap to the firmware, flushes the old filament out at the purge chute and runs the nozzle over the wiper. Preview plays that as a change of its own (`filament-swap` in `toolchanger.ts`): lift, to the cutter, cut, to the chute, unload and load with the flush, the wipe and exit moves, back. The firmware's seconds are the profile's unload and load times (`ChangeClock`, as for the H2D's filament changes), spent 15 percent on the cut and the rest on the load (an estimated split). The flush is the one the change G-code extrudes between `; FLUSH_START` and `; FLUSH_END`, so the blob plays as on the H2D.

Numbers.

| Value | Source | Status |
| --- | --- | --- |
| A1: cut at X 267, flush at X -48.2, Y 128, wipe to X -38.2 and back | change G-code (`G1 X267`, `G1 Y128`, `G1 X-38.2`, `G1 X-48.2`), start G-code (`G1 X-48.2` before the first flush) | measured |
| A1 mini: cut at X 180, flush at X -13.5, Y 90, wipe to X -3.5 and back | change and start G-code, the same moves | measured |
| X1, X1E, P1P, P1S: cut at X 70, Y 265; flush at X 54, Y 265; wipe right along Y 265 to X 165, then Y 256 | change G-code (`G1 X70`, `G1 Y265`, the wipe moves after the flush), start G-code (`G1 X54`, `G1 Y265` before its flush) | measured |
| H2S: the H2 family's chute at X 95.5, Y 336 and the H2D's exit moves (Y 320, 295, 265) | the H2C template's `M620.14`; the H2S change G-code's exit moves | measured |
| The chute's mouth and wiper blade, the H2D's turned to face the way the head leaves; on the X1 and P1 the mouth starts 2 mm behind the bed, on the A1 mini 2 mm left of it | no public drawing | estimated |
| A1, A1 mini: their own chute body, a low light gray shaft 22 mm deep, open below, with its mouth 2 mm under the bed's surface (24 by 22 mm on the A1, 34 by 26 mm on the mini) and the wiper blade on a block at the bed side, not the H2 family's shaft | Bambu's product photos and wiki images; no drawing | estimated, to confirm on the owner's A1 and A1 mini |

The A1 and A1 mini move the bed in y and the gantry in z. Their chute stands on the frame, so Preview, which holds the bed still, keeps it still at its flush spot at bed level: the change moves the bed to that y before it flushes, so the head meets the chute there. The P2S's change G-code hands the cut, the flush and the wipe to firmware macros (`G150`) and writes no position, so Preview has no chute for it and plays its swaps in place, as before.

Sources: Bambu Studio 2.8.4 machine profiles and their start and change G-code templates (`Bambu Lab A1 0.4 nozzle template change_filament_gcode.json` and the others, mirrored in `packages/profiles/gcode.json`); the bed models (`bbl-3dp-X1.stl`, `bbl-3dp-A1M.stl`), which the chutes stay clear of.

## Timing model

Playback time comes from the layer times the engine writes into the preview buffer. Those cover the print moves of a layer. The change itself is added by the app's timeline from the same rules the engine uses for the G-code's time estimate (`packages/core/src/gcode.rs`, `tool_change_time`, after Orca 2.4.2 `GCodeProcessor::process_T` and Bambu Studio `process_filament_change`):

- Same extruder, other filament: unload time plus load time.
- Other extruder: the switch time (`machine_tool_change_time`, or Bambu's `machine_switch_extruder_time` when the profile has only that), plus load time if the extruder is empty, or unload plus load if it last held a different filament.

That gives 5.6 s per switch on the H2D, 5 s plus 30 s of unload and load per hotend swap on the H2C, 5 s on the U1, and nothing on the UltiMaker S series, whose profiles give the switch no time of its own. The simulation's moves are timed with the printer's own travel speed and acceleration (trapezoidal profiles, no instant velocity changes) and its dock speeds; where the profile's documented time is longer than the moves, the difference is spent where the machine spends it (cutting, loading and flushing at the chute on Bambu printers, waiting on temperature on the U1). Where it is shorter, the moves win, so the head never teleports.

## What the engine got wrong before this work

- `tool_change_time` in `gcode.rs` counted a printer with several nozzles only through `machine_tool_change_time`. Bambu profiles name the same number `machine_switch_extruder_time`, so an H2D or H2C change cost 0 s, and a filament swap on one of its two nozzles skipped the 26 s (H2D) or 15 s (H2C) load and unload. The G-code estimate (`printtime.rs`) had the same gap. Both now follow Bambu Studio's rule above, with tests.

## The models

`toolhead.ts` draws the machines after their product photos (Bambu Lab's H2C store and wiki pages, Snapmaker's U1 toolhead pages and hands-on photos), low poly, every part a separate solid in millimeters with the nozzle tip at the origin. Parts that meet only touch, so no two faces share a plane and nothing flickers.

- H2D and H2C head: a brushed silver upper cover with a light strip and the logo plate, over a black lower body. The left hotend sits behind the black front with the nozzle display (its chip shows the printing filament's color) and the orange "hot" plate; fan housings sit at the sides. The H2D's right side mirrors the left. On the H2C the right side is an open bay: a Vortek hotend plugs in from below, a front wall covers its head block, and the bay is open at the back, the right and below, so the hotend leaves it by any move the sequence makes.
- Vortek hotend: 58 mm tall, a slim black shaft with a rounded nozzle end and a silver tip, a steel collar at z 30 the rack's fork grips, and a head block in the filament's color under a black cap.
- H2C rack: a black frame with two posts and a top bar; each row has a rail with three holders, each holder a black block with a white light and a fork under it.
- U1 toolhead: a black body with the nozzle under its sock, the orange lever on the side, the extruder motor at the back and the coupling face at the front (fan opening, label, the yellow line, the steel pins). It hangs on the back of the white carriage with the orange badge, and parks in a dock of black brackets on a beam along the back.

- Printers with one nozzle get their family's head (`heads.ts`, `headFor` maps every profile id): Bambu X1 (with the Micro Lidar) and P1/P2 (light gray front with the round fan), A1 and A1 mini (a low, wide light gray head with the extruder window and the cable chain at its left side, estimated from product photos; heimdall checks only its nozzle until the head is measured, so the estimate never blocks a print; sources under "A1 head sources"), H2S (the H2 head with one hotend), the Prusa Nextruder and MINI+, the Voron Stealthburner (and the SV08's blue one), Creality K1, K2, Ender-3 V3 and the Sprite heads, Elegoo Centauri Carbon and Neptune 4, Anycubic Kobra, QIDI, the Snapmaker printing module, and a tidy generic head for the rest (the FLSUN delta).

Clearances: the head stays 17 mm either side of its nozzles in y, 10 mm right of the right nozzle in x and under 92 mm, the rack's other row is 96 mm away, holders and forks stay below the bay's front wall. `test/toolhead.test.ts` checks that no part of a head overlaps another, plays whole changes on the H2C (both rows) and the U1 and checks that no part of the moving head enters the rack or dock, that parked tools sit at the positions the sequence parks them in, and that the rack keeps what a change left it until the next one.

## A1 head sources

Searched 2026-10-06 for the A1 and A1 mini toolhead's dimensions. No official drawing or measurement of the head's width, depth or height was found, so heimdall's collision envelope for both comes from the machine profiles alone and the drawn head (`heads.ts`, estimated from product photos) is for Preview only.

| Value | Source | Status |
| --- | --- | --- |
| `extruder_clearance_max_radius` 73 mm, `extruder_clearance_height_to_rod` 25 mm, `extruder_clearance_dist_to_rod` 56.5 mm, `nozzle_height` 4.76 mm; `extruder_clearance_height_to_lid` and `printable_height` 256 mm (A1), 180 mm (A1 mini) | Bambu Studio machine profiles `Bambu Lab A1 0.4 nozzle.json` and `Bambu Lab A1 mini 0.4 nozzle.json` (github.com/bambulab/BambuStudio, master, `resources/profiles/BBL/machine`), read 2026-10-06 | official |
| `extruder_clearance_radius` 57 mm | the same profiles' parent, `fdm_bbl_3dp_001_common.json` | official |
| What the values mean: "the max clearance radius around the tool head", "the height between the build plate to the lower rod at z=0"; "the clearances in different directions of the tool head are actually different", so Bambu Studio asks for `extruder_clearance_max_radius` between objects | Bambu Lab Wiki, "Print-by-object" (wiki.bambulab.com/en/software/bambu-studio/sequent-print), read 2026-10-06 | official; no per-direction numbers |
| Hotend length 47.3 mm (A1 series) | Bambu Lab store, "Bambu Hotend - A1/A2" (us.store.bambulab.com/products/bambu-hotend-a1-a2), read 2026-10-06 | official; length only, no width |
| A STEP model of the whole A1, measured on an A1 bought in May 2024, most dimensions within 0.2 mm (vajojajo) | MakerWorld model 770920, "Bambulab A1 CAD step model" | measured by a third party; behind a sign-in and a bot check, not read |
| About 6.5 mm from the bed to the A1 mini's part cooler while printing | Bambu Lab forum, "Spacing needed when using by object printing is too conservative", a user's estimate, 2024-10-24 | estimate; not used |

So heimdall holds the A1 and A1 mini to the profile: the nozzle, a 3.2 mm column (the nozzle every drawn head shares) up to `nozzle_height` (4.76 mm), is the only part of the head that can block a print, `extruder_clearance_max_radius` (73 mm) makes a close call the person is asked about, and the rod (25 mm, 56.5 mm either side) and lid rules hold above. When the owner's A1 and A1 mini are measured, or the measured CAD can be read, the head's boxes can replace this.

## Scrubbing

The Time slider follows the drag continuously: the handle stays where the pointer puts it, inside a tool change too, and the view updates on every step. Tool changes are short against a whole print (a 35 s change in a 3 hour print is about 2 px of slider), so when the changes together take less than 15 percent of the print the track gives them 15 percent of its length and runs proportionally faster over the printing (`sliderOf` and `timeOfSlider` in `packages/app/src/lib/preview-timeline.ts`). A drag through a change then plays it in slow motion; the readout always shows the print's own time, and the arrow keys step by print seconds.

## Purge

On the Bambu Lab printers that flush at a chute, Preview plays the flush of each change: a blob grows from the nozzle while the new filament pushes the old one out, the head leaves over the wiper, the wiper takes the blob and it drops down the chute. The playback bar reads the grams of the purge in progress and of the print up to there. The code is `packages/ui/viewport/src/purge.ts` (the flush reader, the timing, the blob and the chute) and `packages/app/src/workspaces/preview/purge-data.ts` (matching the flushes to the timeline's changes); the bar's readout is in `purge-view.ts`.

Where the flush comes from. The app reads the G-code the engine wrote for the slice, between the last move before each change and the first move after it (the preview's moves carry their G-code lines; a preview without line numbers is split at the tool commands). In those lines:

- X1, P1 and A1 extrude the flush themselves: the `G1 E` moves between `; FLUSH_START` and `; FLUSH_END` of the change G-code, in M83 or M82 with G92 followed.
- H2D and H2C hand the flush to the firmware (`M620.10 A1 ... L<flush_length>`) and write it as virtual moves for the time estimate: `;VG1 E... F...` between `; VFLUSH_START` and `; VFLUSH_END`. The reader sums those, and skips the `;VG1` deretract lines outside the block. Without them it takes the length from `M620.10 A1`.

The length is the engine's `flush_length` (`tower.rs`, `tool_change_vars`, after Orca: the flush matrix entry times the multiplier, less the new filament's grab length), counted from the filament the new filament's nozzle holds. Volume is that length times the filament's cross section (`filament_diameter`), grams are the volume times `filament_density` of the new filament, both from the G-code's header. With both filaments put on the left nozzle by hand (two Layered X on an H2D, deep orange and deep blue), a blue to orange change flushes 209.5 mm of filament, 504 mm3, 0.64 g, and the 420 changes come to 218 g.

Which nozzle holds what. A filament change on one nozzle purges from the old filament to the new one. A switch to a nozzle or a rack hotend that already holds the new filament flushes nothing: the change G-code gets `L0` and empty virtual moves, so Preview plays the switch without a blob. That is the H2D and H2C default for a two-color plate, where the filament map (below) puts one filament on each side.

## Filament map and tool change purge

Which nozzle prints each filament. On the H2D and H2C each extruder has its own AMS, so a filament can go to either side. The engine picks the side the way Bambu Studio does with `filament_map_mode` "Auto For Flush" (`ToolOrdering::get_recommended_filament_maps`, `FilamentGroup::calc_group_by_enum`): it tries every split of the plate's filaments between the two extruders, orders each layer one extruder's filaments after the other's (`reorder_filaments_for_minimum_flush_volume`, the extruder that printed last goes first), and keeps the split with the lowest score, flush volume weighted at Bambu Studio's 0.4536 seconds per mm3 plus the change time from the clock above. A filament whose parts reach past one extruder's printable area (`extruder_printable_area`) stays off it, and the master extruder takes a small penalty when it ends up with fewer than half the filaments. On the H2C each filament on the right extruder gets a hotend of its own from the rack while there are hotends, so changes between them are hotend swaps with no flush. `filament_map_mode` Manual takes `filament_map` as given. The code is `packages/core/src/nozzles.rs`; the map goes into the settings the G-code is written from (`filament_map`, `filament_nozzle_map`), so the change G-code, the configuration block and the time estimate read it, and the slice report carries it as `filamentMap`. For a two-color plate with a change on every layer the engine picks Bambu Studio's answer, `2 1`: filament 1 on the right (master) nozzle, filament 2 on the left.

In the app, the Filament block lists the nozzle of each filament in use on these printers. It shows the slicer's pick after a slice; choosing a nozzle for one filament sets the plate's map by hand (all filaments, the rest where they print now), and "Pick nozzles automatically" goes back to the slicer. The plate's map goes to the engine as `filament_map_mode` Manual and `filament_map`, and into the project file and the `.gcode.3mf` as Bambu Studio writes it: `filament_map_mode` and `filament_maps` in each plate's `model_settings.config` entry, `filament_maps`, each filament's `group_id` (its nozzle) and one `<nozzle>` per nozzle in use in `slice_info.config`, `filament_map` and `filament_map_mode` in `project_settings.config`. Bambu Studio projects with a manual map open with it.

What the tower takes for a change. The engine follows each machine's own slicer:

- H2D and H2C (Bambu Studio 2.8.2, `Print::_make_wipe_tower`, `WipeTower::plan_toolchange`, `nozzle_change_new`): the new filament primes `filament_prime_volume`, or `filament_prime_volume_nc` after a hotend swap; when the nozzle changes, the old nozzle first prints `filament_change_length` (`_nc` for a hotend swap) mm of filament on the tower in 1 mm wide lines at its ramming flow. The flush goes to the chute and only when the nozzle held another filament.
- Snapmaker U1 (OrcaSlicer 2.4.2, `WipeTower2`): each change wipes `prime_volume`, the layer's first wipe cut by what finishing the tower layer extrudes anyway, down to `filament_minimal_purge_on_wipe_tower` (`save_on_last_wipe`, measured on the tower as first planned, which is then sized for the cut wipes).
- Prusa XL (PrusaSlicer 2.9.6, `WipeTower::extract_wipe_volumes`): the flush matrix applies only to a single nozzle, so each change wipes `filament_minimal_purge_on_wipe_tower` in whole rows at the infill speed, after the old head rams `filament_multitool_ramming_volume` at `filament_multitool_ramming_flow`; the wipe finishes the ramming's row first, as PrusaSlicer's does.

Printers with one nozzle keep their purge as before, byte for byte.

Against the reference slicers on the same plate (two X marks, one per filament, 0.2 mm layers, 427 layers, a change on every layer; the reference slicer's own prime and ramming values on both sides; time is the tower's extruding moves, length over feed rate, as Preview's legend counts it):

| Printer | Reference | Tower mm3 (reference, before, now) | Tower time s (reference, before, now) |
| --- | --- | --- | --- |
| H2D | Bambu Studio 2.8.2, map `2 1` | 21,625, 23,481, 20,716 | 2,889, 3,901, 3,028 |
| H2C | Bambu Studio 2.8.2, map `2 1` | 21,625, 23,481, 20,716 | 2,889, 3,901, 3,028 |
| Snapmaker U1 | OrcaSlicer 2.4.2 | 11,270, 17,201, 10,992 | 2,239, 2,789, 2,057 |
| Prusa XL 5T | PrusaSlicer 2.9.6 | 17,373, 26,715, 17,591 | 2,015, 4,707, 2,010 |

Before, the H2D and H2C put both filaments on the left nozzle and flushed about 82 m of filament into the chute (the print estimate was 11.5 hours against Bambu Studio's 4.2). `packages/settings/tests/toolchanger_tower.rs` checks the tower per layer against these references within 10 percent, and the maps and flushes.

The U1's change G-code builds its `T` command in a `{ }` block of several statements. Orca's placeholder parser writes every expression statement of such a block, and the engine wrote only the last one, so the U1 never changed heads. The engine now writes them all, and like Orca it adds the tool command itself when a profile's change G-code selects no tool.

Where our profile data differ from the makers' slicers: a slot left at generic PLA on the H2D has no `filament_prime_volume` of its own, so it primes the default 45 mm3 where Bambu Studio's Bambu PLA Basic primes 30; the H2C has no resolved process in our data yet, so its tower settings are SlicerX's own; and Orca's Prusament PLA for the XL rams 5 mm3 where PrusaSlicer's rams 10.

Numbers.

| Value | Source | Status |
| --- | --- | --- |
| Flush length per change | the change G-code the engine wrote (`;VG1` in the VFLUSH block on H2; `G1 E` in the FLUSH block on X1, P1, A1) | measured |
| Flush pace | the feed rates of those moves (`F`) | measured |
| Volume, grams | `filament_diameter`, `filament_density` in the G-code header | measured |
| When the flush runs inside the change | at the end of the simulation's load dwell, ending as the head starts the `G1 Y320` wipe move | estimated (the firmware's step durations are not published) |
| Chute mouth 34 by 30 mm, 26 mm under the nozzle; wiper blade 12 mm wide at the nozzle's height, 12 mm in front of the purge spot | no drawing | estimated |
| Blob shape: a pendant of 0.55 mm strand coiled at 1.2 mm pitch, sagging as it grows | chosen to read as a real purge | estimated, but its volume is exact |
| Color mix: old color first, threads of the new along the coil, clean by the end of the flush | how a purge looks | estimated |
| The fall: free fall at 9810 mm/s2 after the wiper catches the blob, a 70 mm/s flick back into the chute | physics; the flick is estimated | mixed |

The blob. It hangs from the nozzle tip and holds exactly the volume flushed so far (the mesh is scaled across its axis to the volume; `test/purge.test.ts` checks it). The first plastic out sits at the bottom, the last at the nozzle, so the color runs from the old filament at the bottom to the new one under the nozzle. When the head leaves forward over the wiper, the blob moves with it until its front meets the blade, then falls. Its state is a pure function of the seconds into the change, so a scrub forward and back lands on the same frame; the test sweeps whole changes on the H2D and the H2C and checks that the blob never enters the head, the chute or the rack and the head never enters the chute.

Not yet played: X1, P1 and A1 changes. Their flushes are read, but a printer with one nozzle has no change sequence in the timeline yet, so there is no trip to the chute to play them in.
