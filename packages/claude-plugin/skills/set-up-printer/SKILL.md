---
name: set-up-printer
description: Use when the user wants to connect a 3D printer to SlicerX or control printers from this assistant, for example "connect my Bambu P1S", "add my Voron", "set up Moonraker", "PrusaLink", "OctoPrint", "Creality K1", "Snapmaker", "Home Assistant", "Spoolman", or asks which printer actions the assistant is allowed to take.
---

# Set up a printer with SlicerX

SlicerX talks to printers on the user's local network. Printer traffic never goes through a SlicerX server, and credentials stay in the operating system keychain.

## Steps

1. Find the printer's connector: Bambu Lab (LAN mode), Klipper through Moonraker, Creality, Snapmaker, PrusaLink, OctoPrint, Duet (RepRapFirmware) or Elegoo. Spoolman and Home Assistant are services, not printers.
2. Read the guide as a resource before you answer, and follow its "For users" part: `slicerx://docs/printers/<name>`, for example `slicerx://docs/printers/bambu-lan` or `slicerx://docs/printers/moonraker`. `slicerx://docs/printers/README` lists them all. Walk the user through the steps on the printer (enable LAN mode, find the access code, IP address and serial, and so on) using only what the guide says; do not describe app screens or menus the guide does not mention. Pass on anything in its "Untested on hardware" section that applies.
3. Explain the bridge: this assistant reaches real printers through `sx-link`, a small program that runs on the user's computer, binds only to 127.0.0.1 and prints a pairing code when it starts. The plugin's MCP server needs `printers` set to `link` and that pairing code in the plugin's settings.
4. Secrets never go through the chat. Registering the printer with `sx-link` and storing its access code or API key is done in the SlicerX app's Printers workspace, which writes the secret to the operating system keychain. If the user already pasted a key or access code, do not repeat it anywhere in your answer; tell them it is now in the chat history, that they should enter it in the app instead, and that rotating it is safest.
5. Confirm the connection with `slicerx_printer_list` and `slicerx_printer_status`. If their output says the printers are simulated (demo mode), tell the user that what they see is the demo, not their printer, and that their own printer appears once the plugin is set to `link` with sx-link running.

## Permissions

Explain the permission policy before the first printer action. The file is `~/.config/slicerx/mcp-policy.json`, with Allow, Ask first or Off for each class:

- `slice` (project changes): Allow by default.
- `queue` (send a job) and `start` (heat or move the printer, pause, resume, cancel): Ask first by default. `start` can be Allow only per printer.
- `profile` (saved profiles and inventory): Ask first.

`slicerx_get_policy` shows the current policy. The user edits the file themselves; no tool can change it. When a tool returns `status: "approval_required"`, show the request and call `slicerx_approve` only with the user's answer.
