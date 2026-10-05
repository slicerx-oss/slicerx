---
disable-model-invocation: true
description: Show every connected printer with its state, job and temperatures
---

Call `slicerx_printer_list`, then `slicerx_printer_status` for each printer that is not offline. Show one row per printer: name, model, state, job and progress, time left, nozzle and bed temperatures, and loaded filament. Mention the printers that are offline. If fleets exist (`slicerx_list_fleets`), group the rows by fleet. Change nothing.
