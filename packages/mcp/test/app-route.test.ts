// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools on the open app: while the app link answers they run there and say so once; model files and the
// file tools stay here; when the link is off or the app closed they run here; the app's refusals keep their meaning.
// The plate edits go to the app for an object the server's own project does not have.
import { describe, expect, it, vi } from 'vitest'
import { APP_DESIGN_TOOLS, APP_PROJECT_TOOLS, routeToApp, type AppLinkCaller, type RouteOptions } from '../src/app-route'
import { ToolInputError } from '../src/errors'
import { NO_ENGINE_HOST, designToolset } from '../src/toolset'

const fail = (code: string) => Object.assign(new Error(`refused: ${code}`), { code })

function routed(call: AppLinkCaller['call']) {
  const tools = routeToApp(designToolset(NO_ENGINE_HOST), { call }, 'SlicerX')
  const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never)
  return { tools, run }
}

describe('design tools over the app link', () => {
  it('route exactly the hub list, never the file tools', () => {
    const names = designToolset(NO_ENGINE_HOST).map((t) => t.name)
    for (const n of APP_DESIGN_TOOLS) expect(names, n).toContain(n)
    expect(APP_DESIGN_TOOLS.has('design.open')).toBe(false)
    expect(APP_DESIGN_TOOLS.has('design.save')).toBe(false)
    // These take only a model file, which the app does not open.
    expect(APP_DESIGN_TOOLS.has('geom.info')).toBe(false)
    expect(APP_DESIGN_TOOLS.has('geom.measure')).toBe(false)
  })

  it('run in the app while it answers, and say so on the first reply only', async () => {
    const call = vi.fn(async (method: string) => ({ summary: `ran ${method}`, output: { design: 'obj_1', steps: 1 } }))
    const { run } = routed(call as AppLinkCaller['call'])
    const first = await run('design.new', { name: 'Clip' })
    expect(call).toHaveBeenCalledWith('design.new', { name: 'Clip' })
    expect(first.summary).toMatch(/ran design.new \(in SlicerX\) Designs now live in the project open in SlicerX/)
    expect(first.output).toEqual({ design: 'obj_1', steps: 1, in: 'app' })
    const second = await run('geom.extrude', { design: 'obj_1', shape: { type: 'circle', diameterMm: 5 }, distance_mm: 2 })
    expect(second.summary).toBe('ran geom.extrude (in SlicerX)')
  })

  it('keep a model file here, and run here while the link is not this server\'s to use', async () => {
    // off, the app closed, a partner key or a code-only pairing the hub refuses, and an older hub without the link
    for (const [code, message] of [
      ['app_link_off', ''],
      ['app_closed', ''],
      ['forbidden', ''],
      ['unauthorized', ''],
      ['bad_request', 'unknown method app.call'],
    ]) {
      const call = vi.fn(async () => {
        throw Object.assign(new Error(message || code), { code })
      })
      const { run } = routed(call as AppLinkCaller['call'])
      const e = await run('design.new', { name: 'Clip' }).catch((x: unknown) => x)
      // Here means this server's own designs, which need an engine this test has none of.
      expect((e as ToolInputError).code, code).toBe('engine_unavailable')
    }
    const call = vi.fn()
    const { run } = routed(call as AppLinkCaller['call'])
    await run('geom.faces', { model: '/tmp/part.stl' }).catch(() => undefined)
    expect(call).not.toHaveBeenCalled()
  })

  it('pass the app\'s refusals on with their meaning', async () => {
    for (const [code, want] of [
      ['read_only', 'not_supported'],
      ['denied', 'not_supported'],
      ['invalid_input', 'invalid_input'],
      ['not_found', 'not_found'],
      ['busy', 'busy'],
      ['pending', 'busy'],
      ['timeout', 'internal_error'],
    ] as const) {
      const { run } = routed((async () => {
        throw fail(code)
      }) as AppLinkCaller['call'])
      const e = await run('design.undo', { design: 'obj_1' }).catch((x: unknown) => x)
      expect(e, code).toBeInstanceOf(ToolInputError)
      expect((e as ToolInputError).code, code).toBe(want)
    }
  })

  it('bound an edited step\'s number as its tool does', () => {
    const edit = designToolset(NO_ENGINE_HOST).find((t) => t.name === 'design.edit_step')!
    expect(edit.input.safeParse({ design: 'd1', step: 1, value: 10_000 }).success).toBe(true)
    expect(edit.input.safeParse({ design: 'd1', step: 1, value: 10_001 }).success).toBe(false)
    expect(edit.input.safeParse({ design: 'd1', step: 1, value: -10_001 }).success).toBe(false)
  })

  it('bound fillet and chamfer at 1000 mm and hollow and shell walls at 50 mm when a step is edited', async () => {
    const steps = [
      { op: 'edge.fillet', edges: [], radiusMm: 2 },
      { op: 'edge.chamfer', edges: [], distanceMm: 1 },
      { op: 'hollow', wallMm: 2 },
      { op: 'shell', wallMm: 2, faces: [] },
    ]
    const replayed: number[] = []
    const design = {
      id: 'd1',
      name: 'Part',
      history: { version: 1, base: [], steps: steps.map((params, i) => ({ id: `s${i}`, part: 0, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], params })) },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      parts: [],
      status: [],
      madeBy: {},
      redo: [],
    }
    const host = {
      ...NO_ENGINE_HOST,
      get: () => design,
      // A step within its bound reaches the replay; this host stops there.
      replay: async () => {
        replayed.push(1)
        throw new Error('replayed')
      },
    } as unknown as typeof NO_ENGINE_HOST
    const edit = designToolset(host).find((t) => t.name === 'design.edit_step')!
    const run = (step: number, value: number) => edit.run({ design: 'd1', step, value } as never, {} as never).then(() => new Error('ran'), (e: unknown) => e as Error)
    for (const [step, over, within] of [
      [1, 1001, 1000],
      [2, 1001, 1000],
      [3, 51, 50],
      [4, 51, 50],
    ] as const) {
      const refused = await run(step, over)
      expect(refused, `step ${step}`).toBeInstanceOf(ToolInputError)
      expect(refused.message).toMatch(/at most/)
      const before = replayed.length
      expect((await run(step, within)).message, `step ${step}`).toBe('replayed')
      expect(replayed.length).toBe(before + 1)
    }
  })

  it('report an oversized call as it is, rather than run it here', async () => {
    const { run } = routed((async () => {
      throw Object.assign(new Error('args are over 64 KB'), { code: 'bad_request' })
    }) as AppLinkCaller['call'])
    const e = (await run('geom.extrude', { design: 'obj_1', shape: { type: 'svg', svg: 'x', widthMm: 10 }, distance_mm: 1 }).catch((x: unknown) => x)) as ToolInputError
    expect(e.code).toBe('invalid_input')
    expect(e.message).toBe('args are over 64 KB')
  })

  it('say a busy app is worth another try', async () => {
    const { run } = routed((async () => {
      throw Object.assign(new Error('the person is changing that object in the app'), { code: 'busy' })
    }) as AppLinkCaller['call'])
    const e = (await run('design.undo', { design: 'obj_1' }).catch((x: unknown) => x)) as ToolInputError
    expect(e.code).toBe('busy')
    expect(e.message).toMatch(/wait a moment and call again/)
  })
})

