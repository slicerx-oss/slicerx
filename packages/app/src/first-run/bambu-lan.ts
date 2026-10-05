// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a Bambu Lab printer needs before SlicerX can reach it on the network: LAN Only Mode and
// Developer Mode. Where both switches are, per model family, and what turning them on changes.

export type BambuFamily = 'x1' | 'p1' | 'a1' | 'h2'

export interface BambuGuide {
  family: BambuFamily
  /** The family as a tab label. */
  label: string
  models: string
  /** The screens from the home screen to LAN Only Mode, as the printer names them. */
  path: readonly string[]
  /** Where LAN Only Mode is, in screen order. */
  lanOnly: string
  /** How to reach the page with Developer Mode on it, from the home screen. */
  developerWhere: string
  developer: string
  accessCode: string
}

// From Bambu Lab's wiki, "How to enable Developer Mode on Bambu Lab printers" and "How to Connect the
// Printer Using the Access Code" (wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode and
// .../access-code-connect), with the A series' third settings page and the firmware that brought
// Developer Mode from docs/printer-connect-guide.md. The LAN Only page shows the IP address and the
// access code.
export const BAMBU_GUIDES: readonly BambuGuide[] = [
  {
    family: 'x1',
    label: 'X1',
    models: 'X1 Carbon, X1, X1E',
    path: ['Settings', 'LAN Only'],
    lanOnly: 'On the touchscreen, open Settings, then LAN Only, and turn on LAN Only Mode.',
    developerWhere: 'On the touchscreen, open Settings, then LAN Only.',
    developer: 'On the same page, turn on Developer Mode (firmware 01.08.03.00 and later), read the notice, tick the box and choose Enable Developer Mode. The button turns green.',
    accessCode: 'The access code and the IP address are on the LAN Only page.',
  },
  {
    family: 'p1',
    label: 'P1',
    models: 'P1S, P1P',
    path: ['Settings', 'WLAN', 'LAN Only Mode'],
    lanOnly: 'On the printer screen, open Settings, then WLAN, then LAN Only Mode, and choose Yes. It shows ON.',
    developerWhere: 'On the printer screen, open Settings, then WLAN.',
    developer: 'Scroll down to Developer Mode (firmware 01.08.02.00 and later), read the notice to the end and choose Enable. It shows ON.',
    accessCode: 'The access code is on the same WLAN page.',
  },
  {
    family: 'a1',
    label: 'A1',
    models: 'A1, A1 mini',
    path: ['Settings', 'Page 3', 'LAN Only Mode'],
    lanOnly: 'On the touchscreen, open Settings, swipe to page 3, tap LAN Only Mode, and turn it on. The button turns green.',
    developerWhere: 'On the touchscreen, open Settings, swipe to page 3 and tap LAN Only Mode.',
    developer: 'On the same page, turn on Developer Mode (firmware 01.05.00.00 and later), read the notice, tick the box and choose Enable.',
    accessCode: 'The access code is on the LAN Only Mode page; the IP address is on the WLAN page.',
  },
  {
    family: 'h2',
    label: 'H2',
    models: 'H2D, H2S, H2C, P2S',
    path: ['Settings', 'LAN Only'],
    lanOnly: 'On the touchscreen, open Settings, then LAN Only, and turn on LAN Only Mode. Turn on LAN Only Liveview too if you want the camera.',
    developerWhere: 'On the touchscreen, open Settings, then LAN Only.',
    developer: 'On the same page, turn on Developer Mode (H2D firmware 01.01.00.01 and later), read the notice, tick the box and choose Enable Developer Mode. The button turns green.',
    accessCode: 'The access code and the IP address are on the LAN Only page.',
  },
]

/** What LAN Only Mode changes, in plain words, before anyone turns it on. */
export const LAN_ONLY_EFFECT =
  'While LAN Only Mode is on, the printer is off Bambu Cloud: Bambu Handy and the cloud features of Bambu Studio stop working (watching or starting prints away from home, cloud print history, app notifications). Printing from this computer on your home network keeps working. You can turn it off again on the printer at any time.'

/** Why Developer Mode, too. */
export const DEVELOPER_EFFECT =
  'Developer Mode opens the printer\'s local connection (status, file upload and live view) to apps other than Bambu Lab\'s own. Without it, the printer refuses prints and controls from this app.'

/** The family a model name belongs to (H2D, "Bambu Lab A1 mini", X1 Carbon). Null for anything else. */
export function bambuFamily(model: string | undefined): BambuFamily | null {
  const m = (model ?? '').toUpperCase().replace(/^BAMBU LAB\s+/, '').trim()
  if (/^X1/.test(m)) return 'x1'
  if (/^P1/.test(m)) return 'p1'
  if (/^A1/.test(m)) return 'a1'
  if (/^(H2|P2|X2)/.test(m)) return 'h2'
  return null
}

export function bambuGuide(family: BambuFamily): BambuGuide {
  return BAMBU_GUIDES.find((g) => g.family === family) ?? BAMBU_GUIDES[0]!
}
