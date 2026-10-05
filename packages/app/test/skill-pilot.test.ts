// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type LookId, type PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type SetupAddInput, type SetupConnection } from '@slicerx/pilot'
import { EMPTY_FORM, pickBrand, pickModel, withAddInput, withConnection } from '../src/first-run/printer-form'
import type { PilotReply, Proposal } from '../src/first-run/pilot-adapter'
import { createHostSetup } from '../src/first-run/setup-host'
import { createSkillPilot, pilotSetupHost, type SetupBridge } from '../src/first-run/skill-pilot'

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

function rig(script: Parameters<typeof createScriptedClient>[0]) {
  const broker = createApprovalBroker()
  const looks: LookId[] = []
  const tested: SetupConnection[] = []
  const added: SetupAddInput[] = []
  const bridge: SetupBridge = {
    currentLook: () => 'slicerx',
    applyLook: (id) => void looks.push(id),
    test: async (c) => {
      tested.push(c)
      return { ok: true, state: 'idle', steps: [{ id: 'reach', ok: true }, { id: 'sign_in', ok: true }, { id: 'read_state', ok: true }, { id: 'read_temperatures', ok: true }] }
    },
    add: async (i) => {
      added.push(i)
      return { printerId: 'local-1' }
    },
  }
  const setup = createHostSetup({ capabilities: { printers: 'sim', secureStorage: false }, printers } as never, { stepMs: 0 })
  const pilot = createPilot({ host: { printers, llm: noLlm, approvals: broker, setup: pilotSetupHost(broker, setup, bridge) }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(script, { chunk: false }) })
  return { onboarding: createSkillPilot(pilot, 's1'), looks, tested, added }
}

/** Asks, and answers the first card when it shows. */
async function askAndAnswer(o: ReturnType<typeof rig>['onboarding'], text: string, apply: boolean): Promise<{ reply: PilotReply; card: Proposal | undefined }> {
  let card: Proposal | undefined
  const reply = await o.ask({ step: 'look', text, form: {} }, undefined, (r) => {
    const c = r.proposals.find((p) => p.kind === 'approval')
    if (c && !card) {
      card = c
      void o.resolve?.(c, apply)
    }
  })
  return { reply, card }
}

describe('mimir printer_setup skill behind the panel', () => {
  it('turns setup.look into a card and applies the look only after Apply', async () => {
    const r = rig([{ calls: [{ name: 'setup.look', args: { look: 'prusaslicer' } }] }, { text: 'Done, PrusaSlicer style is on.' }])
    const { reply, card } = await askAndAnswer(r.onboarding, 'I use PrusaSlicer', true)
    expect(card?.kind).toBe('approval')
    expect(r.looks).toEqual(['prusaslicer'])
    expect(reply.text).toContain('PrusaSlicer style')
  })

  it('Dismiss leaves the look alone', async () => {
    const r = rig([{ calls: [{ name: 'setup.look', args: { look: 'orcaslicer' } }] }, { text: 'Left it as it is.' }])
    await askAndAnswer(r.onboarding, 'switch to orca', false)
    expect(r.looks).toEqual([])
  })

  it('tests and adds through the bridge with verified tokens, never with a credential', async () => {
    const connection = { family: 'bambu-lan', address: '192.0.2.11', serial: '01S00A987654321' }
    const r = rig([{ calls: [{ name: 'printer_test', args: { connection } }] }, { text: 'It answered.' }])
    await askAndAnswer(r.onboarding, 'test it', true)
    expect(r.tested).toEqual([connection])
    expect(JSON.stringify(r.tested)).not.toMatch(/credential/)
  })

  it('refuses a setup call with a token the broker did not grant', async () => {
    const broker = createApprovalBroker()
    const host = pilotSetupHost(broker, createHostSetup({ capabilities: { printers: 'sim', secureStorage: false }, printers } as never), { currentLook: () => null, applyLook: () => undefined, test: async () => ({ ok: true, steps: [] }), add: async () => ({ printerId: 'x' }) })
    await expect(host.look!.apply('bambu-studio', 'forged' as never)).rejects.toThrow(/Not approved/)
  })
})

describe('form values from an approved card', () => {
  it('fills the connection and keeps the model', () => {
    const f = withConnection(pickModel(pickBrand(EMPTY_FORM, 'bambu-lab'), 'bambu-p1s'), { family: 'bambu-lan', address: '192.0.2.12', serial: 'ABCDEFGH12' })
    expect(f.modelId).toBe('bambu-p1s')
    expect(f.fields).toMatchObject({ host: '192.0.2.12', serial: 'ABCDEFGH12' })
  })

  it('builds the whole printer from an add request', () => {
    const f = withAddInput(EMPTY_FORM, { profileId: 'prusa-mk4s', nozzleMm: 0.6, connection: { family: 'prusalink', address: '192.0.2.13' } })
    expect(f.brand).toBe('prusa')
    expect(f.nozzles[0]?.size).toBe(0.6)
    expect(f.connection).toBe('prusalink')
    const e = withAddInput(EMPTY_FORM, { profileId: 'prusa-mk4s', nozzleMm: 0.35 })
    expect(e.connection).toBe('export')
    expect(e.nozzles[0]).toMatchObject({ size: null, other: '0.35' })
  })
})
