// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every tool schema a model can be handed is valid JSON Schema 2020-12: the MCP list (what integrators pass on)
// and mimir's own specs. The Messages API refuses a whole request over one schema that is not.
import Ajv2020 from 'ajv/dist/2020'
import { toolSpec } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { connect } from './helpers'

const ajv = new Ajv2020({ strict: false })
const problems = (schema: unknown): string | null => (ajv.validateSchema(schema as object) ? null : JSON.stringify(ajv.errors).slice(0, 300))

describe('tool schemas are JSON Schema 2020-12', () => {
  it('the MCP tool list, design and geom tools included', async () => {
    const h = await connect({ geomEngine: (async () => ({})) as never })
    const { tools } = await h.client.listTools()
    expect(tools.some((t) => t.name === 'slicerx_geom_cut')).toBe(true)
    const bad = tools.flatMap((t) => [
      ...(problems(t.inputSchema) ? [`${t.name} input: ${problems(t.inputSchema)}`] : []),
      ...(t.outputSchema && problems(t.outputSchema) ? [`${t.name} output: ${problems(t.outputSchema)}`] : []),
      ...(t.inputSchema.type === 'object' ? [] : [`${t.name}: input is not an object`]),
      ...('$schema' in t.inputSchema ? [`${t.name}: carries a $schema line`] : []),
    ])
    expect(bad).toEqual([])
  })

  it("mimir's specs for the same tools", async () => {
    const h = await connect({ geomEngine: (async () => ({})) as never })
    const bad = h.ctx.tools.map((t) => [t.name, problems(toolSpec(t).inputSchema)] as const).filter(([, p]) => p)
    expect(bad).toEqual([])
  })
})
