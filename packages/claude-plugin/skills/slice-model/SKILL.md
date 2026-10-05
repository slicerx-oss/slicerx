---
name: slice-model
description: Use when the user wants to slice a 3D model (STL, 3MF, OBJ) to G-code, estimate print time or filament for a model, or get a model ready to print on a specific printer and filament with SlicerX. Triggers include "slice this", "how long will this take to print", "how much filament", "make G-code for my printer".
---

# Slice a model with SlicerX

Use the SlicerX MCP tools. Tool names below are the server's own names; your client may show them with a prefix.

## Steps

1. Find the model. It must be an absolute path to an STL file or an http(s) URL. If the user named a file without a path, ask for the full path. The core reads STL today; for 3MF or OBJ, say so and ask for an STL export. To try SlicerX without a file, use a built-in test model: `sample:cube-20`, `sample:tower-20x60` or `sample:plate-60x40x3`.
2. Work out the printer, filament and intent from the request. If the printer or filament is missing, ask once, or use `slicerx_list_profiles` with a `query` to find the id (for example `printer:bambu_p1s`, `filament:petg`). Intent is one of draft, standard, fine or strong; map phrases like "functional bracket" to strong and "miniature" to fine.
3. If the request implies setting changes (a new material, a nozzle size, "stronger", "faster"), call `slicerx_plan_settings` with `printer`, `filament`, `nozzle_diameter` and `intent`, and keep its `config_patch`.
4. Estimate first with `slicerx_estimate_file` (`model`, `profiles`, `overrides` = the config patch). Report time, grams and layers in one line.
5. When the user wants G-code, call `slicerx_slice_file` with the same arguments and give them the `gcode_path`.
6. If the result says `"engine": "stub"`, tell the user the numbers are a rough estimate from the mesh, and that the G-code file is not printable until the `sx` slicer is installed.

## Report

- Time as hours and minutes, filament in grams and meters, layer count.
- Every warning the tool returned, word for word.
- The profiles and overrides used, so the user can repeat the slice.

## Printing it

To send the result to a printer, use the project tools instead of the file tools: `slicerx_project_open` (printer and filament), `slicerx_project_add_model`, then `slicerx_slice` and `slicerx_printer_queue`. Queueing follows the user's permission policy. If a tool returns `status: "approval_required"`, show the user the title and details and call `slicerx_approve` only with their answer. Never approve on the user's behalf.
