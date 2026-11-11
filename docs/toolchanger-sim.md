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

heimdall. The H2C's routes in `head-shapes.json` go by hotend: 0 is the left nozzle and 1 to 6 are the six hotends the right extruder takes, the same ids the engine's filament map gives each filament. The engine maps each filament to its hotend before it looks a route up, so a change between two filaments on two rack hotends visits the rack, and a change between two filaments on one hotend, or between the nozzles when the hotend in the head is the one wanted, stays at the chute (route `0-0`, or a route the same as `0-1`), whatever the filament numbers are. Rack positions still come from one fixed history: each route starts with the old hotend in the head, after one change from hotend 1 to it, and the firmware's choice of empty position follows from that. Over a long print the positions hotends end up in can differ from the route's, so the stops at the rack are the rack's envelope rather than the exact slot.

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

## IDEX: Snapmaker J1 (two carriages on one X beam)

How it works. Two complete carriages, each with its own hotend and filament, ride one X beam. One prints while the other rests at its own end of X: T0 at the left, T1 at the right. On a change the printing carriage goes to its end and parks, and the other one leaves its end for the next move. The J1 does both at once: the maker's blog says the second head moves in as the first leaves, and the change G-code calls it a quick switch (`M2000 S200 V[travel_speed] A[travel_acceleration]`), then waits for the new nozzle's temperature (`M109 T[next_extruder] ... C3 W1`). Preview plays that as `idex-park` in `toolchanger.ts`: lift by the z hop, one move in which the new carriage comes from its end to the next move while the old one runs to its end, the temperature wait, and down. Both carriages share Y and Z. A printer the catalog lists as IDEX but whose profile has no switch of its own parks the old carriage first and then brings the new one in (estimated). Two filaments on one carriage swap in place. Preview never sends an IDEX head to a purge chute.

Which printers get it. `kindOf` reads the catalog's kinematics (`printers.json`, `idex`) before it counts nozzles, so the J1's two nozzles are two carriages, not the H2D's head. An IDEX printer whose settings have one extruder (the Sovol SV04 today, which has no machine profile and slices with manual swaps) plays no change. The Snapmaker Artisan's dual extrusion module is neither IDEX nor the H2D's head, and plays no change until its mechanism is checked.

Not played. Duplication and mirror modes print with both carriages at once, each its own copy, so there is no change to play. Once a slice is done, the app reads the lines of its G-code before the first move (the rendered start G-code, the same way the purge reader reads the lines it needs) and takes the mode from the last `M605` outside a comment: `S2` duplicates, `S3` mirrors, any other mode clears it, the rule the engine's copy check uses. The J1's start G-code writes `M605 S2 X162 R0` for a plate named `IDEXDupl` or `IDEXCopy`, `M605 S3` for `IDEXMirr` and `M605 S4` (backup, one carriage at a time, changes play as usual) for `IDEXBack`. In a copy mode `toolChangerSpec` gets `copy` in its hints and returns no changer for `idex-park`, so the timeline has no changes and Preview draws the printer's one head, as for any printer without a changer (the second carriage and its copy are not drawn). Until the lines are read (a moment after the slice) the print plays as a normal one.

Drawing. Two of the printer family's own heads (the Snapmaker printing module on the J1; the generic head where a family has none), each on its own carriage, and a rail behind them from one parked carriage's outer side to the other's. The idle carriage stands at its end; the shadow follows the printing one. heimdall's collision data (`head-shapes.json`) keeps the J1's two family heads with no changer route, as before.

