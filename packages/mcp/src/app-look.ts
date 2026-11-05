// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// View preferences of the open app, through the app link: Frame the view (whether Model frames each pick, or only
// when it opens or an object is added), Toolbar size (the Model ribbon's icons) and the 3D mouse (Settings > Controls).
// They change how the window behaves, never the project, so both tools read. Each answer is the preferences read back,
// with the 3D view's look (the preset the theme picked and its values). No other setting is reachable.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { appClientSetupMessage, type AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'

/** The 3D mouse moves the view reads and sets: pan left and right, pan up and down, zoom, tilt and spin. */
export const SPACE_MOUSE_AXES = ['panX', 'panY', 'zoom', 'tilt', 'spin'] as const
export type SpaceMouseAxis = (typeof SPACE_MOUSE_AXES)[number]

/** Settings > Controls > 3D mouse as the app reads it back, with where the device stands. */
export interface AppSpaceMouse {
  enabled: boolean
  /** Speed multiplier, 0.25 to 4. */
  sensitivity: number
  invert: Record<SpaceMouseAxis, boolean>
  /** Only the strongest axis moves the view at a time. */
  dominantAxis: boolean
  /**
   * unsupported: this window cannot reach a 3D mouse (a browser without WebHID); off; none: on, no device found or
   * connected yet; connected; busy: the device could not be opened, often because its maker's driver keeps it; error.
   */
  status: 'unsupported' | 'off' | 'none' | 'connected' | 'busy' | 'error'
  /** The device's name, when one is connected or busy. */
  device?: string
}

/** The view preferences as the app reads them back (packages/app app-link/methods.ts, look.get). */
export interface AppLook {
  toolbarSize: 'large' | 'medium' | 'small'
  /** Absent from an app older than the 3D mouse setting. */
  spaceMouse?: AppSpaceMouse
  /** Absent in an edition without Model's modeling tools. */
  modelFraming?: 'selection' | 'open'
  /** Present on apps with edition visual tokens. Omitted glyph colors follow the studio background. */
  theme?: {
    scheme: 'dark' | 'light'
    visuals: Record<string, string>
    overrides: Record<string, string>
    /** The studio colors in use (top, bottom, glow, plate, grid, edge, xray: the --scene-* properties). */
    scene?: Record<string, string>
    /** The studio colors the edition config sets for this scheme (brand.theme tokens.scene, then light or dark scene). */
    sceneOverrides?: Record<string, string>
  }
  /**
   * The 3D view's look, absent while no 3D view is up: the preset the theme picked (dark-precision on a dark theme,
   * light-studio on a light one), whether the theme kept its own backdrop colors, and the full look as the view reads
   * it back (backdrop, plate, lighting, materials, geometry; @slicerx/viewport ViewportLook).
   */
  viewport?: { preset: 'dark-precision' | 'light-studio'; themeBackdrop: boolean; look: { version: number } & Record<string, unknown>; scene?: Record<string, string> }
}

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', not_found: 'not_supported', busy: 'busy', read_only: 'not_supported', denied: 'not_supported' }
const OFF = ['app_link_off', 'app_closed', 'forbidden', 'unauthorized']

async function call(link: AppLinkCaller | undefined, appName: string, method: string, args: Record<string, unknown>): Promise<AppLook> {
  if (!link) throw new ToolInputError(`Needs ${appName} open with the app link on (start this server with --printers link).`, 'not_configured')
  try {
    return await link.call<AppLook>(method, args)
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? '')
    const message = e instanceof Error ? e.message : String(e)
    if (code === 'unauthorized') throw new ToolInputError(appClientSetupMessage(appName), 'not_configured', { appLink: code })
    if (OFF.includes(code)) throw new ToolInputError(`${appName} is closed, its app link is off, or this client is not allowed on it, so its view preferences cannot be read.`, 'not_configured', { appLink: code })
    throw new ToolInputError(message, CODES[code] ?? 'internal_error')
  }
}

const SIZE_WORDS: Record<AppLook['toolbarSize'], string> = { large: 'Large (32 px)', medium: 'Medium (24 px)', small: 'Small (16 px)' }
const FRAMING_WORDS: Record<NonNullable<AppLook['modelFraming']>, string> = { selection: 'Always', open: 'On open and add' }
const PRESET_WORDS: Record<NonNullable<AppLook['viewport']>['preset'], string> = { 'dark-precision': 'Dark precision', 'light-studio': 'Light studio' }

const STATUS_WORDS: Record<AppSpaceMouse['status'], string> = { unsupported: 'not available in this window', off: 'off', none: 'on, no device connected', connected: 'on, connected', busy: 'on, the device is held by another program', error: 'on, the device failed' }

