// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Small in-memory host services for the skill evals and tests: saved profiles
// with versions, a print history, model search and sharing. Every fake with a
// side effect verifies the approval token for its exact action, target and
// parameters, inside trackSideEffect, so the audit counts the call.
import type { ApprovalToken, ApprovalVerifier, LookId, SettingValue, SideEffectAction } from '@slicerx/contracts'
import { hashParams } from '@slicerx/contracts'
import type { HistoryHost, JobRecord, ModelHit, ModelSearchHost, ProfilesHost, ProfileSummary, SetupAddInput, SetupConnection, SetupHost, SetupProfileHit, ShareHost } from '../src/hosts'
import { trackSideEffect, type Audit, type EvalHosts } from './harness'

export interface FakeEnv {
  broker: ApprovalVerifier
  audit: Audit
}

async function requireApproval(env: FakeEnv, token: ApprovalToken | undefined, action: SideEffectAction, target: string, params: unknown): Promise<void> {
  if (!token) throw new Error(`${action} needs an approval token`)
  const res = await env.broker.verify(token, action, target, await hashParams(params))
  if (!res.ok) throw new Error(`${action} refused: ${res.reason}`)
}

async function sha256Text(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Profiles

export const PETG_V1: Record<string, SettingValue> = {
  nozzle_temperature: 230,
  nozzle_temperature_initial_layer: 235,
  hot_plate_temp: 75,
  fan_max_speed: 50,
  filament_flow_ratio: 0.98,
  retraction_length: 0.8,
  filament_max_volumetric_speed: 10,
}

export const PETG_V2: Record<string, SettingValue> = {
  nozzle_temperature: 235,
  nozzle_temperature_initial_layer: 240,
  hot_plate_temp: 75,
  fan_max_speed: 40,
  filament_flow_ratio: 0.97,
  retraction_length: 0.6,
  slow_down_layer_time: 8,
}

interface StoredProfile {
  summary: ProfileSummary
  versions: Map<number, Record<string, SettingValue>>
}

export interface FakeProfiles extends ProfilesHost {
  /** Current values by profile id, for assertions. */
  current(id: string): Record<string, SettingValue> | undefined
  versionOf(id: string): number | undefined
}

export function createFakeProfiles(env: FakeEnv): FakeProfiles {
  const store = new Map<string, StoredProfile>()
  store.set('petg-teal', {
    summary: { id: 'petg-teal', name: 'PETG Teal', section: 'filament', version: 2, updatedAt: '2026-09-12T10:00:00Z', linkedSpool: 4, linkedPrinter: 'bay-1' },
    versions: new Map([[1, { ...PETG_V1 }], [2, { ...PETG_V2 }]]),
  })
  store.set('pla-basic', {
    summary: { id: 'pla-basic', name: 'PLA Basic White', section: 'filament', version: 1, updatedAt: '2026-08-20T09:00:00Z', linkedSpool: 1, linkedPrinter: 'bay-2' },
    versions: new Map([[1, { nozzle_temperature: 215, hot_plate_temp: 60, fan_max_speed: 100 }]]),
  })
  store.set('standard-020', {
    summary: { id: 'standard-020', name: '0.20 mm Standard', section: 'process', version: 1, updatedAt: '2026-07-01T09:00:00Z' },
    versions: new Map([[1, { layer_height: 0.2, wall_loops: 2, sparse_infill_density: 15 }]]),
  })
  const need = (id: string): StoredProfile => {
    const p = store.get(id)
    if (!p) throw new Error(`No profile ${id}`)
    return p
  }
  return {
    async list() {
      return [...store.values()].map((p) => ({ ...p.summary }))
    },
    async read(id, version) {
      const p = need(id)
      const v = version ?? p.summary.version
      const values = p.versions.get(v)
      if (!values) throw new Error(`Profile ${id} has no version ${v}`)
      return { summary: { ...p.summary, version: v }, values: { ...values } }
    },
    async write(profileId, changes, token) {
      await trackSideEffect(env.audit, 'profiles.write', profileId, async () => {
        await requireApproval(env, token, 'profile.write', profileId, { profileId, changes })
        const p = need(profileId)
        const next = p.summary.version + 1
        p.versions.set(next, { ...(p.versions.get(p.summary.version) ?? {}), ...changes })
        p.summary = { ...p.summary, version: next, updatedAt: '2026-09-30T14:00:00Z' }
      })
    },
    current: (id) => {
      const p = store.get(id)
      return p ? { ...(p.versions.get(p.summary.version) ?? {}) } : undefined
    },
    versionOf: (id) => store.get(id)?.summary.version,
  }
}

// ---------------------------------------------------------------------------
// History

const job = (n: number, j: Omit<JobRecord, 'id' | 'startedAt' | 'finishedAt'> & { day: string }): JobRecord => {
  const { day, ...rest } = j
  return { id: `job-${n}`, startedAt: `${day}T08:00:00Z`, ...(rest.outcome === 'running' ? {} : { finishedAt: `${day}T12:00:00Z` }), ...rest }
}

export const HISTORY: JobRecord[] = [
  job(1, { day: '2026-09-02', printerId: 'bay-1', printerModel: 'X1 Carbon', material: 'PETG', model: 'Shelf bracket', outcome: 'success', rating: 5, grams: 41, seconds: 9800, settings: { nozzle_temperature: 235, sparse_infill_density: 25, wall_loops: 3, outer_wall_speed: 120 } }),
  job(2, { day: '2026-09-05', printerId: 'bay-1', printerModel: 'X1 Carbon', material: 'PETG', model: 'Shelf bracket', outcome: 'success', rating: 4, grams: 40, seconds: 9100, settings: { nozzle_temperature: 235, sparse_infill_density: 25, wall_loops: 3, outer_wall_speed: 150 } }),
  job(3, { day: '2026-09-08', printerId: 'bay-1', printerModel: 'X1 Carbon', material: 'PETG', model: 'Wall hook', outcome: 'success', rating: 5, grams: 22, seconds: 5200, settings: { nozzle_temperature: 235, sparse_infill_density: 20, wall_loops: 3, outer_wall_speed: 120 } }),
  job(4, { day: '2026-09-10', printerId: 'bay-1', printerModel: 'X1 Carbon', material: 'PETG', model: 'Shelf bracket', outcome: 'failed', grams: 12, seconds: 2400, settings: { nozzle_temperature: 250, sparse_infill_density: 25, wall_loops: 2, outer_wall_speed: 200 }, notes: 'Corner lifted off the plate at layer 40' }),
  job(5, { day: '2026-09-14', printerId: 'bay-2', printerModel: 'P1S', material: 'PLA', model: 'Lid', outcome: 'success', rating: 4, grams: 18, seconds: 4300, settings: { nozzle_temperature: 215, sparse_infill_density: 15, wall_loops: 2, outer_wall_speed: 200 } }),
  job(6, { day: '2026-09-16', printerId: 'bay-2', printerModel: 'P1S', material: 'PLA', model: 'Lid', outcome: 'success', rating: 4, grams: 18, seconds: 3900, settings: { nozzle_temperature: 215, sparse_infill_density: 15, wall_loops: 2, outer_wall_speed: 250 } }),
  job(7, { day: '2026-09-20', printerId: 'bay-2', printerModel: 'P1S', material: 'ASA', model: 'Desk tray', outcome: 'canceled', seconds: 600, settings: { nozzle_temperature: 260, sparse_infill_density: 10, wall_loops: 2 } }),
  job(8, { day: '2026-09-24', printerId: 'bay-3', printerModel: 'MK4S', material: 'PETG', model: 'Shelf bracket', outcome: 'failed', grams: 30, seconds: 7000, settings: { nozzle_temperature: 245, sparse_infill_density: 25, wall_loops: 2, outer_wall_speed: 200 }, notes: 'Heavy stringing, rough walls' }),
]

export function createFakeHistory(): HistoryHost {
  return {
    async query(q) {
      let out = HISTORY.filter((j) => (!q.material || j.material.toLowerCase() === q.material.toLowerCase()) && (!q.printerId || j.printerId === q.printerId) && (!q.since || j.startedAt >= q.since))
      if (q.text) {
        const t = q.text.toLowerCase()
        out = out.filter((j) => `${j.model} ${j.notes ?? ''}`.toLowerCase().includes(t))
      }
      return out
        .slice()
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, q.limit ?? 20)
        .map((j) => structuredClone(j))
    },
  }
}