| Value | Source | Status |
| --- | --- | --- |
| Printable X 0 to 324 mm, Y 0 to 200 mm; travel acceleration 10000 mm/s2; no tool change time | J1 machine profile (`packages/profiles/machine.json`) | measured |
| T0 rests at the left end, T1 at the right; both carriages move at once on a change | start G-code (T0 primes toward X 0, T1 toward X 324, then `G28 X`); change G-code (`M2000`); Snapmaker blog | measured (sides); reported (simultaneous move) |
| Parked nozzle one carriage width (50 mm) outside the printable X: X -50 and X 374 on the J1 | no source | estimated |
| Lift by the process z hop (0.4 mm on the J1) | no lift in the change G-code | estimated |
| Temperature wait: the profile's change time, at least 0.8 s | `M109 ... C3 W1` in the change G-code; the profile gives 0 s | estimated |
| Other IDEX printers: the old carriage parks before the new one comes in | no source | estimated |
| Copy modes: `M605 S2` duplicates, `M605 S3` mirrors, `M605 S4` is backup | the J1's start G-code writes all three, with its own comments naming each mode | measured |

Sources: the J1 machine profile and its start and change G-code (`packages/profiles/machine.json`, family `maker_snapmaker_j1` in `packages/profiles/gcode.json`); snapmaker.com/blog/snapmaker-j1-fast-3d-printer; `packages/settings/profiles/printers.json` (kinematics).

## Klipper tool changer (StealthChanger style, docks on the front top frame)