function summary(l: AppLook): string {
  const view = l.viewport ? `; 3D view look: ${PRESET_WORDS[l.viewport.preset] ?? l.viewport.preset}${l.viewport.themeBackdrop ? " with the theme's backdrop" : ''}` : ''
  const sm = l.spaceMouse
  const mouse = sm ? `; 3D mouse ${STATUS_WORDS[sm.status] ?? sm.status}${sm.device ? ` (${sm.device})` : ''}, sensitivity ${sm.sensitivity}` : ''
  return `Toolbar size ${SIZE_WORDS[l.toolbarSize]}${l.modelFraming ? `; Frame the view: ${FRAMING_WORDS[l.modelFraming]}` : ''}${mouse}${view}.`
}

export function appLookTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  const get = defineTool({
    name: 'app.look',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    description: `Read the view preferences of ${appName} (Settings, Look and feel, and the 3D mouse in Settings, Controls): toolbarSize (large, medium or small, the Model ribbon's icons at 32, 24 or 16 px) and modelFraming (selection: Model frames the view on every pick; open: only when Model opens or an object is added; absent in an edition without Model's modeling tools). Also reads theme.scheme, theme.visuals (the active CSS color properties), theme.overrides (shared plus active edition overrides), theme.scene (the studio colors in use: top, bottom, glow, plate, grid, edge, xray) and theme.sceneOverrides (the studio colors the edition config sets); omitted glyph colors follow the studio background. Also reads spaceMouse, Settings, Controls, 3D mouse: enabled, sensitivity (0.25 to 4, 1 is normal speed), invert (panX, panY, zoom, tilt, spin, each true when that direction is flipped), dominantAxis (only the strongest axis moves the view), status (unsupported: this window cannot reach a 3D mouse; off; none: on, no device connected yet; connected; busy: the device could not be opened, often because its maker's driver keeps it; error) and device (its name when connected or busy). Also reads viewport, the 3D view's look: preset (dark-precision on a dark theme, light-studio on a light one; the theme picks it), themeBackdrop (true when a theme other than Subban keeps its own backdrop colors) and look (backdrop, plate, lighting, materials and geometry values the view draws with) and scene (the colors the view was given: bgTop, bgBottom, bgGlow, plateSide, floorGrid, edgeDark, edgeXray, selection, liveLayer, originPlane, addPreview, and the move, rotate and scale handle colors axisX, axisY, axisZ, axisUniform, handleHot, handlePinned and handleHalo); absent while no 3D view is up. Reads through the app link; the app must be open with the link on.`,
    input: z.object({}),
    async run() {
      const out = await call(link, appName, 'look.get', {})
      return { summary: summary(out), output: out }
    },
  })
  const setLook = defineTool({
    name: 'app.look_set',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    description: `Set ${appName}'s Frame the view (modelFraming: selection or open), Toolbar size (toolbarSize: large, medium or small) and the 3D mouse (spaceMouse: any of enabled, sensitivity, invert, dominantAxis), the way the person does in Settings, Look and feel and Settings, Controls. A spaceMouse field left out keeps its value. Turning the 3D mouse on lets it move the camera and press the view's reset and fit buttons, nothing else. In the desktop app it starts reading a plugged-in 3D mouse at once (opened shared, and the setting is saved for the next launch); in a browser it reaches only a device the person already connected, and only the person can connect a new one (the browser asks them). These change how the window behaves, never the project; no other setting can be changed here. Returns the preferences read back.`,
    input: z
      .object({
        modelFraming: z.enum(['selection', 'open']).optional().describe('selection: frame the view on every pick; open: only when Model opens or an object is added'),
        toolbarSize: z.enum(['large', 'medium', 'small']).optional().describe("The Model ribbon's icon size: 32, 24 or 16 px"),
        spaceMouse: z
          .object({
            enabled: z.boolean().optional().describe('Use a 3D mouse to pan, zoom and orbit the view'),
            sensitivity: z.number().min(0.25).max(4).optional().describe('Speed multiplier, 0.25 to 4; 1 is normal'),
            invert: z
              .object(Object.fromEntries(SPACE_MOUSE_AXES.map((a) => [a, z.boolean().optional()])) as Record<SpaceMouseAxis, z.ZodOptional<z.ZodBoolean>>)
              .strict()
              .optional()
              .describe('Flip a direction: panX (pan left and right), panY (pan up and down), zoom, tilt, spin'),
            dominantAxis: z.boolean().optional().describe('Only the strongest push or twist moves the view'),
          })
          .strict()
          .refine((m) => Object.keys(m).length > 0, { message: 'Give at least one 3D mouse field.' })
          .optional(),
      })
      .refine((i) => i.modelFraming !== undefined || i.toolbarSize !== undefined || i.spaceMouse !== undefined, { message: 'Give modelFraming, toolbarSize, spaceMouse or more than one.' }),
    async run(i) {
      const out = await call(link, appName, 'look.set', { ...(i.modelFraming ? { modelFraming: i.modelFraming } : {}), ...(i.toolbarSize ? { toolbarSize: i.toolbarSize } : {}), ...(i.spaceMouse ? { spaceMouse: i.spaceMouse } : {}) })
      return { summary: summary(out), output: out }
    },
  })
  return [get, setLook] as PilotTool<never>[]
}
