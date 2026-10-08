# BamBuddy

Links a printer that is already in SlicerX to the printer BamBuddy knows. Status, AMS slots, library upload, queue, start, pause, resume and cancel go through BamBuddy. SlicerX does not open a second path to that printer.

## For users

### On BamBuddy

1. Open BamBuddy and confirm the printer is in its printer list. Note the printer's number. That number is the link, including a printer BamBuddy reaches through a bridge.
2. Create an API key that can read printers, upload to the library, create queue items, and control printers (the control scope is what writes an AMS slot).
3. Read the address of the computer BamBuddy runs on. The port is 8000 unless you set `PORT`.

### In SlicerX

1. Add BamBuddy once, in Settings, Connected apps: the BamBuddy computer's address and the API key. SlicerX stores the key in your keychain. The card shows whether BamBuddy answers and how many printers it lists.
2. The address has to be on your local network: a private IP address, or a name ending in `.local`, `.lan`, or `.home.arpa`.
3. Add the printer from the catalog, the same way you would without BamBuddy. Its own connection stays the first choice; BamBuddy is offered next to it once BamBuddy is added. Choose BamBuddy and enter the printer number.
4. Changing BamBuddy's address or key in Connected apps changes it for every printer that goes through BamBuddy. Removing BamBuddy there leaves those printers without a connection until it is added again.
4. Slice with the printer's own profile (a Voron stays a Voron). A file that is not already a Bambu profile is labeled as the Bambu model BamBuddy has for that printer. A Voron that BamBuddy shows as an A1 Mini is labeled `Bambu Lab A1 Mini`. The bed size and start G-code stay the machine you sliced. A Bambu profile that matches the printer is stored as sliced. A Bambu profile for a different model is not uploaded: the message names both models. When BamBuddy answers and the printer has no model, a non-Bambu profile is labeled as an A1 Mini. If that lookup fails, the upload stops.

### Network and firewall

TCP 8000 on the BamBuddy computer, unless you changed `PORT`.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | The API key is missing a scope, or it is not the key for this BamBuddy. |
| "not found" | The printer number is not a printer BamBuddy has. |
| "is unreachable" | Wrong address or port, or BamBuddy is not running. |
| "add BamBuddy in Settings, Connected apps first" | BamBuddy was removed from Connected apps, or never added. |
| BamBuddy is not offered as a connection | Add BamBuddy in Settings, Connected apps. It is offered only after that. |
| The print sits in BamBuddy | Start adds a queue item. BamBuddy starts it when that printer is idle. |
| An AMS slot will not take a setting | The external spool is set on the printer. AMS trays are A1 to D4. A spool with an RFID tag sets itself. |

### Untested on hardware

Checked against BamBuddy's API, not a running farm. First things to check: the printer number, that `remaining_time` is still minutes, and that a queued `.gcode.3mf` starts with the slot map you sent.

## For integrators

Plugin id `bambuddy`. Capabilities: status, events, upload, start, pause, resume, cancel, filament slots, `project_file`, `slot_write`, `rewrites_upload`. No camera and no G-code console. Discover returns nothing.

BamBuddy is a connected app: `services.configure` with `pluginId` `bambuddy`, its `baseUrl`, and `secretRef` naming the API key in the secrets store. `services.check` reads `GET /api/v1/printers` and returns how many printers it lists.

Printer config: `serial` is BamBuddy's printer id. Each time the hub connects, tests or adds the printer, it fills `host`, `port`, `tls` and `credentialRef` from the connected app, so a printer stores nothing about the server. With no BamBuddy in Connected apps, those calls fail with `not_configured`.

`rewrites_upload`: an upload is prepared (stamped) before its approval, so the approval covers the posted bytes. Queueing a plate stores it as given and does not connect; it is prepared when it starts.

### Requests

`GET /api/v1/printers/{id}/status` on connect and on each poll. Upload reads `GET /api/v1/printers/{id}` for `model`. A timeout, a 401, or any other failed lookup fails the upload. A `.gcode.3mf` that is not already a Bambu profile is stamped with that model, then posted to `POST /api/v1/library/files` (multipart field `file`). A Bambu profile that does not match the printer is refused. An empty `model` on a successful reply stamps a non-Bambu profile `Bambu Lab A1 Mini` / `N1` and leaves a Bambu profile as sliced. The sha256 on the upload approval is the sha256 of the posted bytes. The returned file id is what start uses. Start is `POST /api/v1/queue/` with `library_file_id`, `printer_id`, `manual_start` false, and the sheet's plate, calibration options and `ams_mapping` when a map was approved. Pause, resume and cancel are `POST /api/v1/printers/{id}/print/pause|resume|stop`. A slot write is `POST /api/v1/printers/{id}/slots/{ams}/{tray}/configure`.

`remaining_time` is minutes. `progress` is a percent. AMS units 0 to 3 map to slots A1 to D4. The virtual tray is slot `1`. An empty tray (`state` 9) has no material.

### Events and rate

Polled every `pollMs` (default 1000).

### Sources

BamBuddy's HTTP API: https://github.com/maziggy/bambuddy
