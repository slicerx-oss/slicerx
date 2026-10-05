# Save G-code (no connection)

For printers SlicerX cannot talk to: the Snapmaker J1 and Artisan, Marlin printers with no network, and anything else without a supported interface. SlicerX slices as usual and you carry the file over.

## For users

1. Add the printer from the catalog. Pick the model, or Printer without a connection if yours is not listed.
2. Slice the plate and choose Save G-code. Bambu Lab printers take `.gcode.3mf`; almost everything else takes `.gcode`.
3. Copy the file to a USB drive or SD card, put it in the printer, and start it from the printer's own screen.

If the printer runs Klipper, sits behind OctoPrint, or has a Duet board, choose that connection instead and SlicerX can send the file and start it for you.

## For integrators

There is no plugin behind this connection. The catalog names it `export` (see [printer-catalog.md](printer-catalog.md)), and the app shows the save action instead of the send action for printers that have only this connection.
