// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer_setup: walks a new user through adding a printer. The skill tool is
// read only: it looks at what is known, finds the brand and model in the
// printer catalog and says which single question comes next. The tools that
// change something or contact a printer (`setup.look`, `printer_test`,
// `printer_add`) each ask first. Access codes and API keys are typed into a
// secure field the host shows; they never pass through the chat.
import type { Cell, LookId } from '@slicerx/contracts'
import { LOOK_IDS, LOOK_OPTIONS } from '@slicerx/contracts'
import { BRANDS, brandsWithModels, connectionMethod, modelById, modelsForBrand, type ConnectionField, type ConnectionId, type PrinterModel } from '@slicerx/printer-catalog'
import { z } from 'zod'
import type { SetupAddInput, SetupConnection } from '../../src/hosts'
import { defineSkill, type ToolContext } from '../../src/tool'
import { arr, obj, oneLine, strs } from '../d_common/index'

// ---------------------------------------------------------------------------
// Catalog lookups (@slicerx/printer-catalog is the one source)

const norm = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)
const flat = (s: string): string => norm(s).join('')

export function findBrand(text: string) {
  const t = flat(text)
  if (!t) return []
  const all = brandsWithModels()
  const exact = all.filter((b) => b.id === text.toLowerCase() || flat(b.name) === t || flat(b.id) === t)
  if (exact.length) return exact
  return all.filter((b) => flat(b.name).includes(t) || t.includes(flat(b.name)) || flat(b.id).includes(t))
}

/** Models of a brand whose name or id holds every word of the text; an exact name match wins alone. */
export function findModel(brandId: string, text: string): PrinterModel[] {
  const brand = BRANDS.find((b) => b.id === brandId)
  const words = norm(text).filter((w) => !norm(brand?.name ?? '').includes(w))
  if (words.length === 0) return []
  const models = modelsForBrand(brandId)
  const joined = words.join('')
  const exact = models.filter((m) => flat(m.name) === joined || m.id === text.toLowerCase() || flat(m.name) === flat(text))
  if (exact.length) return exact
  return models.filter((m) => {
    const hay = new Set([...norm(m.name), ...norm(m.id.replaceAll('-', ' '))])
    return words.every((w) => hay.has(w))
  })
}

const EXPORT = 'export'
const isExport = (c: string | undefined): boolean => c === EXPORT || c === 'none'

function methodOf(id: string) {
  try {
    return connectionMethod(id as ConnectionId)
  } catch {
    return undefined
  }
}

/** Where a person finds each field, from the model's guide. The wording is from vendor documentation and not checked on a printer. */
function helpFor(model: PrinterModel, f: ConnectionField): string {
  if (f.key === 'host') return model.find.ip
  if (f.key === 'serial') return model.find.serial ?? ''
  if (f.secret) return model.find.credential ?? ''
  return ''
}

const fieldSummary = (model: PrinterModel, f: ConnectionField) => ({ field: f.key, label: f.label, required: f.required, secret: f.secret, help: oneLine(helpFor(model, f), 300) })

// ---------------------------------------------------------------------------
// The skill

const STAGES = ['look', 'brand', 'model', 'nozzle', 'connection', 'details', 'test', 'confirm', 'calibrate', 'done'] as const
type Stage = (typeof STAGES)[number]

const input = z.object({
  look: z.enum(LOOK_IDS).optional().describe('The look and feel the user picked, when they did'),
  skipLook: z.boolean().optional().describe('True when the user declined the look and feel question'),
  brand: z.string().optional().describe('Printer brand as the user said it, such as "Bambu Lab" or "Prusa"'),
  model: z.string().optional().describe('Printer model as the user said it, such as "P1S" or "MK4S"'),
  nozzleMm: z.number().min(0.1).max(2).optional().describe('Nozzle diameter in mm'),
  connection: z
    .union([z.string(), z.object({ family: z.string().min(1), address: z.string().optional(), serial: z.string().optional(), username: z.string().optional() })])
    .optional()
    .describe('Connection id from an earlier printer_setup result, or "export" to set up for slicing only. The { family, address } object printer_test takes works too.'),
  host: z.string().optional().describe('IP address or host name of the printer'),
  serial: z.string().optional().describe('Printer serial number, when the connection needs it'),
  username: z.string().optional().describe('User name, when the connection needs one'),
  tested: z.boolean().optional().describe('True once printer_test succeeded'),
  added: z.boolean().optional().describe('True once printer_add finished'),
  material: z.string().optional().describe('Filament the user will print first, for the calibration suggestion'),
})
type RawInput = z.infer<typeof input>
type Input = Omit<RawInput, 'connection'> & { connection?: string }

