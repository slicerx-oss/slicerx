// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Help pane content for setup, shared by the help pane and the assistant's setup skill. Topics are keyed by step and
// field so the pane can follow the focused field. Bodies are short and link off product only to
// the maker's own documentation. Screen names on printers come from the catalog's find guides.
import { connectionMethod, type ConnectionId, type PrinterModel } from '@slicerx/printer-catalog'
import { appName, branded } from '../edition'

export interface HelpTopic {
  id: string
  title: string
  /** Short markdown: paragraphs and `**bold**` only. */
  body: string
  steps?: string[]
  /** An illustration drawn in the SlicerX icon language, by name. */
  image?: 'nozzle-stamp'
}

export type HelpField = 'scan' | 'brand' | 'model' | 'firmware' | 'nozzle' | 'nozzle-type' | 'toolhead' | 'filament' | 'connection' | 'host' | 'port' | 'serial' | 'accessCode' | 'apiKey' | 'username' | 'password' | 'pairing' | 'test'

// Title and body name the app as {app}, filled in when read (the edition is known by then).
const T = (id: string, title: string, body: string, steps?: string[], image?: HelpTopic['image']): HelpTopic => ({
  id,
  get title() {
    return branded(title)
  },
  get body() {
    return branded(body)
  },
  ...(steps ? { steps } : {}),
  ...(image ? { image } : {}),
})

export const TOPICS: Readonly<Record<string, HelpTopic>> = {
  'printer.scan': T(
    'printer.scan',
    'Finding your printer',
    '{app} asks the printers on your network to announce themselves and reads what they say: the model, the nozzle and the filament unit. Nothing signs in until you pick one.\n\n**Not in the list?** The printer must be on the same network as this computer, switched on, and allowed to be found: Bambu Lab printers need LAN Only Mode and Developer Mode, Klipper printers need Moonraker. Or enter its IP address.',
  ),
  'look.overview': T(
    'look.overview',
    'Choosing a look and feel',
    'A preset changes the mouse controls, keyboard shortcuts and where things sit on screen. It never changes your settings or the G-code. Pick the one closest to the slicer your hands already know.',
  ),
  'look.controls': T(
    'look.controls',
    'Mouse buttons and zoom',
    'Each preset has its own mouse map. Under Adjust controls you can set each button to Rotate, Pan or None, invert the zoom, zoom toward the cursor and turn on the free camera. Your changes stay when you switch presets.',
  ),
  'look.later': T('look.later', 'Changing it later', 'Everything here is in Settings later. Open the command bar and type "look and feel" to come back to this screen.'),
  'printer.brand': T('printer.brand', 'Which brand', 'Pick the maker of the printer. Not listed? Choose Other and set the bed and nozzle yourself.'),
  'printer.model': T(
    'printer.model',
    'Finding the model name',
    'The model name is on the label at the back or bottom of the printer, next to the serial number. It is also on the box and on the printer screen under About or Device.',
    ['Look for the label with the serial number.', 'The model is the short name printed above it, such as P1S or MK4S.', 'Printers set up by hand: choose the entry for your firmware.'],
  ),
  'printer.firmware': T(
    'printer.firmware',
    'What firmware means',
    'Firmware is the program on the printer\'s board. **Marlin** runs on most printers with a small screen and a knob. **Klipper** runs on a separate computer and opens in Mainsail or Fluidd. **RepRapFirmware** runs on Duet boards. {app} writes G-code in the flavor the firmware expects.',
  ),
  'printer.nozzle': T(
    'printer.nozzle',
    'Which nozzle do I have?',
    'The diameter is stamped on the flats of the nozzle, for example 0.4. Most printers ship with 0.4 mm brass. Bambu Lab hotends show the size on the silicone sock or the hotend label. Not sure? Choose Not sure and {app} assumes 0.4 mm brass and asks you to confirm it later in Printers.',
    undefined,
    'nozzle-stamp',
  ),
  'printer.nozzle-type': T(
    'printer.nozzle-type',
    'Nozzle material',
    'Brass is the default and fine for PLA, PETG, ABS and TPU. **Hardened steel is required for carbon fiber and glow filaments**, which wear brass out within hours. High flow nozzles have a longer melt zone for faster printing.',
  ),
  'printer.toolhead': T(
    'printer.toolhead',
    'Direct drive or Bowden',
    'Direct drive has the extruder motor on the print head. Bowden pushes filament through a long tube from a motor on the frame. Bowden needs longer retraction; {app} sets it from this choice.',
  ),
  'printer.filament': T(
    'printer.filament',
    'Filament system',
    'Choose the unit that feeds filament: a single spool, an AMS (up to 4 units of 4 slots), an MMU, or another multi-material unit. Spools and colors are set later in Printers.',
  ),
  'printer.connection': T(
    'printer.connection',
    'Connecting {app}',
    'A connection lets {app} send files and read status. It is optional: choose No connection to save G-code and carry it over on USB or an SD card. Nothing is sent until you test or print.',
  ),
  'printer.test': T(
    'printer.test',
    'Testing the connection',
    'The test reaches the printer, signs in, reads its state and reads its temperatures. It changes nothing on the printer. If it fails, the card names the step and one thing to try.',
  ),
  'printer.secret': T(
    'printer.secret',
    'Where codes and keys are kept',
    'Access codes, API keys and passwords are stored in your system keychain only. They are shown masked, never logged and never written to files.',
  ),
}

