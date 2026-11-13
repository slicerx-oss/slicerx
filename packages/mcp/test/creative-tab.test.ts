// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval runs mimir with the mimir tab's options (tab-options.ts, the code the app's tab uses): the same
// step and tool call limits, the edition's tool groups and the scope rule. A reply that builds nothing is scored as
// asked, declined or none, and a clarifying question gets one default answer before the run is scored.
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { neutralEdition } from '@slicerx/edition-config'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { loadRecording, parseRecording } from '../evals/creative/recordings'
import { CREATIVE_TAB, classifyNoBuild, creativeEnv, DEFAULT_ANSWER, passCounts, runPrompt } from '../evals/creative/run'
import { createPilot, createScriptedClient, editionToolGroups, isRuntimeNote, tabOptions, tabScope, TAB_MIN_STEPS, TAB_MIN_TOOL_CALLS, withBrain } from '@slicerx/pilot'
import { CAD_TOOLS } from '@slicerx/pilot/evals'
import type { PilotTool } from '@slicerx/pilot'
import { mimirTabTools } from '../src/toolset'

const P = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
const stub = () => createScriptedClient([{ text: 'ok' }], { chunk: false })

describe('the tab options the app and the creative eval share', () => {
  it('raise the step and tool call limits to the tab floor and keep higher ones', () => {
    const low = tabOptions({ slices: true, config: { provider: 'p', model: 'm', maxSteps: 24, maxToolCalls: 40 }, kb: creativeEnv(P, stub()).kb, tools: [], commands: [] })
    expect(low.config).toMatchObject({ maxSteps: TAB_MIN_STEPS, maxToolCalls: TAB_MIN_TOOL_CALLS })
    expect([TAB_MIN_STEPS, TAB_MIN_TOOL_CALLS]).toEqual([40, 60])
    const high = tabOptions({ slices: true, config: { provider: 'p', model: 'm', maxSteps: 50, maxToolCalls: 90 }, kb: creativeEnv(P, stub()).kb, tools: [], commands: [] })
    expect(high.config).toMatchObject({ maxSteps: 50, maxToolCalls: 90 })
  })

  it('take the cad scope only where the host does not slice', () => {
    expect(tabScope(true)).toBeUndefined()
    expect(tabScope(false)).toBe('cad')
  })

  it('give the creative eval the desktop tab: limits, scope, surface, policy and the default edition groups', () => {
    expect(CREATIVE_TAB.slices).toBe(true)
    const env = creativeEnv(P, stub())
    expect(env.options.config).toMatchObject({ maxSteps: TAB_MIN_STEPS, maxToolCalls: TAB_MIN_TOOL_CALLS })
    expect(env.options.scope).toBeUndefined()
    expect(env.options.surface).toBe('tab')
    expect(env.options.policy).toBe(DEFAULT_POLICY)
    expect(env.options.toolGroups).toEqual(editionToolGroups(neutralEdition()))
    expect(env.options.config.webSearch).toBe(withBrain({ ...env.options.config }, neutralEdition()).webSearch)
  })

  it('offer the creative eval the tools a runtime made from the tab options offers', () => {
    const env = creativeEnv(P, stub())
    const direct = createPilot({ ...env.options, ...tabOptions({ slices: true, config: env.options.config, kb: env.kb, tools: env.options.tools ?? [], commands: [], toolGroups: editionToolGroups(neutralEdition()), ...(env.options.memory ? { memory: env.options.memory } : {}) }) })
    expect(env.pilot.tools().map((t) => t.name).sort()).toEqual(direct.tools().map((t) => t.name).sort())
  })

  it('run the browser build in the cad scope when it does not slice', () => {
    const env = creativeEnv(P, stub(), {}, { slices: false })
    expect(env.options.scope).toBe('cad')
    const tab = new Set((env.options.tools ?? []).map((t) => t.name))
    for (const t of env.pilot.tools()) expect(CAD_TOOLS.has(t.name) || tab.has(t.name) || t.name.startsWith('app.') || t.name.startsWith('memory.'), t.name).toBe(true)
  })

  it('offer the tab\'s own tools and its design tools, with no part generator', () => {
    const names = creativeEnv(P, stub()).pilot.tools().map((t) => t.name)
    for (const n of ['pilot.ask', 'lookup.show', 'pilot.sheet', 'pilot.sheet_bind', 'design.plan', 'design.new', 'design.check', 'geom.extrude']) expect(names).toContain(n)
    for (const n of ['text_to_part', 'make_model', 'design.put_plan']) expect(names).not.toContain(n)
  })

  it('leave out the file tools, since a design in the tab stays on the plate and saving it is the person\'s', () => {
    // with no files in the tab, design.save and design.open only refuse, and a reply called save to finish a part
    const names = creativeEnv(P, stub()).pilot.tools().map((t) => t.name)
    for (const n of ['design.save', 'design.open']) expect(names).not.toContain(n)
    for (const n of ['design.new', 'design.undo', 'design.steps', 'design.check']) expect(names).toContain(n)
    const tool = (name: string) => ({ name }) as PilotTool<never>
    const plan = tool('design.plan')
    const own = mimirTabTools(plan, [tool('design.save'), tool('design.open'), tool('design.new')]).map((t) => t.name)
    expect(own).not.toContain('design.save')
    expect(own).not.toContain('design.open')
    expect(own).toContain('design.new')
  })
})