/** The connection as its id, with an object's address, serial and user name filling the plain fields. */
function flatInput(raw: RawInput): Input {
  const c = raw.connection
  if (typeof c !== 'object') return raw as Input
  const out: Input = { ...raw, connection: c.family }
  const host = raw.host ?? c.address
  const serial = raw.serial ?? c.serial
  const username = raw.username ?? c.username
  if (host !== undefined) out.host = host
  if (serial !== undefined) out.serial = serial
  if (username !== undefined) out.username = username
  return out
}

interface Ask {
  stage: Stage
  question: string
  options?: { id: string; label: string; note?: string }[]
}

const FIRMWARE: Record<string, string> = { 'bambu-lan': 'bambu', prusalink: 'prusa', moonraker: 'klipper', duet: 'klipper' }

function firstCalibration(ctx: ToolContext, connection: string | undefined, material: string | undefined): { text: string; tests: string[]; sources: string[] } {
  const firmware = FIRMWARE[connection ?? ''] ?? ''
  const plan = ctx.kb.get('workflow', 'plan')
  const notes = obj(plan?.data['firmware_notes'])
  const trigger = arr(plan?.data['triggers']).map(obj).find((t) => /new spool/i.test(String(t['when'] ?? '')))
  const tests = strs(trigger?.['run'])
  const note = firmware && typeof notes[firmware] === 'string' ? oneLine(notes[firmware] as string, 400) : ''
  const list = tests.length ? tests.map((t) => t.replaceAll('_', ' ')).join(', ') : 'temperature, pressure advance and flow ratio'
  const mat = material ? ` for ${material}` : ''
  return {
    text: `First calibration${mat}: ${list}. ${note}`.trim(),
    tests,
    sources: [...strs(trigger?.['src']), ...strs(notes[`${firmware}_src`]), ...strs(plan?.data['src'])],
  }
}

const SECRET_RULE = 'The app shows secure fields for access codes and keys. Never ask the user to type or paste one in chat, and never pass one in a tool call.'