describe('design tools with --app', () => {
  const required = (call: AppLinkCaller['call']) => {
    const tools = routeToApp(designToolset(NO_ENGINE_HOST), { call }, 'SlicerX', { required: true })
    return (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never)
  }

  it('run in the app, without the --no-app note', async () => {
    const run = required((async () => ({ summary: 'New design Clip', output: { design: 'obj_1' } })) as AppLinkCaller['call'])
    const out = await run('design.new', { name: 'Clip' })
    expect(out.summary).toBe('New design Clip (in SlicerX)')
    expect(out.output).toEqual({ design: 'obj_1', in: 'app' })
  })

  it('refuse instead of running here while the link does not answer, and say why', async () => {
    for (const [code, message, why] of [
      ['app_link_off', '', /app link is off: turn it on in SlicerX's Settings/],
      ['app_closed', '', /SlicerX is not open/],
      ['forbidden', '', /not allowed on the app link/],
      ['unauthorized', '', /not allowed on the app link/],
      ['bad_request', 'unknown method app.call', /older than the app link/],
    ] as const) {
      const run = required((async () => {
        throw Object.assign(new Error(message || code), { code })
      }) as AppLinkCaller['call'])
      const e = await run('design.new', { name: 'Clip' }).catch((x: unknown) => x)
      // Never engine_unavailable: nothing ran on this server's designs.
      expect((e as ToolInputError).code, code).toBe('not_configured')
      expect((e as ToolInputError).message, code).toMatch(why)
      expect((e as ToolInputError).message, code).toMatch(/run without --app/)
      expect((e as ToolInputError).details, code).toEqual({ appLink: code })
    }
  })

  it('still pass the app\'s own refusals on as they are', async () => {
    const run = required((async () => {
      throw fail('busy')
    }) as AppLinkCaller['call'])
    const e = await run('design.undo', { design: 'obj_1' }).catch((x: unknown) => x)
    expect((e as ToolInputError).code).toBe('busy')
  })
})

describe('plate edits over the app link', () => {
  // Stand-ins for the server's project tools: here they answer from the server's own project.
  const here = ['project.move', 'project.rotate', 'project.scale', 'project.object_settings'].map((name) => ({ name, run: vi.fn(async () => ({ summary: `${name} here` })) }))
  const route = (call: AppLinkCaller['call'], opts: RouteOptions) => {
    const tools = routeToApp(here as never, { call }, 'SlicerX', opts)
    return (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never)
  }
  const app = vi.fn(async (method: string) => ({ summary: `ran ${method}`, output: { objects: [{ id: 'obj_1' }] } }))

  it('move, turn and scale an object the server does not have on the app\'s plate, with no note', async () => {
    expect([...APP_PROJECT_TOOLS]).toEqual(['project.move', 'project.rotate', 'project.scale'])
    const run = route(app as AppLinkCaller['call'], { serverHas: (o) => o === 'Bracket' })
    const out = await run('project.move', { object: 'Box', x: 50, y: 60 })
    expect(app).toHaveBeenCalledWith('project.move', { object: 'Box', x: 50, y: 60 })
    expect(out.summary).toBe('ran project.move (in SlicerX)')
    expect(out.output).toEqual({ objects: [{ id: 'obj_1' }], in: 'app' })
    // The server's own object stays here, and so does every other project tool.
    app.mockClear()
    expect((await run('project.rotate', { object: 'Bracket', rotate: [0, 0, 90] })).summary).toBe('project.rotate here')
    expect((await run('project.object_settings', { object: 'Box', settings: {} })).summary).toBe('project.object_settings here')
    expect(app).not.toHaveBeenCalled()
  })

  it('run here while the link is off, and with --app refuse instead', async () => {
    const off = (async () => {
      throw Object.assign(new Error('off'), { code: 'app_link_off' })
    }) as AppLinkCaller['call']
    expect((await route(off, {})('project.scale', { object: 'Box', scale: 2 })).summary).toBe('project.scale here')
    const e = await route(off, { required: true, serverHas: () => true })('project.scale', { object: 'Box', scale: 2 }).catch((x: unknown) => x)
    expect((e as ToolInputError).code).toBe('not_configured')
  })
})

describe('the design timeline over the app link', () => {
  it('reads and rolls the timeline in the app; here, rolling back says it needs the app', async () => {
    const call = vi.fn(async (method: string, args: Record<string, unknown>) => (method === 'design.roll' ? { summary: 'Rolled back to 1 of 2', output: { marker: args['marker'], end: 2, rolledBack: true } } : { summary: '2 items, at the end', output: { marker: 2, end: 2, items: [] } }))
    const { run } = routed(call as AppLinkCaller['call'])
    expect((await run('design.timeline', {})).output).toMatchObject({ marker: 2, in: 'app' })
    const rolled = await run('design.roll', { marker: 1 })
    expect(call).toHaveBeenCalledWith('design.roll', { marker: 1 })
    expect(rolled.summary).toMatch(/^Rolled back to 1 of 2 \(in SlicerX\)/)
    expect(rolled.output).toMatchObject({ marker: 1, rolledBack: true, in: 'app' })
    const off = routed(vi.fn(async () => {
      throw Object.assign(new Error('app_closed'), { code: 'app_closed' })
    }) as AppLinkCaller['call'])
    const e = await off.run('design.roll', { marker: 0 }).catch((x: unknown) => x)
    expect((e as Error).message).toMatch(/turn on the app link/)
    expect((await off.run('design.timeline', {})).output).toMatchObject({ marker: 0, end: 0, rolledBack: false })
  })
})

describe('finished sketches over the app link', () => {
  it('puts a sketch in the app timeline, and says it needs the app here', async () => {
    const call = vi.fn(async () => ({ summary: 'Sketch 1 is in the timeline', output: { id: 'sk1', name: 'Sketch 1', loops: 1 } }))
    const { run } = routed(call as AppLinkCaller['call'])
    const loops = [{ type: 'circle', center: [0, 0], diameterMm: 10 }]
    const out = await run('design.sketch', { loops })
    expect(call).toHaveBeenCalledWith('design.sketch', { loops })
    expect(out.output).toMatchObject({ id: 'sk1', name: 'Sketch 1', in: 'app' })
    const off = routed(vi.fn(async () => {
      throw Object.assign(new Error('app_closed'), { code: 'app_closed' })
    }) as AppLinkCaller['call'])
    const e = await off.run('design.sketch', { loops }).catch((x: unknown) => x)
    expect((e as Error).message).toMatch(/turn on the app link/)
  })
})