// Replies from an earlier live run, kept here as text so a new capture of the recordings never changes these cases.
const REPLIES = {
  taco: "I can't model a folded taco shell as it would look. It curves freely in two directions, and the tools only build shapes made from outlines extruded or turned around one axis.\n\nThe closest versions I can build:\n\n1. **Half-tube shell:** a U-shaped taco shell extruded along its length.\n2. **Nothing for now.**\n\nWhich version do you want? Once you pick one, I'll ask for the sizes I still need.",
  flexiFish: 'A fish with a sculpted, freely curving body is outside what I can model, but I can build a close version. Which one would you like?\n\n1. **Turned segmented fish:** a row of rounded segment blocks.\n2. **Nothing for now.**',
  shipHull: "A hull's curved planking bends in two directions at once, and the tools can't model that freely curving surface. I can build the closest version instead. Which would you like?",
  gearPair: 'Nothing is built or sliced yet. The 20-tooth gear would be 30 mm pitch diameter and the 40-tooth gear 60 mm, both on one base plate with a pin each, and both fit the P1S bed. Should the gears print already seated on their pins with running clearance, or as loose pieces you assemble?',
  phoneStand: "Before I model it, I need your phone's size. The slot width depends on the phone's thickness with its case, and the stand's width depends on its width. Which phone is it, and do you use a case? If you don't know the exact numbers, a case-on or case-off choice is enough, and I'll use typical dimensions for that model.",
  // a later live run: it offered a simpler version, was told to build it, had its plan approved, and ended there
  flexiFishStopped: [
    "The tools can't model a smoothly curved, organic fish body. They can build a segmented fish from extruded side-profile pieces with flat faces, pin hinges and a fin on its own pivot. That version would be 120 mm long and print in place, with the segments moving on pins. Which would you like?",
    "I'll go with the segmented fish you described, using common sizes. Here is the plan for the card.",
    "The plan is approved as shown, so I'll build the body segments next. Each segment is a flat-sided block with a hinge socket, so the fish can flex on its pins.",
  ],
  // cut off mid list: no question and no refusal
  pipChain: "A fully flat chain can't link on the bed. Two rings can only interlock if one passes through the other's hole, and a link lying flat has no height to pass through.\n\n1. **Classic chain, printed with supports.** Odd links lie flat and",
}