export function createSetupTools() {
  const skill = defineSkill({
    name: 'printer_setup',
    version: '0.2.0',
    permission: 'read',
    description:
      'Guides a new user through printer setup, one question at a time: optional look and feel, brand, model, nozzle, connection method, test connection, add the printer, first calibration suggestion. Call it with everything the user has said so far and it returns the current stage, the one question to ask with its options, and what it resolved from the printer catalog, including where the user finds each value on the printer. It changes nothing. Changes go through setup.look, printer_test and printer_add (profileId is resolved.model.id), each of which asks the user first. The where-to-find wording comes from vendor documentation and has not been checked on a printer; say so if the user cannot find a screen. ' +
      SECRET_RULE,
    input,
    args: (raw) => {
      const i = flatInput(raw)
      return [i.brand && `--brand "${i.brand}"`, i.model && `--model "${i.model}"`, i.nozzleMm && `--nozzle ${i.nozzleMm}`, i.connection && `--connection ${i.connection}`].filter(Boolean).join(' ') || '--start'
    },
    async run(raw, ctx) {
      const i = flatInput(raw)
      const setup = ctx.host.setup
      const existing = await ctx.host.printers.list().catch(() => [])
      const currentLook = (await setup?.look?.current().catch(() => null)) ?? null
      const notes: string[] = []
      const resolved: Record<string, unknown> = {}
      let ask: Ask
      let stage: Stage

      const lookAsked = i.look !== undefined || i.skipLook === true || currentLook !== null || !setup?.look
      const brandMatches = i.brand ? findBrand(i.brand) : []
      const brand = brandMatches.length === 1 ? brandMatches[0] : undefined
      const modelMatches = brand && i.model ? findModel(brand.id, i.model) : []
      const model = modelMatches.length === 1 ? modelMatches[0] : undefined
      const nozzleOk = model && i.nozzleMm !== undefined ? model.nozzles.includes(i.nozzleMm) : false
      const connId = model ? (isExport(i.connection) ? EXPORT : model.connections.find((c) => c === i.connection)) : undefined
      const method = connId && connId !== EXPORT ? methodOf(connId) : undefined
      const plain = method ? method.fields.filter((f) => !f.secret && f.key !== 'port' && f.key !== 'pairing') : []
      const have = (k: string): boolean => (k === 'host' ? Boolean(i.host) : k === 'serial' ? Boolean(i.serial) : k === 'username' ? Boolean(i.username) : true)
      const missing = plain.filter((f) => f.required && !have(f.key))

      if (!lookAsked) {
        stage = 'look'
        ask = { stage, question: 'Which look and feel do you want? You can change it later in Settings.', options: LOOK_IDS.map((id) => ({ id, label: LOOK_OPTIONS[id].label, note: LOOK_OPTIONS[id].summary })) }
      } else if (!i.brand || brandMatches.length !== 1) {
        stage = 'brand'
        const found = await setup?.discover?.().catch(() => [])
        if (found?.length) resolved['discovered'] = found.slice(0, 8).map((d) => ({ id: d.id, name: oneLine(d.name, 60), family: d.family, address: d.address ?? null }))
        const unknown = i.brand && brandMatches.length === 0 ? `"${oneLine(i.brand, 40)}" is not in the printer catalog. ` : ''
        if (unknown) notes.push(unknown.trim())
        ask = {
          stage,
          question: `${unknown}${brandMatches.length > 1 ? 'Which of these brands is it?' : 'Which brand is your printer? A printer that is not listed cannot be added yet.'}`,
          options: (brandMatches.length > 1 ? brandMatches : brandsWithModels()).map((b) => ({ id: b.id, label: b.name })),
        }
      } else if (!brand || !model) {
        stage = 'model'
        const unknown = i.model && modelMatches.length === 0 ? `"${oneLine(i.model, 40)}" is not in the ${brand?.name ?? ''} catalog. ` : ''
        if (unknown) notes.push(unknown.trim())
        ask = {
          stage,
          question: `${unknown}${modelMatches.length > 1 ? 'Which of these models is it?' : `Which ${brand?.name ?? ''} model is it?`}`,
          options: (modelMatches.length > 1 ? modelMatches : modelsForBrand(brand?.id ?? '')).map((m) => ({ id: m.id, label: m.name })),
        }
      } else if (!nozzleOk) {
        stage = 'nozzle'
        const unknown = i.nozzleMm !== undefined ? `${brand.name} ${model.name} has no ${i.nozzleMm} mm nozzle in the catalog. ` : ''
        if (unknown) notes.push(unknown.trim())
        ask = { stage, question: `${unknown}Which nozzle is fitted? The stock nozzle is ${model.defaultNozzle} mm.`, options: model.nozzles.map((n) => ({ id: String(n), label: `${n} mm` })) }
      } else if (!connId) {
        stage = 'connection'
        ask = {
          stage,
          question: 'How should SlicerX reach the printer?',
          options: model.connections.map((c) => {
            const m = methodOf(c)
            return c === EXPORT ? { id: c, label: 'Slicing only, save G-code' } : { id: c, label: m?.name ?? c, ...(m ? { note: m.summary } : {}) }
          }),
        }
      } else if (method && missing.length > 0) {
        stage = 'details'
        ask = { stage, question: `I need the ${missing.map((m) => m.label.toLowerCase()).join(' and ')}.`, options: missing.map((m) => ({ id: m.key, label: m.label, note: helpFor(model, m) })) }
      } else if (method && !i.tested) {
        stage = 'test'
        ask = { stage, question: 'May I test the connection? Nothing on the printer changes.' }
      } else if (!i.added && !existing.some((p) => i.host && p.host === i.host)) {
        stage = 'confirm'
        ask = { stage, question: `Add ${brand.name} ${model.name} with a ${i.nozzleMm} mm nozzle?` }
      } else {
        stage = 'calibrate'
        const cal = firstCalibration(ctx, connId, i.material)
        resolved['calibration'] = { tests: cal.tests, advice: cal.text, sources: cal.sources }
        ask = { stage, question: `${cal.text} Want me to plan those tests? Printing them asks first.` }
      }

      if (brand) resolved['brand'] = { id: brand.id, label: brand.name }
      if (model) {
        resolved['model'] = { id: model.id, label: model.name, nozzlesMm: model.nozzles, defaultNozzleMm: model.defaultNozzle, filamentSystem: model.filamentSystem ?? 'none', ...(model.note ? { note: oneLine(model.note, 200) } : {}) }
        resolved['connections'] = model.connections.map((c) => ({ id: c, label: c === EXPORT ? 'Slicing only, save G-code' : (methodOf(c)?.name ?? c) }))
      }
      if (method && model) {
        resolved['connection'] = { id: method.id, guide: method.guide, fields: method.fields.map((f) => fieldSummary(model, f)), pairsOnPrinter: method.pairsOnPrinter ?? false, helpCheckedOnPrinter: model.find.checkedOnPrinter }
      }
      return {
        summary: `Setup stage: ${stage}${brand ? `, ${brand.name}` : ''}${model ? ` ${model.name}` : ''}`,
        output: {
          stage,
          step: STAGES.indexOf(stage) + 1,
          of: STAGES.length - 1,
          ask,
          resolved,
          existingPrinters: existing.map((p) => ({ id: p.id, name: p.name, vendor: p.vendor, model: p.model })),
          currentLook,
          notes,
          rules: [SECRET_RULE, 'Ask one question at a time and wait for the answer.', 'Every change asks the user first; do not describe a change as done before it is approved and finished.'],
        },
        display: [{ kind: 'table', head: ['stage', 'next question'], rows: [[stage, oneLine(ask.question, 200)] as Cell[]] }],
        citations: stage === 'calibrate' ? ctx.kb.cite(strs(obj(resolved['calibration'])['sources'])) : [],
      }
    },
  })

  const discover = defineSkill({
    name: 'printer_discover',
    version: '0.1.0',
    permission: 'read',
    description: 'Lists printers found on the local network or over USB. Passive: no credentials are sent and nothing on a printer changes. Each result has a connection family and an address.',
    input: z.object({ timeoutMs: z.number().int().min(500).max(30000).optional().describe('How long to listen, in ms (default 5000)') }),
    args: () => '--scan',
    async run(i, ctx) {
      const d = ctx.host.setup?.discover
      if (!d) return { ok: false, summary: 'This host cannot scan for printers' }
      const found = await d({ timeoutMs: i.timeoutMs ?? 5000, signal: ctx.signal })
      return {
        summary: `${found.length} printer${found.length === 1 ? '' : 's'} found`,
        output: found.slice(0, 20).map((f) => ({ id: f.id, name: oneLine(f.name, 60), family: f.family, address: f.address ?? null })),
        display: [{ kind: 'table', head: ['name', 'connection', 'address'], rows: found.slice(0, 20).map((f): Cell[] => [oneLine(f.name, 60), f.family, f.address ?? '']) }],
        untrusted: true,
      }
    },
  })

  const search = defineSkill({
    name: 'printer_profile_search',
    version: '0.1.0',
    permission: 'read',
    description: 'Searches the printer profile library by vendor or model text and returns profile ids with the nozzle sizes each profile has. printer_setup already resolves catalog models to a profile id; use this for a printer it does not list.',
    input: z.object({ query: z.string().min(1).max(80).describe('Vendor or model text, such as "Bambu Lab P1S"') }),
    args: (i) => `"${i.query}"`,
    async run(i, ctx) {
      const s = ctx.host.setup?.searchProfiles
      if (!s) return { ok: false, summary: 'This host has no printer profile library' }
      const hits = (await s(i.query)).slice(0, 12)
      return {
        summary: `${hits.length} profile${hits.length === 1 ? '' : 's'} for "${oneLine(i.query, 40)}"`,
        output: hits.map((h) => ({ id: h.id, vendor: h.vendor, model: h.model, nozzlesMm: h.nozzles })),
        display: [{ kind: 'table', head: ['profile', 'vendor', 'model', 'nozzles'], rows: hits.map((h): Cell[] => [h.id, h.vendor, h.model, h.nozzles.map((n) => `${n} mm`).join(', ')]) }],
        untrusted: true,
      }
    },
  })

  const look = defineSkill({
    name: 'setup.look',
    version: '0.1.0',
    permission: 'profile',
    description: 'Sets the look and feel: camera and mouse controls, layout and theme. Ask the user which one first (printer_setup lists the options). The app asks to confirm.',
    input: z.object({ look: z.enum(LOOK_IDS).describe('Look and feel id the user chose') }),
    args: (i) => i.look,
    async approval(i, ctx) {
      if (!ctx.host.setup?.look) throw new Error('This host has no look and feel setting')
      const p = LOOK_OPTIONS[i.look as LookId]
      return {
        title: `Switch to ${p.label}?`,
        lines: [p.summary, 'Changes controls, layout and theme. You can change it later in Settings.'],
        actions: [{ action: 'profile.write', target: 'app:look-and-feel', params: { profileId: 'app:look-and-feel', changes: { look: i.look } } }],
      }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      const l = ctx.host.setup?.look
      if (!l) return { ok: false, summary: 'This host has no look and feel setting' }
      await l.apply(i.look as LookId, ctx.token)
      return { summary: `Look and feel: ${LOOK_OPTIONS[i.look as LookId].label}` }
    },
  })

  const connection = z.object({
    family: z.string().min(1).describe('Connection id from printer_setup, such as "bambu-lan"'),
    address: z.string().min(1).max(253).describe('IP address or host name'),
    serial: z.string().max(64).optional().describe('Serial number, when the connection needs one'),
    username: z.string().max(64).optional().describe('User name, when the connection needs one'),
  })

  const test = defineSkill({
    name: 'printer_test',
    version: '0.2.0',
    permission: 'printer_config',
    description:
      'Tests that SlicerX can reach the printer: reaches it, signs in and reads its state. Registers nothing and changes nothing on the printer. The app asks first, and shows a secure field for the access code or key when the connection needs one. On failure the cause is unreachable, auth, timeout, protocol, not_supported or bad_request. ' +
      SECRET_RULE,
    input: z.object({ connection: connection.describe('How to reach the printer') }),
    mustAsk: async () => ['Contacting a printer always asks first'],
    args: (i) => `${i.connection.family} --address ${i.connection.address}`,
    async approval(i, ctx) {
      if (!ctx.host.setup?.testConnection) throw new Error('Testing a printer connection is done in the SlicerX app while adding the printer. This connection cannot test one.')
      const id = `probe:${i.connection.address}`
      return {
        title: `Test the connection to ${i.connection.address}?`,
        lines: [`Connects over ${i.connection.family}`, 'Nothing on the printer changes and nothing is saved', 'The app asks you for any access code in a secure field'],
        actions: [{ action: 'printer.config', target: id, params: { printerId: id, changes: { probe: connOf(i.connection) } } }],
      }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      const t = ctx.host.setup?.testConnection
      if (!t) return { ok: false, summary: 'Testing a printer connection is done in the SlicerX app while adding the printer. This connection cannot test one.' }
      const r = await t(connOf(i.connection), ctx.token)
      const hint = !r.ok ? hintFor(r.cause, i.connection.family) : undefined
      const steps = r.steps.map((s) => `${s.id.replaceAll('_', ' ')}: ${s.ok === null ? 'not run' : s.ok ? 'ok' : 'failed'}`)
      return {
        ok: r.ok,
        summary: r.ok ? `Connected${r.state ? `, ${oneLine(r.state, 40)}` : ''}` : `Connection failed: ${r.cause ?? 'unknown'}`,
        output: { ok: r.ok, state: r.state ?? null, cause: r.cause ?? null, message: r.message ? oneLine(r.message, 300) : null, steps: r.steps, ...(hint ? { hint } : {}) },
        display: [{ kind: 'kv', rows: [['result', { text: r.ok ? 'connected' : (r.cause ?? 'failed'), tone: r.ok ? 'ok' : 'bad' }], ['steps', steps.join(', ')]] }],
        untrusted: true,
      }
    },
  })

  const add = defineSkill({
    name: 'printer_add',
    version: '0.2.0',
    permission: 'printer_config',
    description:
      'Adds the printer to SlicerX with its profile, nozzle and connection. The app asks first and shows vendor, model, nozzle and address on the card, with the access code masked; the code goes to the system keychain from the app secure field, not from chat. Leave connection out to add a printer for slicing only. profileId is resolved.model.id from printer_setup. ' +
      SECRET_RULE,
    input: z.object({
      profileId: z.string().min(1).describe('Model id from printer_setup (resolved.model.id)'),
      nozzleMm: z.number().min(0.1).max(2).describe('Nozzle diameter in mm, one of the model nozzles'),
      connection: connection.optional().describe('How to reach the printer; omit for slicing only'),
      name: z.string().min(1).max(60).optional().describe('Label the user wants, such as "Bay 1"'),
    }),
    mustAsk: async () => ['Adding a printer always asks first'],
    args: (i) => `${i.profileId} --nozzle ${i.nozzleMm}`,
    async approval(i, ctx) {
      if (!ctx.host.setup?.addPrinter) throw new Error('Adding a printer is done in the SlicerX app (Printers, Add printer). This connection can find printers and suggest settings, but not add one.')
      const id = `new:${i.profileId}`
      const m = modelLabel(i.profileId)
      return {
        title: `Add ${oneLine(i.name ?? m, 40)}?`,
        lines: [
          `${m}, ${i.nozzleMm} mm nozzle`,
          i.connection ? `Connects over ${i.connection.family} at ${i.connection.address}` : 'For slicing only, no connection',
          ...(i.connection ? ['The access code or key is stored in your system keychain, entered in a secure field'] : []),
        ],
        actions: [{ action: 'printer.config', target: id, params: { printerId: id, changes: { add: addInput(i) } } }],
      }
    },
    async run(i, ctx) {
      if (!ctx.token) return { ok: false, summary: 'Not approved' }
      const h = ctx.host.setup?.addPrinter
      if (!h) return { ok: false, summary: 'Adding a printer is done in the SlicerX app (Printers, Add printer). This connection can find printers and suggest settings, but not add one.' }
      const r = await h(addInput(i), ctx.token)
      return { summary: `Added ${oneLine(i.name ?? modelLabel(i.profileId), 40)}`, output: { printerId: r.printerId, next: 'Call printer_setup with the same answers and added true to get the first calibration suggestion, then offer it to the user.' } }
    },
  })

  return [skill, discover, search, look, test, add]
}

