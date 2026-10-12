# SlicerX MCP tools

Generated from the tool list (`serverTools` in src/server.ts) with demo printers and the geometry engine on. Do not edit by hand: `SLICERX_WRITE_TOOLS_DOC=1 pnpm --filter @slicerx/mcp exec vitest run test/registry.test.ts` writes it again.

137 tools.

| Tool | Title | Set | Permission | What it does |
| --- | --- | --- | --- | --- |
| `slicerx_action_log` | Action log | core | read, ungated | The most recent tool calls and approval decisions this server recorded: tool, permission class, decision, who decided, and the result summary. |
| `slicerx_add_to_fleet` | Add a printer to a fleet | fleets | read, ungated | Add a printer to a fleet. |
| `slicerx_ams_mapping` |  |  | read | Map the filaments a job needs (material and color per part) onto the slots loaded on one printer. |
| `slicerx_approve` | Approve or decline a pending action | core | read, ungated | Resolve an approval request returned by another SlicerX tool (status "approval_required"). |
| `slicerx_arrange` |  |  | slice | Pack copies of an object onto plates. |
| `slicerx_calibrate` |  |  | read | Plan calibration tests for a filament (temperature tower, flow, pressure advance, retraction, max volumetric speed, tolerance, shrinkage) with ranges from the knowledge base, time and filament. |
| `slicerx_check_print` |  |  | read | Check on a running print: takes a fresh camera frame, shows it to the user and to you with the printer's status and the limits for changes. |
| `slicerx_cloud_jobs` |  |  | read | Cloud slicing jobs: with job_id, that job's status, progress, stage, result (time, filament) and, once it succeeded, the G-code and preview links (they need the same API token and expire 7 days after the job finishes); without it, the recent jobs, newest first. |
| `slicerx_cloud_slice` |  |  | slice | Slice a model in the integrator's SlicerX cloud instead of on this machine: checks the account is invited and within its daily job and upload limits, uploads the STL (only if the cloud does not have it yet), queues a job with the settings (schema defaults, then each profile, then overrides) and returns the job id. |
| `slicerx_compare_setups` |  |  | slice | Slice the same plate two ways and compare side by side: print time, filament grams, cost, a strength proxy and risk notes, with a one line verdict. |
| `slicerx_create_fleet` | Create a fleet | fleets | read, ungated | Create a named group of printers. |
| `slicerx_cut` |  |  | slice | Make a model fit a printer: compare scaling it down with splitting it (mode "compare" only reports), or split it (mode "split"). |
| `slicerx_delete_fleet` | Delete a fleet | fleets | read, ungated | Delete a fleet. |
| `slicerx_design_edit_step` |  |  | slice | Edit one step of a design and replay the steps after it, as editing a step in SlicerX's history does: set its main number (the distance, depth, angle, radius, wall or diameter slicerx_design_steps shows as value), suppress it or turn it back on, or rename it. |
| `slicerx_design_list` |  |  | read | The designs open on this server, with their parts, sizes and step counts. |
| `slicerx_design_new` |  |  | slice | Start a design: a part you build step by step with the modeling tools (slicerx_geom_extrude, slicerx_geom_revolve, slicerx_geom_push_pull, slicerx_geom_fillet, slicerx_geom_chamfer, slicerx_geom_build, slicerx_geom_subtract, slicerx_geom_hollow, slicerx_geom_emboss, slicerx_geom_repair), each given this design id. |
| `slicerx_design_open` |  |  | read | Open the objects of any 3MF project (SlicerX, Bambu Studio, Orca) as designs, one per object. |
| `slicerx_design_redo` |  |  | slice | Put back the step slicerx_design_undo last removed. |
| `slicerx_design_save` |  |  | slice | Save a design as a 3MF project in the output folder: the parts with their filament slots, and the CAD history, so the file opens in SlicerX with every step editable (other slicers open the parts). |
| `slicerx_design_steps` |  |  | read | The steps of a design in order: each one's index, id, name ("Pull 5 mm", "Fillet 0.5 mm"), its main number, and whether it went through, broke (with the reason) or is suppressed. |
| `slicerx_design_undo` |  |  | slice | Remove the last step of a design and replay it, back to how it was before that step. |
| `slicerx_diagnose` |  |  | read | Explain a failed or odd print on one of your printers: reads its status and message, matches the symptom against the troubleshooting guides and ranks causes with checks and fixes. |
| `slicerx_emboss` |  |  | slice | Emboss (raised) or deboss (recessed) text on a face of a part. |
| `slicerx_energy_estimate` |  |  | read | Estimate electricity use and cost for sliced plates or a given print time: kWh and cost per plate from print time and heat-up. |
| `slicerx_estimate` |  |  | read | Totals for the sliced plates: machine time, wall clock when each plate runs on its own printer, filament grams, filament and machine cost, and whether it finishes before a deadline. |
| `slicerx_estimate_file` | Estimate print time and filament | core | read, ungated | Same inputs as slicerx_slice_file without output and preview, and writes no G-code. |
| `slicerx_explain_setting` | Explain a setting | settings | read, ungated | Explain one OrcaSlicer setting: label, a plain summary, help text, unit, default, limits, what raising or lowering it does, when it has no effect, and the first slicing stage it invalidates. |
| `slicerx_find_settings` | Find settings | settings | read, ungated | Search OrcaSlicer settings by words in the key, label or help text, such as "seam", "first layer speed" or "support interface". |
| `slicerx_fit_check` |  |  | read | Check whether a designed gap will fuse, bind, press fit or slide at the layer height, line width and material, and suggest the gap to model instead. |
| `slicerx_fleet_overview` |  |  | read | Status of every printer in one call: state, current job with progress and time left, loaded filament per slot with what is left, and printer messages. |
| `slicerx_gcode_inspect` |  |  | read | Explain what a G-code file will do: layers, temperatures, typical and peak print speed, volumetric flow (checked against the filament limit), retraction count and length, fan, and time by feature from ;TYPE: or FEATURE comments. |
| `slicerx_geom_boolean` |  |  | slice | Union, subtract or intersect closed models: union joins "model" and every model in "with", subtract removes them from "model", intersect keeps what they share. |
| `slicerx_geom_build` |  |  | slice | Build a new model from simple solids (boxes, cylinders, prisms), optionally cutting holes with convex cutters. |
| `slicerx_geom_calibration_model` |  |  | slice | Generate a calibration print: temperature tower, flow pads, pressure advance, retraction, max volumetric speed, tolerance plate, shrinkage L, or the feature piece (a small print with a bridge, an overhang, a thin wall, a hole and text). |
| `slicerx_geom_chamfer` |  |  | slice | Bevel straight edges where two flat faces meet, set back by distance_mm on each face (or distance_mm on the edge's own face and distance2_mm on the other). |
| `slicerx_geom_cut` |  |  | slice | Cut a model with a plane into a lower and an upper part with flat caps, optionally with pin, dowel or dovetail connectors. |
| `slicerx_geom_edge_pick` |  |  | read | Pick an edge for a fillet or chamfer on a model or a design: give a point on a flat face near the edge (or on the edge) and that face's normal. |
| `slicerx_geom_emboss` |  |  | slice | Raise (emboss) or cut in (deboss) text on a face of the model. |
| `slicerx_geom_extrude` |  |  | slice | Sketch and extrude: a shape (rectangle, circle, slot, polygon, text, a free sketch of lines and arcs, or SVG artwork) on the bed, any plane or a picked face, extruded as a new body, joined to a target, or cut from it. |
| `slicerx_geom_face_pick` |  |  | read | Pick a flat face of a model or a design: returns its sketch frame (origin, normal, u, v in mm), its outline in that frame, area and bounds. |
| `slicerx_geom_faces` |  |  | read | List the flat faces of a model or a design, largest first: a point "at" on each face, its outward normal, which axis it faces (+z (top), -x and so on), its area and center; for a design also its part, its face key and the step that made it. |
| `slicerx_geom_fillet` |  |  | slice | Round straight edges where two flat faces meet, with one radius: convex edges lose material, concave edges gain it, and three filleted edges at a corner get a sphere patch. |
| `slicerx_geom_hollow` |  |  | slice | Hollow a solid model to a shell of a given wall thickness, with optional drain holes so resin or trapped material can leave. |
| `slicerx_geom_info` |  |  | read | Check a model: its bounds (min, max and size in mm), volume, surface area, triangle count, whether it is closed (watertight) and how many separate shells it has. |
| `slicerx_geom_layers_plan` |  |  | read | Plan variable layer heights (sleipnir) for a model: thinner layers where the shape needs detail, thicker where it does not, within the nozzle-based limits. |
| `slicerx_geom_measure` |  |  | read | Measure a model as the measure tool does (distance, angle and radius): the feature at a picked point, a flat face, a hole or boss (a cylinder, with its diameter), an edge or a corner, and with a second pick "b" the distance and angle between the two. |
| `slicerx_geom_orient` |  |  | read | Rank candidate print orientations by overhang area, support volume, bed contact and height, best first, or score one orientation given as the direction that points down. |
| `slicerx_geom_paint_regions` |  |  | read | Read paint back: for one paint layer of a model (its per-triangle paint texts, as a 3MF stores them), each painted state with its area in mm2, the triangles holding it and its connected regions with their areas and bounds (largest first, at most 20 listed). |
| `slicerx_geom_push_pull` |  |  | slice | Push or pull a flat face of a model or a design along its normal: a positive distance pulls it out and adds material, a negative one pushes it in and cuts; pushing past the far side makes a hole. |
| `slicerx_geom_render` |  |  | read | Draw a model to check it: a small orthographic picture (384 px on the long side unless size says otherwise) from a fixed view, the model in its filament color and painted pieces in theirs. |
| `slicerx_geom_repair` |  |  | slice | Repair a mesh: weld vertices, fix winding and normals, and close small holes. |
| `slicerx_geom_resume_plan` |  |  | read | Plan resuming a failed print: from the height of the part left on the bed, or the layer the printer stopped at, find the first layer to print again and the remaining part of the model. |
| `slicerx_geom_revolve` |  |  | slice | Revolve a sketch profile around an axis in its plane, up to 360 degrees, as a new body, joined to a target or cut from it. |
| `slicerx_geom_sketch_check` |  |  | read | Check sketch loops before extruding or revolving: whether they close and do not cross, which loops are holes, the filled area, and each problem with the loop and segment that causes it. |
| `slicerx_geom_split` |  |  | slice | Split a model that is too big for the printer into parts that each fit the build volume, with the fewest cuts, optionally with connectors. |
| `slicerx_geom_subtract` |  |  | slice | Cut holes and pockets in an existing model with convex cutters, such as screw holes or a countersink: {"type":"countersink","origin":[x,y,z] on the surface,"axis":[...] into the material,"shaftDiameterMm":d,"headDiameterMm":D,"angleDeg":90,"depthMm":h}. |
| `slicerx_get_policy` | Permission policy | core | read, ungated | Show the permission policy the user set for this server: Allow, Ask first or Off for each action class, and per-printer exceptions. |
| `slicerx_get_profile` | Get a profile | settings | read, ungated | Return the settings a profile sets, with OrcaSlicer inherits chains resolved. |
| `slicerx_hollow` |  |  | slice | Hollow a solid part to a wall thickness and cut drain holes through the face that rests on the bed, for light parts, resin export or filling. |
| `slicerx_home_assistant_call_service` |  |  | start | Call a Home Assistant service, such as turning a printer power plug on or off. |
| `slicerx_home_assistant_list_entities` |  |  | read | List switches, sensors and lights, such as printer power plugs and enclosure fans. |
| `slicerx_inspect_project` | Inspect a 3MF project | core | read, ungated | Read a 3MF or .sx3mf project without slicing it: its plates (with names and object counts), the printer, process and filament presets it was saved with, its filament slots (type and color), its support settings (`support`: enable_support, support_* and tree_support_* as the file sets them) and whether it carries print settings. |
| `slicerx_kb_filament` |  |  | read | Look up a filament in the knowledge base: temperatures, cooling, plates, drying, nozzle needs, flow, retraction, pressure advance, failure modes, with sources. |
| `slicerx_kb_intent` |  |  | read | Turn a job request in plain words ("12 strong PETG brackets by Friday") into structured goals (count, part, material, strength, speed, detail, deadline, printers) and setting targets by Orca key with reasons. |
| `slicerx_kb_printer` |  |  | read | Look up a printer model in the knowledge base: build volume, hotend, bed, enclosure, motion limits, supported materials, profile baseline and notes, with sources. |
| `slicerx_kb_search` |  |  | read | Search the whole knowledge base (filaments, printers, workflows, troubleshooting, settings catalog) when the right entry is not obvious. |
| `slicerx_kb_sources` |  |  | read | Look up the title, publisher and link of knowledge base sources by id (for example "bambu_wiki_ams_function") or by prefixed path (for example "orca:BBL/machine/..."). |
| `slicerx_kb_troubleshoot` |  |  | read | Find the troubleshooting guide for a print problem (layer shift, stringing, warping, under extrusion and so on): the diagnosis questions, causes ranked by likelihood with checks and fixes (setting keys where they apply), with sources. |
| `slicerx_kb_workflow` |  |  | read | Find a how-to workflow: Bambu AMS, calibration (flow, pressure advance, input shaping), supports, seams, ironing, plate types, Prusa MMU, Klipper, PrusaLink, and similar, with sources. |
| `slicerx_knowledge_lookup` | Look up print knowledge | kb | read, ungated | Read an entry from the SlicerX print knowledge base: filaments (temperatures, drying, plates, failure modes), printers (build volume, hotend, profile baseline), accessories, troubleshooting trees (stringing, warping, layer shift and others) and workflow guides. |
| `slicerx_list_fleets` | List fleets | fleets | read, ungated | List the fleets: optional groups of printers the user made, such as "Workshop", with their printer ids. |
| `slicerx_list_profiles` | List profiles | settings | read, ungated | List printer, filament and process profiles. |
| `slicerx_local_ai_check` |  |  | read | Check whether this computer can run mimir's model locally: the graphics card and its memory, system memory and cores, one recommended model with the reason in plain words, its download size and license, and whether Ollama or LM Studio is running. |
| `slicerx_local_ai_setup` |  |  | profile | Download a local model through Ollama (the recommended one, or model by id or Ollama tag), then check one tool call and the speed. |
| `slicerx_local_ai_status` |  |  | read | Show the local models installed in Ollama and LM Studio, with license and tool use for the ones SlicerX knows, and the model slicerx_local_ai_setup last set up and checked. |
| `slicerx_make_model` |  |  | slice | Builds a multi-color model from a request and slices it. |
| `slicerx_material_recommend` |  |  | read | Recommend materials for a use case, best first, with reasons and cautions from the knowledge base. |
| `slicerx_mesh_analyze` |  |  | read | Measure an object as it sits on the bed now: volume, surface area, size, whether it is watertight (open, flipped and non-manifold edges, separate shells), overhang area past the support angle, estimated support volume and bed contact area. |
| `slicerx_mesh_repair` |  |  | slice | Repair an object mesh before slicing: merge loose vertices, remove zero-area and duplicate triangles, flip inward-facing triangles and fill holes. |
| `slicerx_multicolor_assign` |  |  | slice | Plan a multicolor print: which filament each region or height band gets, the order of color changes with layer numbers for height bands, whether the printer has enough slots and can feed each material, and how to cut purge waste (flush multiplier, prime tower). |
| `slicerx_optimize_to_target` |  |  | slice | Hit a print target by slicing many real candidates: under a time limit, under a filament or cost limit, or strongest (or fastest, lightest, cheapest) within a limit. |
| `slicerx_orient` |  |  | slice | Find the rotation with the least support (support volume and overhang area beyond the support angle) and good bed contact for an object, and apply it when apply is true. |
| `slicerx_orientation_search` |  |  | slice | Choose how to lay a part on the bed by slicing each candidate orientation: the six axis orientations, plus 45 degree tilts when asked. |
| `slicerx_overnight_readiness` |  |  | read | Pre-flight for a long unattended print on one printer. |
| `slicerx_pending_approvals` | Pending approvals | core | read, ungated | List approval requests this session raised: the ones waiting for your user (approve with slicerx_approve), the ones waiting for a person in SlicerX or on the phone, and how those went once the hub ran them. |
| `slicerx_plan_settings` | Plan settings | settings | read, ungated | Work out which OrcaSlicer settings to change for a filament, printer, nozzle and print intent. |
| `slicerx_print_adjust` |  |  | start | Make one change to a running print: part fan, speed factor, nozzle or bed temperature, or pause. |
| `slicerx_printer_add` |  |  | printer_config | Adds the printer to SlicerX with its profile, nozzle and connection. |
| `slicerx_printer_cancel` |  |  | start | Cancel the running print. |
| `slicerx_printer_config_check` |  |  | read | Check one printer against the knowledge base entry for its model: input shaping and pressure advance notes, stock nozzle against the loaded filament, hotend limit, AMS compatibility of loaded materials, camera, and the model's own notes for mimir. |
| `slicerx_printer_discover` |  |  | read | Lists printers found on the local network or over USB. |
| `slicerx_printer_filament` |  |  | start | Load or unload filament: M701 or M702 on Marlin and Prusa firmware, the LOAD_FILAMENT or UNLOAD_FILAMENT macros on Klipper. |
| `slicerx_printer_gcode` |  |  | start | Send one G-code line to a printer console, such as "G28" or "M106 S128". |
| `slicerx_printer_history` |  |  | read | Past prints of one printer, newest first, as the printer itself keeps them: file name, result (completed, canceled or failed), start and end time, duration and filament used. |
| `slicerx_printer_list` |  |  | read | List printers with their state, loaded filament, temperatures and machine cost. |
| `slicerx_printer_match` |  |  | read | Rank the printers that can print a model in a material right now: fit in the build volume, hotend temperature, nozzle hardness for abrasive filament, enclosure need, material already loaded, wait time and machine cost. |
| `slicerx_printer_pause` |  |  | start | Pause the running print on a printer. |
| `slicerx_printer_profile_search` |  |  | read | Searches the printer profile library by vendor or model text and returns profile ids with the nozzle sizes each profile has. |
| `slicerx_printer_queue` |  |  | start | Send a sliced plate to a printer and start it (upload then start). |
| `slicerx_printer_resume` |  |  | start | Resume a paused print. |
| `slicerx_printer_set_temperature` |  |  | start | Set a nozzle, bed or chamber target temperature on a printer (0 turns the heater off). |
| `slicerx_printer_setup` |  |  | read | Guides a new user through printer setup, one question at a time: optional look and feel, brand, model, nozzle, connection method, test connection, add the printer, first calibration suggestion. |
| `slicerx_printer_snapshot` | Camera snapshot | printers | read, ungated | Take a camera snapshot from a printer and return it as an image. |
| `slicerx_printer_status` |  |  | read | Current status of one printer: state, job, layer, time left, temperatures, filament slots and its message. |
| `slicerx_printer_test` |  |  | printer_config | Tests that SlicerX can reach the printer: reaches it, signs in and reads its state. |
| `slicerx_project_add_model` |  |  | read | Load an STL model (absolute path or http(s) URL) into the open project, with a number of copies. |
| `slicerx_project_open` |  |  | read | Start a new project for mimir skills to work on (replaces the current one). |
| `slicerx_project_set_overrides` |  |  | slice | Set OrcaSlicer settings for the open project, such as the config_patch from slicerx_plan_settings. |
| `slicerx_project_show` |  |  | read | Show the open project: printer, filament, objects, plates and setting overrides. |
| `slicerx_region_modifiers` |  |  | slice | Settings for a goal only where it matters, such as strong screw holes without slowing the whole part. |
| `slicerx_remove_from_fleet` | Remove a printer from a fleet | fleets | read, ungated | Remove a printer from a fleet. |
| `slicerx_rename_fleet` | Rename a fleet | fleets | read, ungated | Rename a fleet. |
| `slicerx_resume_from_layer` |  |  | read | Plan a restart after a failed print with the part still on the bed. |
| `slicerx_risk_report` |  |  | read | Check a plate for what is likely to fail before slicing: warping (footprint size, the material's shrink and enclosure need, open printers), tall thin parts, overhangs with supports off, open mesh edges and small first layer contact. |
| `slicerx_scale_with_tolerance` |  |  | slice | Scale a part uniformly while holding its fastener holes and fits at their real sizes (heat-set inserts, tap holes, clearance holes, pin fits), then report the hole and contour compensation the printer needs. |
| `slicerx_schedule` |  |  | read | Plan jobs across printers: for each job (object, copies, material, optional due date) it estimates time per copy by slicing one copy, splits copies into plates, and assigns each plate to a printer that has the material loaded (else notes a spool swap), idle printers first, lowest machine cost, meeting due dates. |
| `slicerx_settings_apply` |  |  | slice | Apply setting values by Orca key. |
| `slicerx_settings_plan` |  |  | read | Recompute every setting affected by a change of material, printer or nozzle (temperatures, fan, retraction, speeds, flow, pressure advance, bed). |
| `slicerx_setup_look` |  |  | profile | Sets the look and feel: camera and mouse controls, layout and theme. |
| `slicerx_slice` |  |  | slice | Slice project plates with the current settings and overrides. |
| `slicerx_slice_file` | Slice a model file | core | read, ungated | Slice one model file or one plate of a 3MF or .sx3mf project to G-code with SlicerX, without opening a project. |
| `slicerx_smart_layer` |  |  | slice | sleipnir: adaptive layer height. |
| `slicerx_spool_fit` |  |  | read | Check whether the filament loaded on a printer is enough for a sliced plate, with a margin (default 10 percent, at least 10 g). |
| `slicerx_spool_inventory` |  |  | read | Grams of filament on hand per material and color from Spoolman, checked against planned work: jobs you pass in (material, optional color, grams) and the plates already sliced in the project. |
| `slicerx_spoolman_get_spool` |  |  | read | Read one spool. |
| `slicerx_spoolman_list_spools` |  |  | read | List spools with material, color and remaining weight. |
| `slicerx_spoolman_record_usage` |  |  | profile | Subtract used filament from a spool. |
| `slicerx_supports` |  |  | slice | Decide supports for a part as it sits on the bed: whether to enable them, normal or tree type and style (from how flat and how spread out the overhangs are), the threshold angle for the layer height, and support on build plate only. |
| `slicerx_sxlock_export` |  |  | slice | Lock an .sx3mf project for the account whose API token this server holds (scope sxlock_seal): writes a .sxlock to the server's output folder that only that account can open, online. |
| `slicerx_sxlock_inspect` |  |  | read | Read the header of a locked SlicerX project (.sxlock) without the network: format version, the owner account id and the key id. |
| `slicerx_sxlock_open` |  |  | read | Open a locked SlicerX project (.sxlock) for the account whose API token this server holds (scope sxlock_open) and write the project as an .sx3mf to the server's output folder, readable only by this user. |
| `slicerx_text_to_part` |  |  | slice | Make a simple functional part from a description by writing it as parametric solids: plates and boxes (size and minimum corner), cylinders (diameter, height, base center, axis) and L brackets (two legs, width, thickness), plus through holes (diameter, a point on the axis, axis, optional countersink). |
| `slicerx_theme_create` | Create a theme | theme | read, ungated | Build a theme for an embedded SlicerX: overrides on top of a built-in base, covering colors (Subban role names: purple is the accent, pink commerce, cyan live data, green ok, orange attention, red error), the gradient, fonts, radii and the spacing unit. |
| `slicerx_theme_get` | Get a built-in theme | theme | read, ungated | Return a built-in theme (subban, the dark default; subbanLight; forge, an example rebrand) as the theme object, its CSS variables and a ready stylesheet. |
| `slicerx_threads_and_fits` |  |  | slice | Size holes for heat-set inserts, tapping, bolt clearance (plain or countersunk) and press or slip fits on pins and shafts, corrected for how much printed holes close up with this nozzle, line width, layer height and material. |
| `slicerx_update_fleet` | Change a fleet color or icon | fleets | read, ungated | Set or clear (null) the color and icon of a fleet. |
| `slicerx_validate_config` | Validate a config | settings | read, ungated | Check a full or partial OrcaSlicer config: unknown keys, wrong types, values outside OrcaSlicer limits or the usual range, keys that have no effect, and cross-key problems (layer height against nozzle, fan order, nozzle temperature against the filament). |