describe('a reply that builds nothing', () => {
  it('is declined when it says the part cannot be modeled or built', () => {
    expect(classifyNoBuild(REPLIES.taco)).toBe('declined')
    expect(classifyNoBuild(REPLIES.flexiFish)).toBe('declined')
    expect(classifyNoBuild(REPLIES.shipHull)).toBe('declined')
    expect(classifyNoBuild("I can't build a knitted surface. Want ribs instead?")).toBe('declined')
  })

  it('is asked when it puts a question to the person and does not decline', () => {
    expect(classifyNoBuild(REPLIES.gearPair)).toBe('asked')
    expect(classifyNoBuild(REPLIES.phoneStand)).toBe('asked')
    expect(classifyNoBuild('How tall should it be?')).toBe('asked')
  })

  it('is none when it neither asks nor declines', () => {
    expect(classifyNoBuild('')).toBe('none')
    expect(classifyNoBuild('Here is a dragon.')).toBe('none')
    expect(classifyNoBuild(REPLIES.pipChain)).toBe('none')
  })

  it('is stopped when it ends without building after its plan was approved or it was answered', () => {
    const [offer, plan, next] = REPLIES.flexiFishStopped as [string, string, string]
    expect(classifyNoBuild(offer + plan + next, next)).toBe('stopped')
    expect(classifyNoBuild('', '')).toBe('stopped')
    // what it says afterwards still decides: a refusal or another question after the answer
    expect(classifyNoBuild(offer + next + "I can't model the fins after all.", "I can't model the fins after all.")).toBe('declined')
    expect(classifyNoBuild(offer + 'And how long?', 'And how long?')).toBe('asked')
    // with no approval or answer the whole reply counts, and a refusal stays one
    expect(classifyNoBuild(offer + plan + next)).toBe('declined')
  })

  it('scores a plan approved and then no build as stopped, not declined', async () => {
    const [offer, plan, next] = REPLIES.flexiFishStopped as [string, string, string]
    const FISH = CREATIVE_PROMPTS.find((x) => x.id === 'flexi-fish')!
    const choices = [{ id: 'segmented_fish', label: 'Segmented fish with flopping fin' }, { id: 'chain_no_fin', label: 'Jointed chain, no fin' }, { id: 'nothing', label: 'Nothing for now' }]
    const ask = { name: 'pilot.ask', args: { title: 'Fish version', question: 'Which version should I build?', choices } }
    const card = { name: 'design.plan', args: { part: 'Segmented fish', units: 'mm', features: [{ name: 'Body segments', kind: 'extrude', sizes: { segment_length: 16, segment_height: 24, segment_width: 12, count: 6 } }, { name: 'Hinge pins and sockets', kind: 'hole', sizes: { pin_diameter: 2, socket_diameter: 2.4 } }], assumptions: ['The segments print in place on their pins'], questions: [] } }
    // mimir is told once that the approved plan has no body yet, and the model stops a second time without building
    const client = createScriptedClient([{ text: offer, calls: [ask] }, { calls: [ask] }, { text: plan, calls: [card] }, { text: next }, { text: next }], { chunk: false })
    const run = await runPrompt(FISH, { geom: undefined, client })
    expect(run.calls).toEqual(['pilot.ask', 'pilot.ask', 'design.plan'])
    expect(run.answered).toBe(true)
    expect(JSON.stringify(client.requests[3]?.messages)).toContain('\\"accepted\\":true')
    expect(run.noBuild).toBe('stopped')
    expect(run.parsed.pass).toBe(false)
    // it was not asked again, so the eval did not answer a second time: the fifth request is mimir's own note
    expect(client.requests).toHaveLength(5)
    const note = client.requests[4]?.messages.at(-1)
    expect(note?.role === 'user' && isRuntimeNote(note.content)).toBe(true)
  })

  it('is scored with its reason instead of a plain parse failure', async () => {
    const run = await runPrompt(P, { geom: undefined, steps: [{ text: "I can't model that." }] })
    expect(run.noBuild).toBe('declined')
    expect(run.parsed).toEqual({ pass: false, detail: 'no design tool was called: declined' })
  })
})