function modelLabel(id: string): string {
  const m = modelById(id)
  const brand = m ? BRANDS.find((b) => b.id === m.brand)?.name : undefined
  return m ? `${brand ?? ''} ${m.name}`.trim() : id
}

function connOf(c: { family: string; address: string; serial?: string | undefined; username?: string | undefined }): SetupConnection {
  return { family: c.family, address: c.address, ...(c.serial ? { serial: c.serial } : {}), ...(c.username ? { username: c.username } : {}) }
}

function addInput(i: { profileId: string; nozzleMm: number; connection?: { family: string; address: string; serial?: string | undefined; username?: string | undefined } | undefined; name?: string | undefined }): SetupAddInput {
  return { profileId: i.profileId, nozzleMm: i.nozzleMm, ...(i.connection ? { connection: connOf(i.connection) } : {}), ...(i.name ? { name: i.name } : {}) }
}

function hintFor(cause: string | undefined, family: string): string {
  if (cause === 'auth') return 'The printer refused the access code or key. Check it on the printer and try again; the app asks for it again.'
  if (cause === 'unreachable' || cause === 'timeout') return family === 'bambu-lan' ? 'The printer did not answer. Check that it is on and on the same network. If it still does not answer, turn on LAN Only Mode on the printer. Developer Mode is not needed to connect: it is optional, for printing directly.' : 'The printer did not answer. Check that it is on and on the same network as this computer.'
  if (cause === 'not_supported') return 'This printer or firmware does not support this connection. Try another connection method or set it up for slicing only.'
  if (cause === 'bad_request') return 'The address is not a local network address. Use the IP address shown on the printer.'
  return 'The printer answered in a way SlicerX does not understand. Check the firmware version.'
}
