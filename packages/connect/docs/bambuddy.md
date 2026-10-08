# BamBuddy

Links a printer that is already in SlicerX to the printer BamBuddy knows. Status, AMS slots, library upload, queue, start, pause, resume and cancel go through BamBuddy. SlicerX does not open a second path to that printer.

## For users

### On BamBuddy

1. Open BamBuddy and confirm the printer is in its printer list. Note the printer's number. That number is the link, including a printer BamBuddy reaches through a bridge.
2. Create an API key that can read printers, upload to the library, create queue items, and control printers (the control scope is what writes an AMS slot).
3. Read the address of the computer BamBuddy runs on. The port is 8000 unless you set `PORT`.

### In SlicerX

1. Add the printer from the catalog first, the same way you would without BamBuddy. Then choose BamBuddy as the connection.
2. Enter the BamBuddy computer's address, the API key, and the printer number. SlicerX stores the key in your keychain.
3. The address has to be on your local network: a private IP address, or a name ending in `.local`, `.lan`, or `.home.arpa`.
4. Slice with the printer's own profile (a Voron stays a Voron). The file BamBuddy stores is labeled as the Bambu model that printer is in BamBuddy. A Voron that BamBuddy shows as an A1 Mini is labeled `Bambu Lab A1 Mini`. The bed size and start G-code in the file stay the machine you sliced. When BamBuddy does not say which model that printer is, a non-Bambu profile is labeled as an A1 Mini, and a Bambu profile keeps its own model.

### Network and firewall

TCP 8000 on the BamBuddy computer, unless you changed `PORT`.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | The API key is missing a scope, or it is not the key for this BamBuddy. |
| "not found" | The printer number is not a printer BamBuddy has. |
| "is unreachable" | Wrong address or port, or BamBuddy is not running. |
| The print sits in BamBuddy | Start adds a queue item. BamBuddy starts it when that printer is idle. |
| An AMS slot will not take a setting | The external spool is set on the printer. AMS trays are A1 to D4. A spool with an RFID tag sets itself. |

### Untested on hardware

Checked against BamBuddy's API, not a running farm. First things to check: the printer number, that `remaining_time` is still minutes, and that a queued `.gcode.3mf` starts with the slot map you sent.

## For integrators

Plugin id `bambuddy`. Capabilities: status, events, upload, start, pause, resume, cancel, filament slots, `project_file`, `slot_write`. No camera and no G-code console. Discover returns nothing.

Printer config: `host`, optional `port` (8000), `credentialRef` for the API key, `serial` for BamBuddy's printer id.

### Requests

`GET /api/v1/printers/{id}/status` on connect and on each poll. Upload reads `GET /api/v1/printers/{id}` for `model`, stamps the `.gcode.3mf` identity when the slice is not already that model, then `POST /api/v1/library/files` (multipart field `file`). The returned file id is what start uses. With no model from that GET, a non-Bambu profile is stamped `Bambu Lab A1 Mini` / `N1` and a Bambu profile is uploaded as sliced. Start is `POST /api/v1/queue/` with `library_file_id`, `printer_id`, `manual_start` false, and the sheet's plate, calibration options and `ams_mapping` when a map was approved. Pause, resume and cancel are `POST /api/v1/printers/{id}/print/pause|resume|stop`. A slot write is `POST /api/v1/printers/{id}/slots/{ams}/{tray}/configure`.

`remaining_time` is minutes. `progress` is a percent. AMS units 0 to 3 map to slots A1 to D4. The virtual tray is slot `1`. An empty tray (`state` 9) has no material.

### Events and rate

Polled every `pollMs` (default 1000).

### Sources

BamBuddy's HTTP API: https://github.com/maziggy/bambuddy
