# Real-printer checklist

The connectors in `packages/connect` are tested against mock printers. This list is what to run on real hardware before a connector loses its "experimental" label or a release says it works. Run it on each printer you have, and keep the report folders: they hold no secrets, only states, timings and camera stills.

## Before you start

- Stay at the printer for every step that heats or moves it. Use a small first-layer test you sliced for that printer (a 20 mm square, one or two layers), with a clean plate.
- Start the hub: the desktop app, or `sx-link` on the machine that stays on. Add the printer in the app and check it shows as online.
- Have the app code ready. `sx-link code` prints it (on macOS it is in the keychain; the script reads it the same way), or set `SX_LINK_CODE`.

## Run the script

```
node packages/connect/link/deploy/scripts/real-printer-check.mjs --printer <id> --file <test.gcode>
```

It reads first (state, temperatures, bed record, limits, one camera still, a camera probe). Then it asks before each of these: start the test plate through the Print button path, pause and resume, set the part fan to 60 % and the speed to 100 %, try a 400 % speed (which must be refused), take watch frames, cancel, and confirm the plate is clear. It writes `real-printer-<id>-<time>/report.json` and the stills. `--steps read,camera` limits it to the reading steps. Use `--yes` only for a rerun when you are standing at the printer.

Exit code 0 means every step passed or was skipped. Attach the folder to an issue with the printer model and firmware version.

## What to check by eye

The script cannot see the printer. After each run, check these yourself:

- The still in the report folder shows the bed, the right way up, and is recent.
- The printer's own screen shows the fan and speed changes, and shows paused and then printing again.
- After the cancel, the hub says the bed is not cleared until you confirm it.

## Per connector

### Bambu Lab (P1, A1, X1, H2), LAN mode with the access code

- Upload over FTPS and start over MQTT work with LAN-only mode on and off.
- P1 and A1: the still comes from the camera port 6000 (`source: snapshot`).
- X1 and H2: the still is a decoded H.264 key frame (`source: stream`). Check it shows within about 8 s and the colors look right.
- Speed changes map to Bambu's levels: 50 % silent, 100 % standard, 124 % sport. Check the screen shows each one.
- Fans: part (P1), auxiliary (P2) and chamber (P3) each move the right fan. The script sets only the part fan; try the other two from the app.
- Wrong access code: the app says sign-in failed, with no retry storm.

### Klipper through Moonraker (Voron, Creality K1 with root, Sovol, others)

- `M106`, `M220`, `M104` and `M140` reach Klipper (check the console in Mainsail or Fluidd).
- The size and time check: after the test upload, replace the file under the same name from Mainsail, then start the old card's approval from the app. The hub must refuse it as unverified.
- Webcam still: the snapshot URL from Moonraker's webcam list works through crowsnest.

### OctoPrint

- API key login, upload, start, pause, resume, cancel.
- The size and time check, as for Moonraker, by replacing the file from OctoPrint's file list.
- The webcam still from the snapshot URL in OctoPrint's settings.

### PrusaLink (MK4, MK3.9, XL, Core One)

- Digest login with the password from the printer's network menu and no user name typed (`maker`).
- The storages `/api/v1/storage` lists, with and without a USB drive.
- Upload to the USB drive, start, pause, resume, cancel.
- Mid-print changes answer "not supported" (PrusaLink has no G-code console). That is expected.
- The still from the printer's camera endpoint where a camera is fitted.

### Elegoo (Centauri Carbon, SDCP)

- Discovery by broadcast, start, pause, resume, stop over the WebSocket.
- The status codes during a print, after it completes and after a stop (`CurrentStatus` and `PrintInfo.Status`), and the attributes reply (model, firmware, `RemainingMemory`).
- The camera stream URL from command 386 gives a still.
- Mid-print changes answer "not supported" until the SDCP command reference is confirmed.

### Snapmaker 2.0, J1 and Artisan

- A scan finds the machine (UDP 20054) and the reply names it; the J1 and Artisan say SACP is not supported.
- An A350 left idle drops its session and comes back on its own; after a power cycle, connecting says to pair again and the touchscreen shows no stray prompt.

### UltiMaker (S series)

- A scan finds the printer by multicast DNS with its model and firmware.
- Start sends the file and the printer prints it; pause, resume and cancel through the cluster API; the build plate prompt after the print.
- Print cores and materials read per extruder, and a camera still from port 8080.

## The hub itself

- Bed record: after a real print finishes, the bed reads `not_cleared` and the Print button asks about the plate. After "Plate removed" it reads `clear`. Start a print from the printer's own screen while the app is closed and check the bed record moves on (`busy`, then `not_cleared`).
- Scheduled start: schedule the test plate 10 minutes ahead, answer the card, leave the app closed, and check it starts on time. Then schedule one 3 hours ahead and check it asks about the plate again near its time.
- Phone alerts: with a real phone paired and alerts on, a finished print, a cancel and a pause each give one push. The text names no file or printer.
- Print watch: subscribe a detector (the script does), then report a finding from the app's developer tools with auto-pause on for that printer. The printer pauses, and `audit.jsonl` in the hub's state directory has a line with origin `watch`.
- Agent code: start the MCP server against the hub, ask it to print the test plate, and check the card appears in the app and that nothing runs until you approve it there.

## Deploy targets

### Raspberry Pi or other Linux box (systemd)

```
sudo install -m 0755 sx-link /usr/local/bin/sx-link
sudo useradd --system --home-dir /var/lib/slicerx-hub --shell /usr/sbin/nologin slicerx
sudo install -m 0644 packages/connect/link/deploy/sx-link.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sx-link
sudo -u slicerx sx-link code --state-dir /var/lib/slicerx-hub
```

Check `systemctl status sx-link`, `systemd-analyze security sx-link` (expect an exposure score under 2), and that the files in `/var/lib/slicerx-hub` are mode 0600. Reboot and check the hub comes back and the app reconnects without the code.

### Docker (a NAS, a home server)

```
docker compose -f packages/connect/link/deploy/docker-compose.yml up -d --build
docker compose -f packages/connect/link/deploy/docker-compose.yml exec sx-link sx-link code --state-dir /var/lib/slicerx-hub
```

The image has not been built in CI yet. Check that it builds on x86_64 and arm64, that host networking finds printers by mDNS, and that the state survives `docker compose down` and `up`.