How it works. Each tool is a whole toolhead that hangs on a shuttle on the carriage. The docks hang from the front top frame. To drop a tool the head runs along X to its dock at the safe Y, rises to the dock height and follows the dock path, relative to the tool's park point: in over the dock (Y +9.5, Z +4), down onto it (Y +9.5, Z +2), forward (Y +5.5), seated at the park point (Y 0, Z 0, slow), then the head drops 10 mm and unhooks from the tool (Z -10), and pulls back clear without it (Y +16). It runs along X behind the docks to the next one and picks that tool by the same path in reverse, then back to the safe Y. Preview plays that as `klipper-dock` in `toolchanger.ts`, then waits for the new tool's temperature (the profile's change time, at least 0.8 s), returns to the next move and comes down. On a Voron 2.4 the gantry rises to the docks; on a Trident the bed drops. Preview shows the head at the same bed coordinates either way.

Which printers get it. A Klipper printer (G-code flavor `klipper`) with two or more nozzles that is declared a tool changer. It is declared only when setup's Moonraker connection test finds `tool <name>` sections in Klipper's config; setup then counts a tool and a nozzle per dock and keeps the docks with the printer (`printerDocks`). Setup has no way yet to mark a hand-added generic Klipper printer as a tool changer. A stored hand-added record with `filamentSystem: 'toolchanger'` also plays it, but setup writes that only from the catalog.
The Snapmaker U1 and the Prusa XL keep their own kinds. A Klipper printer with two or three nozzles and no declaration plays as before.

Measured or estimated. When the printer's config gives a value Preview uses it as measured: each tool's park point (`params_park_x`, `params_park_y`, `params_park_z`), the safe Y (`params_safe_y`) and the dock path (`params_sc_path`, else `params_path`), each from the tool's section, else from the `[toolchanger]` defaults. A value that does not read as a number, a park point missing one axis, or a path with a step missing a number is dropped, and Preview estimates that value instead. With nothing measured the whole dock is estimated from the nozzle count.

Drawing. The generic head (heads.ts) as each tool, on a graphite shuttle behind it that stays on the head while the tool is parked. The docks are a frame bar on the front top frame with a bracket in front of each parked tool. The dock stands on the frame, so it keeps its height while the head moves. heimdall's collision data (`head-shapes.json`) is unchanged: no profile names a Klipper tool changer.

| Value | Source | Status |
| --- | --- | --- |
| Park point of each tool (X, Y, Z) | the printer's `tool <name>` section over Moonraker | measured when given |
| Park points without a config: docks centered on the bed's width, 76 mm apart; Y -71 (in front of the bed); Z 20 mm over the printable height | dock pitch: StealthChanger Docks page (76 mm per Stealthburner); Y: the project's example `Toolhead_T0.cfg` (`params_park_y` -71.0); Z: no source | estimated |
| Safe Y | `params_safe_y` over Moonraker | measured when given |
| Safe Y without a config: 91 mm behind the park point | the project's example (`params_safe_y` 20.0 against `params_park_y` -71.0) | estimated |
| Dock path, in drop-off order: Y +9.5 Z +4, Y +9.5 Z +2, Y +5.5, Y 0 (half speed), Z -10, Y +16 Z -10; pick-up the reverse | the printer's `params_sc_path` or `params_path` when given; else the project's example `params_sc_path` | measured when given, else from the project's example |
| Path speed 100 mm/s (half at the seat), acceleration 2000 mm/s2 | no source (the speed parameters are not in the pages read) | estimated |
| Travel along X and to the docks: the profile's travel speed and acceleration | the printer's profile | as the profile gives |
| Temperature wait: the profile's change time, at least 0.8 s | no change time in a generic Klipper profile | estimated |

Speeds are always estimated: Moonraker gives the park points and the path, but no speed Preview reads.

Sources: github.com/DraftShift/StealthChanger (its `Klipper/Toolhead_T0.cfg` and `Toolhead_T1.cfg`, and the wiki's Configuration and Docks pages); Moonraker `configfile.settings` through `packages/connect/src/drivers/moonraker/docks.rs`.

## Prusa Core One with INDX (passive nozzle tools in docks along the front)

How it works. INDX turns the Core One into a nozzle changer. The head is one Smart Head with an induction coil; the tools are passive (a nozzle on a coupling block, its own filament path, no electronics) and park in docks along the front of the machine, the door side. The head backs the tool it carries into its dock until it is seated and releases it, backs out to the clearance line, runs along X to the next tool's dock, goes in, latches that tool (the head checks the coupling on its load cell) and pulls it out. The coil heats the new nozzle in seconds; the head then deposits a small blob (about 13 mg) into the purge collector, wipes over the nozzle wiper, returns to the next move and the bed comes back up. Prusa gives about 12 s per change for PLA, from the last extrusion of one material to the first of the next. Preview plays that as `front-dock` in `toolchanger.ts`. The heat dwell takes what the 12 s leave after the moves, and at least 4 s, so a change across the whole dock row runs a little longer than 12 s. On the Core One the bed moves in z, so the docks and the purge collector keep the head's height in Preview.

Which printers get it. The `prusa-core-one-indx` profile (two or more nozzles). The plain Core One keeps one nozzle and no tool change playback.

The profile. No Prusa printer profile for INDX exists yet, so the profile is written from the public pages: eight tools of 0.4 mm (the kits have 4 or 8 tools; a print uses one tool per filament, so a two color plate uses T0 and T1), the 248 x 205 x 270 mm volume with INDX fitted, `machine_tool_change_time` 12, and extruder offsets of zero (the firmware keeps each tool's offset). The motion limits, retraction, z hop, clearances and thumbnails are copied from the plain Core One's profile, since the kit changes the head and not the motion system. The G-code family `prusa_core_one_indx` is our own: a change is `T[next_extruder]` and `M109` for the new tool, never `M600`. The firmware does the park, pick and purge on the `T`; our G-code never moves the head to a dock or the purge collector, so the estimated positions below are for Preview and the time estimate only. The profile has not been run on a real printer. It is replaced when Prusa publishes its own INDX profile.

Drawing. The Smart Head (black body with the orange front and the coil strip low on the front, the extruder on top) is part of the gantry and always drawn; the passive tool hangs under it, a band on its coupling block in the filament's color. The docks stand in a row along the front, each two side plates and a front plate around its tool, with a frame bar in front; a parked tool stands 2 mm higher than the head holds it, and the dock lifts it those 2 mm as it is released. Docks past the print's tools hold spare tools drawn in steel. The purge collector with its wiper stands beside the bed's front right corner, and a blob in the new filament's color grows under the nozzle there. Shapes are estimated from product photos. heimdall's collision data (`head-shapes.json`) gets the Smart Head with its tool and every dock to dock route.

| Value | Source | Status |
| --- | --- | --- |
| Build volume 248 x 205 x 270 mm with INDX fitted | Prusa's INDX conversion kit page | sourced |
| 4 or 8 tools, at most 8 on the Core One; the profile lists 8 | Prusa's INDX conversion kit page | sourced |
| About 12 s per change for PLA (`machine_tool_change_time` 12) | Prusa's INDX conversion kit page | sourced |
| Purge of about 13 mg into the purge collector, then the nozzle wiper | Prusa's INDX conversion kit page | sourced |
| Default tools: 0.4 mm high flow nozzles; max nozzle temperature 300 C | Prusa's INDX conversion kit page | sourced |
| Tool offsets kept by the firmware (`t{n}_offset_x`, `t{n}_offset_y`), so the slicer's are zero | Bondtech's INDX documentation | sourced for the dev kit, taken for the Core One |
| Dock about 28.5 mm wide, 25 mm deep, 70 mm tall | Bondtech's INDX documentation | sourced for the dev kit, taken for the Core One |
| Tool pitch 34 mm (the bare minimum center to center) | Bondtech's INDX documentation | sourced minimum, used as the pitch |
| Docks along X at the front (`variable_dock_dir` -1) | Bondtech's INDX documentation; Prusa forum thread (docks on the door side); the 15 mm Y loss | sourced for the dev kit, consistent for the Core One |
| Clearance Y at least 26 mm behind the docks (a 25 mm tool plus 1 mm) | Bondtech's INDX documentation | sourced |
| A parked tool sits 2 mm higher than the head holds it | Bondtech's INDX documentation | sourced for the dev kit, taken for the Core One |
| Heat of about 4 s at least (4 to 8 s) | Bondtech's INDX documentation | sourced for the dev kit, taken for the Core One |
| Docks centered on the bed's width | no source | estimated |
| Seat at Y -26 and clearance at Y 0 (the bed's front edge) | Bondtech's default dock config (`t0_dock_y` -26, clearance 0); the Core One's own values are not published | estimated |
| Change moves at 70 percent of the travel limits | Bondtech's default toolchange speed mode (Normal, 70 percent of the printer's limits) | estimated for the Core One |
| Moves into and out of a dock at 50 mm/s, 1000 mm/s2; release 0.3 s, latch 0.4 s, blob 0.6 s | no source | estimated |
| Purge collector and wiper beside the bed's front right corner (X 258, Y 15, wipe to Y 40 and back to 22) | no source; Prusa names the collector and wiper but not where they are | estimated |
| The bed drops 2 mm for the change | no source | estimated |
| Motion limits, retraction, z hop, clearances: copied from the plain Core One | `machine.json` `prusa-core-one` (the maker's profile) | copied, assumed unchanged by the kit |
| Start and end G-code: the plain Core One's, except the first tool pick after homing, the first tool's values instead of the first slot's, the chamber heating spot X 242 Y 10, the limited mesh area at Y 2, the purge start X 247 Y 2, the probe area by the purge line at X 148 to 248 and the end park X 242 Y 200 | `gcode.json` `maker_prusa_core_one`; the changes are ours | changes estimated |
| `M555` print area line | kept from the Core One, declares Y -4 | estimated |
| `M862.3 P "COREONE"` model check | kept from the Core One; the INDX model string is unknown, and a wrong string fails safe with a firmware prompt | estimated |
| Change G-code: a comment, `T` and `M109` for the new tool, no move | written for SlicerX | the firmware's behavior on `T` assumed |

Sources: prusa3d.com/product/indx-4-tool-conversion-kit-for-core-one-gen2/, github.com/BondtechAB/INDX (its README and `indx.cfg` description), and the Prusa forum thread "Tools mounted on the front impacting access" in the INDX general discussion.

## Bambu Lab H3C (nine PrintTools on the SwapTek rack)

How it works. The H3C has one toolhead and nine PrintTools. A PrintTool is a hotend on a base of its own, with its own filament path, so each filament stays loaded in its own hotend and a change between two of them flushes nothing. The PrintTools wait on the SwapTek rack, which is installed on the front of the chamber, each on a dock that holds it by a magnet. The rack is motorized: it waits raised while the print runs, so the print stays in view, and lowers to its working position when a change comes. The toolhead goes to the preset position of the PrintTool it carries, its ToolLock motor moves the PrintTool down out of the lock and the dock takes it; the head then picks the next PrintTool from its dock the same way in reverse, and the rack rises again. The purge wiper is at the back right of the chamber, over the purge chute at the back. Preview plays that as `printtool-rack` in `toolchanger.ts`.

Where the change happens. The stock change G-code lifts to 3 mm over the highest layer printed (`G1 Z{max_layer_z + 3.0} F3000`), stops the fans, sets the flush and retraction values (`M620.10`, `M620.11`), and hands over to the firmware with `T[next_filament_id]` between `M620 S[next_filament_id]A` and `M621 S[next_filament_id]A`. After the `T` it leaves the back of the chamber by `G387 Y295 J1 F60000` and `G387 Y265 J1 F18000`, then selects the hotend for the air printing check (`M620.6 I[next_filament_id] H[next_hotend]`). The start G-code loads the first filament the same way (`T[initial_no_support_filament_id]`, then `M620.6 ... H[initial_no_support_hotend]`) and also leaves its wipes by the same two `G387` moves, so the firmware's work on a `T` ends at the back of the chamber. The change G-code moves the head to no dock: the rack positions are the firmware's own (the wiki's docking calibration finds each dock near a preset XY), so the ones below are estimated, for Preview only. The sequence: lift; the rack lowers as the head runs to the front; into the dock of the PrintTool it carries, unlock, back out; along the docks to the PrintTool of the next filament's hotend, in, lock, out; the rack rises as the head goes to the chute at the back right, where the new PrintTool's filament is gripped and primed; out by the two `G387` moves; back to the next move and down. Two filaments on one hotend (more filaments than hotends) swap filament at the chute instead, with no rack visit.

The move order was checked against a real H3C print file (two cubes, PETG and ABS in filaments 1 and 3, a prime tower): every one of its 165 changes runs `M620 Q`, `M620 S..A`, the lift, `T`, `M621 S..A`, `G387 Y295`, `G387 Y265`, `M620.6`, `M620 O`, and every change to filament 3 goes to hotend 1 and every change to filament 1 to hotend 0, as its nozzle change comments say. Preview plays the same 165 changes on the same hotends (test/h3c.test.ts).

Which hotend. Each filament prints on the hotend the slice's filament map gives it (`filamentMap.nozzles` in the slice result, `filament_nozzle_map` in the settings, 0-based). The engine fills that map: the plate's filaments take free hotends in slot order, a 2.85 mm TPU filament the TPU hotend, and filaments past the free hotends share hotend 0. Before a slice, filament `n` is taken to be on hotend `n`.

Which printers get it. The `bambu-h3c` profile, and any printer with one `nozzle_diameter` entry and an `extruder_max_nozzle_count` above 1 (one extruder whose hotends are its tools, the engine's `hotend_tools` rule).

Timing. A swap costs the printer's hotend change time, as the engine counts it: the first of `machine_hotend_change_time`, `machine_tool_change_time` and `machine_switch_extruder_time` above 0. The stock presets give 0, nothing and 4 s, so a swap takes 4 s. Each hotend keeps its filament as an extruder does, so the first visit to a hotend also loads it (15 s), and later swaps to it are 4 s. The 4 s cover the firmware's part, from the trip to the rack to the chute; the prime at the chute takes what the moves leave of it, at least 0.3 s. The lift, the exit moves, the return and the lowering come on top, at their own feed rates.

Drawing. The toolhead (black body with the display chip in the printing filament's color, the silver cover, the lock plate under the body) is part of the gantry and always drawn; the PrintTool hangs under it, with the indicator light on the front of its base and the filament stub at the back of its top. The PrintTool in play reads against the black head and the steel rack: its nozzle tip and filament stub take the filament's color and its base gets a light edge. That is the PrintTool in the head, and during a change the one in the dock the head stands in front of, so the PrintTool being parked shows until the head backs out. Parked PrintTools stay steel. The rack stands across the front: a beam with a hanger in front of each dock. A docked PrintTool hangs 2 mm higher than the head holds it, and the dock takes it up those 2 mm as it is unlocked. Docks of hotends the print does not use hold spare PrintTools. The rack is drawn raised 60 mm while the print plays and lowered through the change. The chute and wiper at the back right are the purge rig's.

Sizes. The wiki gives the print area (330 x 320 mm) and photos, and no dimensions of the toolhead, the PrintTools or the rack. The drawing is scaled from the bed and those photos: a PrintTool base 24 mm square and 13 mm tall, a toolhead 40 mm wide, 32 mm deep and 80 mm over the tip, nine docks 36 mm apart, which spreads the rack across the chamber's width (the wiki fixes the rack with screws in both side panels).

heimdall. heimdall's collision data (`head-shapes.json`) has the drawn toolhead with its PrintTool as the H3C's head, and a route for every change between two of its nine hotends: the clearance line in front of the old hotend's dock (Y -8), into the dock (Y -40) and back out, along the clearance line to the new hotend's dock, in and out, then the chute (X 300, Y 336) and the two exits (Y 295, Y 265). The stops at the docks are the station, so a part struck there is a dock collision, and the message names the tool rack. A change between two filaments on one hotend has a route of its own: the chute and the exits, with no rack visit.

The engine picks the route by hotend, not by filament: each filament goes through the slice's own filament map (the hotend it prints on, as the change G-code's `next_nozzle_id` gives it; `next_hotend` is -1, as the printer's stock output writes it) before the route is looked up, so a print of filaments 1 and 3, which prints on hotends 0 and 1, docks at the first two docks, not at the first and third. With the head and routes in the data, the gantry, lid and head checks of a by-object H3C print use the H3C's own head instead of the P1 family's, and a change trip that crosses an object printed before it is reported. The size estimates above are the head's and the docks' envelope; a change G-code that lifts over `max_layer_z` (the maker's does) clears everything printed so far, so with it only the head and gantry checks remain.

| Value | Source | Status |
| --- | --- | --- |
| Bed 330 x 320 mm, printable height 325 mm | machine profile (`printable_area`, `printable_height`) | measured |
| One extruder (`nozzle_diameter` one entry), nine hotends (`extruder_max_nozzle_count` 9), hotend 8 for 2.85 mm TPU | machine profile | measured |
| `machine_hotend_change_time` 0, `machine_switch_extruder_time` 4 s, load 15 s, unload 28 s | machine profile | measured |
| Lift 3 mm over the highest layer before the change (`G1 Z{max_layer_z + 3.0} F3000`) | change G-code | measured |
| Exit moves `G387 Y295` at 60000 mm/min and `G387 Y265` at 18000 mm/min | change G-code | measured |
| Order: `M620 S..A`, lift, `T`, `M621 S..A`, exits, `M620.6 ... H[next_hotend]` | change G-code; a real H3C print file, all 165 changes | measured |
| Rack on the front of the chamber, fixed by screws in both side panels; docks hold PrintTools by magnet; the rack waits raised and lowers for a change | wiki, main components; wiki, SwapTek rack replacement; wiki, SwapTek workflow | sourced, no coordinates |
| The head unlocks a PrintTool with its ToolLock motor, moving it down out of the lock | wiki, main components | sourced |
| Purge wiper at the back right of the chamber, over the purge chute at the back | wiki, main components | sourced, no coordinates |
| Travel speed and acceleration | process profile (`travel_speed`, `travel_acceleration`) | measured |
| Nine docks 36 mm apart, centered on the bed; PrintTool seated at Y -40, the head runs along X at Y -8 | no source | estimated |
| Rack raised 60 mm while printing; a docked PrintTool 2 mm higher than held | no source | estimated |
| Chute at X 300 (30 mm in from the bed's right edge), Y 336 (16 mm past the bed, as the H2 family's) | wiki (back right); position not published | estimated |
| Moves into and out of a dock at 150 mm/s, 3000 mm/s2; unlock 0.3 s, lock 0.4 s, shortest prime 0.3 s | no source | estimated |
| PrintTool base 24 mm square and 13 mm tall; toolhead 40 x 32 mm, 80 mm over the tip | scaled from the 330 x 320 mm print area and the wiki photos; no published dimensions | estimated |

The stock change and start G-code come from the H3C's G-code family staged for `gcode.json`, which does not carry it yet; until it does, the change G-code the app writes for the H3C is not the stock one, and Preview takes the lift and the exits from the values above rather than from the settings.

Sources: the H3C machine and process profiles in `packages/profiles` (resolved/bambu-lab.json); the H3C's stock change and start G-code; wiki.bambulab.com/en/h3c/manual/swaptek-workflow-and-function, wiki.bambulab.com/en/h3c/manual/main-components, wiki.bambulab.com/en/h3c/maintenance/replace-swaptek-rack, wiki.bambulab.com/en/h3c/maintenance/replace-printtool and wiki.bambulab.com/en/h3c/troubleshooting/how-to-place-printtool.

## Timing model

Playback time comes from the layer times the engine writes into the preview buffer. Those cover the print moves of a layer. The change itself is added by the app's timeline from the same rules the engine uses for the G-code's time estimate (`packages/core/src/gcode.rs`, `tool_change_time`, after Orca 2.4.2 `GCodeProcessor::process_T` and Bambu Studio `process_filament_change`):

- Same extruder, other filament: unload time plus load time.
- Other extruder: the switch time (`machine_tool_change_time`, or Bambu's `machine_switch_extruder_time` when the profile has only that), plus load time if the extruder is empty, or unload plus load if it last held a different filament.

That gives 5.6 s per switch on the H2D, 5 s plus 30 s of unload and load per hotend swap on the H2C, 4 s per hotend swap on the H3C (each hotend standing for an extruder, so its first use adds the 15 s load), 5 s on the U1, and nothing on the UltiMaker S series, whose profiles give the switch no time of its own. The simulation's moves are timed with the printer's own travel speed and acceleration (trapezoidal profiles, no instant velocity changes) and its dock speeds; where the profile's documented time is longer than the moves, the difference is spent where the machine spends it (cutting, loading and flushing at the chute on Bambu printers, waiting on temperature on the U1). Where it is shorter, the moves win, so the head never teleports.

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

So heimdall holds the A1 and A1 mini to the profile: the nozzle, a 3.2 mm column (the nozzle every drawn head shares) up to `nozzle_height` (4.76 mm), is the only part of the drawn head that is checked, and Bambu Studio's own rule stands in for the rest: two objects closer than `extruder_clearance_max_radius` (73 mm) block the print, the head being unmeasured, where a measured head only makes that a close call. Orca's Bambu Lab profiles, which the app resolves, carry the 73 mm in `extruder_clearance_radius`; heimdall takes the larger of the two on a Bambu Lab printer. The rod (25 mm, 56.5 mm either side) and lid rules hold above. When the owner's A1 and A1 mini are measured, or the measured CAD can be read, the head's boxes can replace this.

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
- H3C (checked against Bambu Studio 2.9.1's sliced files): its hotends are its tools, so a hotend swap is a change of extruder, not the H2C's rack swap. The new filament primes `filament_prime_volume`, and the old hotend prints `filament_change_length`, both without `_nc`.
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