/** Per connection field topics; the catalog's find guide for the model wins when it has one. */
function connectionTopic(id: ConnectionId, field: HelpField, model?: PrinterModel): HelpTopic | null {
  const m = connectionMethod(id)
  const find = model?.find
  const tid = `connection.${id}.${field}`
  switch (id) {
    case 'bambu-lan':
      if (field === 'host') return T(tid, 'Printer IP address', find?.ip ?? 'On the printer touchscreen: Settings, Network. The IP address is shown with the network name.')
      if (field === 'accessCode') return T(tid, 'Access code', find?.credential ?? 'In the printer\'s settings, open the LAN Only page and turn on LAN Only Mode and Developer Mode. The 8-character access code is shown there.')
      if (field === 'serial') return T(tid, 'Serial number', find?.serial ?? 'Printed on the label at the back of the printer.')
      break
    case 'moonraker':
      if (field === 'host' || field === 'port') return T(tid, 'Moonraker address', 'Open Mainsail or Fluidd in a browser and copy the address. Moonraker listens on port 7125, for example http://printer.local:7125.')
      if (field === 'apiKey') return T(tid, 'API key', find?.credential ?? 'Usually not needed. If the test says it was rejected, add your network to trusted_clients in moonraker.conf, or use the API key Moonraker shows.')
      break
    case 'prusalink':
      if (field === 'host') return T(tid, 'PrusaLink address', find?.ip ?? 'On the printer: Settings, Network. The IP address is shown there.')
      if (field === 'apiKey' || field === 'username' || field === 'password') return T(tid, 'PrusaLink login', find?.credential ?? 'On the printer: Settings, Network, PrusaLink. It shows the user name, password and API key.')
      break
    case 'octoprint':
      if (field === 'host' || field === 'port') return T(tid, 'OctoPrint address', 'The address you open OctoPrint at. OctoPi uses port 80, other installs often 5000.')
      if (field === 'apiKey') return T(tid, 'OctoPrint API key', `Create one in OctoPrint under Settings, Application keys. Name it ${appName()}.`)
      break
    default:
      if (field === 'host') return T(tid, `${m.name} address`, find?.ip ?? m.discovery.detail)
      if (field === 'password' || field === 'apiKey') return T(tid, 'Password', find?.credential ?? m.summary)
      if (field === 'pairing') return T(tid, 'Pairing on the printer', 'Snapmaker 2.0 machines ask you to confirm on their touchscreen once. Keep the printer screen in view when you test.')
  }
  return null
}

/**
 * The topic for a step and field. Connection fields use the chosen connection and model, so the
 * pane tells a Bambu Lab owner where their own screen shows the address.
 */
export function topicFor(step: 'look' | 'printer', field: HelpField | null, ctx: { connection?: ConnectionId | null; model?: PrinterModel } = {}): HelpTopic {
  if (step === 'look') return field === 'connection' ? TOPICS['look.controls']! : TOPICS['look.overview']!
  if (field && ctx.connection && ctx.connection !== 'export') {
    const t = connectionTopic(ctx.connection, field, ctx.model)
    if (t) return t
  }
  const key = field === 'accessCode' || field === 'apiKey' || field === 'password' ? 'printer.secret' : field && field !== 'host' && field !== 'port' && field !== 'serial' && field !== 'username' && field !== 'pairing' ? `printer.${field}` : 'printer.connection'
  return TOPICS[key] ?? TOPICS['printer.brand']!
}

/** Topic by id, for citations. */
export function topicById(id: string): HelpTopic | undefined {
  return TOPICS[id]
}

/** Plain words for a test failure: what happened, and one thing to do. */
export interface FailureHelp {
  title: string
  cause: string
  action: string
}

export type TestCause = 'unreachable' | 'auth' | 'lan-mode-off' | 'timeout' | 'wrong-port' | 'certificate' | 'protocol' | 'not_supported' | 'bad_request'

export const FAILURE_HELP: Readonly<Record<TestCause, FailureHelp>> = {
  unreachable: {
    title: 'The printer did not answer',
    cause: 'Nothing answered at that address. The printer may be off, on another network, or its IP address changed.',
    action: 'Check that this computer and the printer are on the same network, and read the IP address on the printer again. A firewall can also block it.',
  },
  auth: { title: 'The printer refused the code', cause: 'The printer answered but did not accept the access code or key.', action: 'Re-enter the access code or key. Bambu Lab printers make a new code each time LAN Only Mode is switched on.' },
  'lan-mode-off': { title: 'LAN Only Mode is off', cause: 'The printer answered but does not accept local connections.', action: 'In the printer\'s settings, open the LAN Only page and turn on LAN Only Mode and Developer Mode, then test again.' },
  timeout: { title: 'The printer took too long', cause: 'The printer started to answer, then stopped. A weak Wi-Fi signal or a busy printer can do this.', action: 'Wait a moment and test again. Move the printer closer to the router if it keeps happening.' },
  'wrong-port': { title: 'Wrong port', cause: 'Something answered at that address, but not the printer service on this port.', action: 'Clear the port field to use the default, or copy the port from the address you open in a browser.' },
  certificate: { title: 'Certificate not trusted', cause: 'The printer uses a certificate it signed itself, so it cannot be checked against a known authority.', action: 'Compare the fingerprint with the one the printer shows, then trust this printer\'s certificate.' },
  protocol: { title: 'Unexpected answer', cause: 'Something answered, but it does not look like this kind of printer.', action: 'Check the connection type. A Klipper printer uses Moonraker even if the maker also sells a cloud app.' },
  not_supported: { title: 'Not supported yet', cause: 'This connection type cannot be tested from this build.', action: 'Continue without testing, or use the desktop app, which can reach printers on your network.' },
  bad_request: { title: 'Check the address', cause: 'The address is not a printer on your own network.', action: 'Use the local IP address shown on the printer, such as 192.168.1.50.' },
}
