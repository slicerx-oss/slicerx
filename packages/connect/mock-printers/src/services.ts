// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Spoolman (https://donkie.github.io/Spoolman/) and Home Assistant
// (https://developers.home-assistant.io/docs/api/rest/) fakes.
import type { DemoFleet } from '@slicerx/contracts'
import { MockError } from './machine.ts'
import { listen, type Handler } from './http-util.ts'

export async function startSpoolman(fixture: DemoFleet, log: string[]) {
  const spools = fixture.spools.map((s) => ({ ...s }))
  const shape = (s: (typeof spools)[number]) => ({
    id: s.id, remaining_weight: s.remainingG, initial_weight: s.initialG, archived: false,
    filament: { name: s.name, material: s.material, color_hex: s.color.replace('#', '').toUpperCase(), weight: s.initialG, vendor: { name: s.vendor } },
  })
  const handler: Handler = async (req) => {
    if (req.path === '/api/v1/spool' && req.method === 'GET') return { json: spools.map(shape) }
    const one = /^\/api\/v1\/spool\/(\d+)$/.exec(req.path)
    if (one && req.method === 'GET') {
      const s = spools.find((x) => x.id === Number(one[1]))
      if (!s) throw new MockError(404, 'no spool')
      return { json: shape(s) }
    }
    const use = /^\/api\/v1\/spool\/(\d+)\/use$/.exec(req.path)
    if (use && req.method === 'PUT') {
      const s = spools.find((x) => x.id === Number(use[1]))
      if (!s) throw new MockError(404, 'no spool')
      const g = Number((req.json() as { use_weight?: number }).use_weight)
      s.remainingG = Math.max(0, s.remainingG - g)
      log.push(`spoolman use ${s.id} ${g}`)
      return { json: shape(s) }
    }
    throw new MockError(404, req.path)
  }
  return listen(handler)
}

export const MOCK_HA_TOKEN = 'mock-ha-token'

export async function startHomeAssistant(fixture: DemoFleet, log: string[]) {
  const entities = fixture.printers.map((p) => ({ entity_id: `switch.${p.id.replace('-', '_')}_power`, state: p.state === 'offline' ? 'off' : 'on', attributes: { friendly_name: `${p.name} power` } }))
  // off the plugin's allow-list: list_entities must never show it
  entities.push({ entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } })
  const handler: Handler = async (req) => {
    if (req.headers.authorization !== `Bearer ${MOCK_HA_TOKEN}`) return { status: 401, json: { message: 'unauthorized' } }
    if (req.path === '/api/states') return { json: entities }
    const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(req.path)
    if (svc && req.method === 'POST') {
      const id = String((req.json() as { entity_id?: string }).entity_id)
      const e = entities.find((x) => x.entity_id === id)
      if (!e) throw new MockError(400, 'unknown entity')
      if (svc[2] === 'turn_off') e.state = 'off'
      if (svc[2] === 'turn_on') e.state = 'on'
      log.push(`ha ${svc[1]}.${svc[2]} ${id}`)
      return { json: [] }
    }
    throw new MockError(404, req.path)
  }
  return listen(handler)
}