// ---------------------------------------------------------------------------
// Model search

export const MODELS: ModelHit[] = [
  { id: 'lib-clip-6', name: 'Cable clip 6 mm', source: 'library', testedPrinters: ['bay-1', 'bay-2'], bboxMm: [30, 14, 12] },
  { id: 'lib-hook', name: 'Wall hook small', source: 'library', testedPrinters: ['bay-2'], bboxMm: [25, 40, 18] },
  { id: 'store-clip-set', name: 'Cable clip set, adjustable', source: 'store', creator: 'Studio North', testedPrinters: ['bay-2', 'bay-4'], url: 'https://example.com/models/clip-set', bboxMm: [40, 20, 15] },
  { id: 'store-tray', name: 'Desk tray 300', source: 'store', creator: 'Maker Ridge', testedPrinters: ['bay-1'], url: 'https://example.com/models/desk-tray', bboxMm: [300, 200, 30] },
  { id: 'store-planter', name: 'Round planter with saucer', source: 'store', creator: 'Studio North', testedPrinters: ['bay-1', 'bay-3'], url: 'https://example.com/models/planter', bboxMm: [120, 120, 140] },
]

export function createFakeModels(): ModelSearchHost {
  return {
    async search(q, opts) {
      const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1)
      const source = opts?.source ?? 'both'
      return MODELS.filter((m) => source === 'both' || m.source === source)
        .map((m) => ({ m, n: words.filter((w) => m.name.toLowerCase().includes(w)).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n || a.m.id.localeCompare(b.m.id))
        .slice(0, opts?.limit ?? 8)
        .map((x) => structuredClone(x.m))
    },
  }
}

// ---------------------------------------------------------------------------
// Sharing

export interface FakeShare extends ShareHost {
  sent: { title: string; body: string; channel: string }[]
  published: { title: string; audience: string; markdown: string; url: string }[]
}

export function createFakeShare(env: FakeEnv): FakeShare {
  const sent: FakeShare['sent'] = []
  const published: FakeShare['published'] = []
  return {
    sent,
    published,
    async notify(msg, token) {
      const channel = msg.channel ?? 'desktop'
      await trackSideEffect(env.audit, 'share.notify', channel, async () => {
        await requireApproval(env, token, 'share.notify', channel, { title: msg.title, body: msg.body, channel })
        sent.push({ title: msg.title, body: msg.body, channel })
      })
    },
    async publish(report, token) {
      const audience = report.audience ?? 'private'
      return trackSideEffect(env.audit, 'share.publish', 'report', async () => {
        await requireApproval(env, token, 'share.publish', 'report', { title: report.title, audience, sha256: await sha256Text(report.markdown) })
        const url = `https://share.example.com/r/${published.length + 1}`
        published.push({ title: report.title, audience, markdown: report.markdown, url })
        return { url }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Printer setup

export interface FakeSetup extends SetupHost {
  tested: SetupConnection[]
  added: SetupAddInput[]
  looks: LookId[]
}

/** The printer at this address answers; every other address is unreachable. */
export const SETUP_REACHABLE_HOST = '192.168.1.40'

const SETUP_PROFILES: SetupProfileHit[] = [
  { id: 'bambu-p1s', vendor: 'Bambu Lab', model: 'P1S', nozzles: [0.2, 0.4, 0.6, 0.8] },
  { id: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzles: [0.2, 0.4, 0.6, 0.8] },
  { id: 'prusa-mk4s', vendor: 'Prusa Research', model: 'MK4S', nozzles: [0.25, 0.4, 0.6] },
]

export function createFakeSetup(env: FakeEnv, opts: { look?: LookId | null } = {}): FakeSetup {
  const tested: SetupConnection[] = []
  const added: SetupAddInput[] = []
  const looks: LookId[] = []
  let look: LookId | null = opts.look ?? null
  return {
    tested,
    added,
    looks,
    async discover() {
      return [{ id: 'mdns-1', name: 'Workshop P1S', family: 'bambu-lan', address: SETUP_REACHABLE_HOST }]
    },
    async searchProfiles(query) {
      const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      return SETUP_PROFILES.filter((p) => words.every((w) => `${p.vendor} ${p.model} ${p.id}`.toLowerCase().includes(w)))
    },
    async testConnection(input, token) {
      const id = `probe:${input.address}`
      return trackSideEffect(env.audit, 'printer.config', id, async () => {
        await requireApproval(env, token, 'printer.config', id, { printerId: id, changes: { probe: input } })
        tested.push(input)
        if (input.address !== SETUP_REACHABLE_HOST) return { ok: false, cause: 'unreachable' as const, message: `No answer from ${input.address}`, steps: [{ id: 'reach' as const, ok: false }, { id: 'sign_in' as const, ok: null }, { id: 'read_state' as const, ok: null }, { id: 'read_temperatures' as const, ok: null }] }
        return { ok: true, state: 'idle', steps: [{ id: 'reach' as const, ok: true }, { id: 'sign_in' as const, ok: true }, { id: 'read_state' as const, ok: true }, { id: 'read_temperatures' as const, ok: true }] }
      })
    },
    async addPrinter(input, token) {
      const id = `new:${input.profileId}`
      return trackSideEffect(env.audit, 'printer.config', id, async () => {
        await requireApproval(env, token, 'printer.config', id, { printerId: id, changes: { add: input } })
        added.push(input)
        return { printerId: `printer-${added.length}` }
      })
    },
    look: {
      async current() {
        return look
      },
      async apply(id, token) {
        await trackSideEffect(env.audit, 'profiles.write', 'app:look-and-feel', async () => {
          await requireApproval(env, token, 'profile.write', 'app:look-and-feel', { profileId: 'app:look-and-feel', changes: { look: id } })
          look = id
          looks.push(id)
        })
      },
    },
  }
}

// ---------------------------------------------------------------------------

export interface FakeHosts {
  hosts: EvalHosts
  profiles: FakeProfiles
  share: FakeShare
  setup: FakeSetup
}

export function createFakeHosts(env: FakeEnv): FakeHosts {
  const profiles = createFakeProfiles(env)
  const share = createFakeShare(env)
  const setup = createFakeSetup(env)
  return { hosts: { profiles, history: createFakeHistory(), models: createFakeModels(), share, setup }, profiles, share, setup }
}

/** For `Scenario.hosts`. */
export const fakeHosts = (env: FakeEnv): EvalHosts => createFakeHosts(env).hosts