describe('the default answer to a clarifying question', () => {
  // a build: the sizes confirmed on a sheet (the tab builds nothing before), a new design and its first body
  const build = { calls: [{ name: 'pilot.sheet', args: { title: 'Size', dims: [{ key: 'length', label: 'Length', value: 100, unit: 'mm', source: 'guess' }] } }, { name: 'design.new', args: { name: 'Cable organizer' } }, { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 100, heightMm: 30 }, distance_mm: 20 } }] }

  it('answers a question once and lets the model build', async () => {
    const client = createScriptedClient([{ text: 'How long should the organizer be?' }, build, { text: 'Built it.' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.calls).toContain('design.new')
    expect(run.noBuild).toBeUndefined()
    const answer = client.requests[1]?.messages.at(-1)
    expect(answer?.role).toBe('user')
    expect(String(answer?.content)).toContain(DEFAULT_ANSWER)
    expect(DEFAULT_ANSWER).toBe('Use common sizes and sensible defaults, then build it')
  })

  it('answers only once: a second question is scored as asked', async () => {
    const client = createScriptedClient([{ text: 'How long?' }, { text: 'And how wide?' }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.noBuild).toBe('asked')
    expect(client.requests).toHaveLength(2)
  })

  it('never answers a decline', async () => {
    const client = createScriptedClient([{ text: "I can't model a sculpted dragon. Which version do you want?" }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(false)
    expect(run.noBuild).toBe('declined')
    expect(client.requests).toHaveLength(1)
  })

  it('is off with defaultAnswer false', async () => {
    const client = createScriptedClient([{ text: 'How long should it be?' }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client, defaultAnswer: false })
    expect(run.answered).toBe(false)
    expect(run.noBuild).toBe('asked')
    expect(client.requests).toHaveLength(1)
  })

  it('replays the answer only for a recording captured with it, and marks an older question stale', async () => {
    // a question recorded on the tab tools but before the default answer (no defaultAnswer on the recording)
    const old = await runPrompt(CREATIVE_PROMPTS.find((x) => x.id === 'gear-pair')!, { geom: undefined, steps: [{ text: REPLIES.gearPair }], tabTools: true })
    expect(old.answered).toBe(false)
    expect(old.noBuild).toBe('asked')
    expect(old.stale).toMatch(/default answer/)
    const fresh = await runPrompt(P, { geom: undefined, steps: [{ text: 'How long?' }, build, { text: 'Done.' }], answerRecorded: true, tabTools: true })
    expect(fresh.answered).toBe(true)
    expect(fresh.calls).toContain('design.new')
    expect(fresh.stale).toBeUndefined()
  })

  it('goes to a question card as the person\'s words, once, and the reply is not answered again', async () => {
    const card = { calls: [{ name: 'pilot.ask', args: { title: 'Size', question: 'How long should it be?', choices: [{ id: 'short', label: '80 mm' }, { id: 'long', label: '120 mm' }] } }] }
    const client = createScriptedClient([card, { text: 'Which color?' }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.noBuild).toBe('asked')
    expect(client.requests).toHaveLength(2)
    expect(JSON.stringify(client.requests[1]?.messages.at(-1))).toContain(DEFAULT_ANSWER)
  })

  it('answers a question asked after the plan, since a plan builds nothing yet', async () => {
    const sheet = { calls: [{ name: 'pilot.sheet', args: { title: 'Cube size', dims: [{ key: 'side', label: 'Side', value: 20, unit: 'mm', source: 'guess' }] } }] }
    const plan = { calls: [{ name: 'design.plan', args: { part: 'Infinity cube', units: 'mm', features: [{ name: 'cubes', kind: 'extrude', sizes: { side: 20 } }, { name: 'hinges', kind: 'extrude', sizes: { gap: 0.3 } }], assumptions: [], questions: [] } }] }
    const asks = { text: 'Should the hinges print in place, or as loose parts you assemble?' }
    const builds = { calls: [{ name: 'design.new', args: { name: 'Infinity cube' } }, { name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 20, heightMm: 20 }, distance_mm: 20 } }] }
    const client = createScriptedClient([sheet, plan, asks, builds, { text: 'Built the first cube.' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(JSON.stringify(client.requests[3]?.messages.at(-1))).toContain(DEFAULT_ANSWER)
    expect(run.calls).toEqual(['pilot.sheet', 'design.plan', 'design.new', 'geom.extrude'])
    expect(run.noBuild).toBeUndefined()
  })

  it('answers a question asked after a build once, and the model goes on building', async () => {
    const more = { calls: [{ name: 'geom.extrude', args: { design: 'd1', shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, distance_mm: 5, operation: 'join' } }] }
    const client = createScriptedClient([build, { text: 'The base is built. Should I add the cable slots too?' }, more, { text: 'Added the slots.' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.asks).toBe(1)
    expect(JSON.stringify(client.requests[2]?.messages.at(-1))).toContain(DEFAULT_ANSWER)
    expect(run.calls.filter((c) => c === 'geom.extrude')).toHaveLength(2)
    // it passed only after the answer, so it is never counted with a run that passed on its own
    expect(passCounts([{ id: 'organizer', pass: true, answered: run.answered }, { id: 'hook', pass: true, answered: false }])).toEqual({ unaided: ['hook'], afterOneAnswer: ['organizer'] })
  })

  it('answers only one question a run asks: a second one after a build ends the run, counted', async () => {
    const client = createScriptedClient([build, { text: 'Built the base. Add the slots?' }, { text: 'And a lid too?' }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.asks).toBe(2)
    expect(client.requests).toHaveLength(3)
  })

  it('a question after the default answer already given is not answered again', async () => {
    const client = createScriptedClient([{ text: 'How long should it be?' }, build, { text: 'Built it. Want slots?' }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.asks).toBe(2)
    expect(client.requests).toHaveLength(3)
  })

  it('replays a recording from before the answer after a build as captured: it ends at the question, not stale', async () => {
    const steps = [build, { text: 'The base is built. Should I add the cable slots too?' }]
    const old = await runPrompt(P, { geom: undefined, steps, answerRecorded: true, tabTools: true, samePart: true })
    expect(old.answered).toBe(false)
    expect(old.asks).toBe(1)
    expect(old.stale).toBeUndefined()
    expect(old.error).toBeUndefined()
    // a live capture since then is stamped midBuildAnswer, and its replay sends the answer where the live run did
    const fresh = await runPrompt(P, { geom: undefined, steps: [...steps, build, { text: 'Done.' }], answerRecorded: true, midBuildAnswer: true, tabTools: true, samePart: true })
    expect(fresh.answered).toBe(true)
    expect(fresh.error).toBeUndefined()
  })

  it('counts every question card, answered or not', async () => {
    const card = { calls: [{ name: 'pilot.ask', args: { title: 'Size', question: 'How long should it be?', choices: [{ id: 'short', label: '80 mm' }, { id: 'long', label: '120 mm' }] } }] }
    const client = createScriptedClient([card, card, build, { text: 'Built it.' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.asks).toBe(2)
  })

  it('counts reads and a plan as building nothing', async () => {
    const reads = { calls: [{ name: 'design.list', args: {} }] }
    const run = await runPrompt(P, { geom: undefined, steps: [reads, { text: 'How long should it be?' }], defaultAnswer: false, tabTools: true })
    expect(run.calls).toEqual(['design.list'])
    expect(run.noBuild).toBe('asked')
  })

  it('goes ahead with a sheet and a plan at their default sizes, nobody asked', async () => {
    const plan = { calls: [{ name: 'design.plan', args: { part: 'Cable organizer', units: 'mm', features: [{ name: 'base', kind: 'extrude', sizes: { length: 100 } }], assumptions: [], questions: [] } }] }
    const sheet = { calls: [{ name: 'pilot.sheet', args: { title: 'Tray size', dims: [{ key: 'length', label: 'Length', value: 100, unit: 'mm', source: 'guess' }] } }] }
    const client = createScriptedClient([sheet, plan, build, { text: 'Started it.' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.calls).toEqual(['pilot.sheet', 'design.plan', 'pilot.sheet', 'design.new', 'geom.extrude'])
    expect(JSON.stringify(client.requests[1]?.messages)).toContain('Shown; build with these sizes now')
    expect(JSON.stringify(client.requests[2]?.messages)).toContain('\\"accepted\\":true')
    expect(run.answered).toBe(false)
  })
})

describe('the recordings', () => {
  it('replay a recording from before the tab tools as stale', async () => {
    const old = parseRecording(JSON.stringify({ status: 'recorded', model: 'm', provider: 'p', capturedAt: '2026-11-07T00:00:00Z', steps: [{ calls: [{ name: 'text_to_part', args: { prompt: 'a cable organizer' } }] }, { text: 'Done.' }] }))
    if (old.status !== 'recorded') throw new Error('recorded')
    expect(old.tabTools).toBeUndefined()
    const run = await runPrompt(P, { geom: undefined, steps: old.steps, tabTools: old.tabTools === true })
    expect(run.stale).toMatch(/design tools/)
  })

  it('are all captured on the tab tools', () => {
    for (const p of CREATIVE_PROMPTS) {
      const rec = loadRecording(p.id)
      if (rec.status === 'recorded') expect(rec.tabTools, p.id).toBe(true)
    }
  })
})

describe('a run that ends early says why', () => {
  it('reports the provider\'s error when the model fails, not a quiet end', async () => {
    const down = {
      provider: 'anthropic',
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<never> {
        throw new Error('the provider is down')
      },
    }
    const run = await runPrompt(P, { geom: undefined, client: down as never })
    expect(run.error).toMatch(/ended on an error: .*the provider is down/)
    expect(run.parsed.pass).toBe(false)
  })

  it('reports the step cap when the model calls tools until it runs out of steps', async () => {
    let n = 0
    const busy = {
      provider: 'anthropic',
      async *stream(req: { toolChoice?: string }) {
        if (req.toolChoice === 'none') yield { type: 'text', delta: 'Still looking.' }
        else yield { type: 'tool_call', call: { id: `c${++n}`, name: 'design.list', arguments: '{}' } }
        yield { type: 'done', stop: req.toolChoice === 'none' ? 'end' : 'tool_calls' }
      },
    }
    const run = await runPrompt(P, { geom: undefined, client: busy as never })
    expect(run.error).toMatch(/step cap/)
    expect(n).toBeGreaterThan(TAB_MIN_STEPS - 5)
  })

  it('fails a replay that leaves recorded replies unused, and passes one that uses them all', async () => {
    // a question is answered once, so the message and the answer take two replies and the third is never asked for
    const asks = [{ text: 'Which size, 1?' }, { text: 'Which size, 2?' }, { text: 'Which size, 3?' }]
    const left = await runPrompt(P, { geom: undefined, steps: asks, answerRecorded: true, tabTools: true })
    expect(left.error).toBe('the replay left 1 recorded reply unused')
    const used = await runPrompt(P, { geom: undefined, steps: asks.slice(0, 2), answerRecorded: true, tabTools: true })
    expect(used.error).toBeUndefined()
    const many = await runPrompt(P, { geom: undefined, steps: asks.slice(0, 1), answerRecorded: false, tabTools: true })
    expect(many.error).toBeUndefined()
  })

  it('does not count a live run\'s scripted client as a replay', async () => {
    const client = createScriptedClient([{ text: 'Which size?' }, { text: 'And?' }, { text: 'More?' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.error).toBeUndefined()
  })
})
