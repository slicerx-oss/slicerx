// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The built server loads the YAML parser, Ajv, zod-to-json-schema and the HTTP transport on first use (src/deferred.ts,
// src/http-transport.ts, scripts/build.mjs). The SDK imports its Ajv provider and zod-to-json-schema at start, so the
// built server points those imports at stand-ins (src/sdk-ajv.ts, src/sdk-zod-json.ts, src/sdk-defer-hook.ts). These
// check that each stand-in gives what the real module gives, that the hook redirects those imports and nothing else,
// and that the SDK still imports them by the paths the hook and the build look for. scripts/mcp-package.test.mjs
// checks the built package itself.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AjvJsonSchemaValidator as SdkValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { describe, expect, it } from 'vitest'
import * as z3 from 'zod/v3'
import { yaml } from '../src/deferred'
import { httpTransport } from '../src/http-transport'
import { AjvJsonSchemaValidator } from '../src/sdk-ajv'
import { sdkDeferResolve } from '../src/sdk-defer-hook'
import { zodToJsonSchema } from '../src/sdk-zod-json'

const pkg = resolve(__dirname, '..')
const sdkResolve = (sub: string): string => createRequire(resolve(pkg, 'package.json')).resolve(`@modelcontextprotocol/sdk/${sub}`)
// The ES module build of the SDK (what the server imports), found beside the CommonJS one require() resolves.
const sdkFile = (sub: string): string => sdkResolve(sub).replace(/([\\/])cjs([\\/])/, '$1esm$2')
const sdkEsm = 'file:///p/node_modules/@modelcontextprotocol/sdk/dist/esm'

describe('deferred dependencies', () => {
  it('parses YAML with the yaml package', () => {
    expect(yaml().parse('kind: material\nid: pla\naliases: [PLA, pla+]\n')).toEqual({ kind: 'material', id: 'pla', aliases: ['PLA', 'pla+'] })
  })

  it('gives the SDK HTTP transport', async () => {
    expect(await httpTransport()).toBe(StreamableHTTPServerTransport)
  })

  it('checks a schema the way the SDK provider does', () => {
    const schema = {
      type: 'object' as const,
      properties: { approve: { type: 'boolean' as const }, mail: { type: 'string' as const, format: 'email' } },
      required: ['approve'],
    }
    const ours = new AjvJsonSchemaValidator().getValidator<{ approve: boolean }>(schema)
    const sdk = new SdkValidator().getValidator<{ approve: boolean }>(schema)
    for (const input of [{ approve: true }, { approve: 'yes' }, {}, { approve: false, mail: 'a@b.co' }, { approve: false, mail: 'not mail' }]) {
      expect(ours(input)).toEqual(sdk(input))
    }
    expect(ours({ approve: true }).valid).toBe(true)
    expect(ours({ approve: false, mail: 'not mail' }).valid).toBe(false)
  })

  it('converts a Zod 3 schema the way zod-to-json-schema does', () => {
    const real = (createRequire(sdkResolve('server/mcp.js'))('zod-to-json-schema') as { zodToJsonSchema: (s: unknown, o?: unknown) => unknown }).zodToJsonSchema
    const schema = z3.object({ name: z3.string().min(1), copies: z3.number().int().optional(), kind: z3.union([z3.literal('a'), z3.literal('b')]) })
    const opts = { strictUnions: true, pipeStrategy: 'input' }
    expect(zodToJsonSchema(schema, opts)).toEqual(real(schema, opts))
    expect(zodToJsonSchema(schema, opts)).toMatchObject({ type: 'object', required: ['name', 'kind'] })
  })

  it('redirects only the listed SDK imports', () => {
    const targets = { ajv: 'file:///dist/sdk-ajv.js', zodJson: 'file:///dist/sdk-zod-json.js' }
    const hook = sdkDeferResolve(targets)
    const passed: string[] = []
    const next = (specifier: string): { url: string } => {
      passed.push(specifier)
      return { url: `next:${specifier}` }
    }
    const from = (parentURL: string, specifier: string) => hook(specifier, { parentURL, conditions: [], importAttributes: {} }, next as never)
    const to = (url: string) => ({ url, format: 'module', shortCircuit: true })
    for (const side of ['server', 'client']) expect(from(`${sdkEsm}/${side}/index.js`, '../validation/ajv-provider.js')).toEqual(to(targets.ajv))
    expect(from(`${sdkEsm}/server/zod-json-schema-compat.js`, 'zod-to-json-schema')).toEqual(to(targets.zodJson))
    expect(from(`${sdkEsm}/validation/index.js`, '../validation/ajv-provider.js')).toEqual({ url: 'next:../validation/ajv-provider.js' })
    expect(from('file:///p/src/server.js', '../validation/ajv-provider.js')).toEqual({ url: 'next:../validation/ajv-provider.js' })
    expect(from('file:///p/src/schema.js', 'zod-to-json-schema')).toEqual({ url: 'next:zod-to-json-schema' })
    expect(from(`${sdkEsm}/server/index.js`, '../types.js')).toEqual({ url: 'next:../types.js' })
    expect(passed).toHaveLength(4)
    // only the imports it is given
    expect(sdkDeferResolve({ ajv: targets.ajv })('zod-to-json-schema', { parentURL: `${sdkEsm}/server/zod-json-schema-compat.js`, conditions: [], importAttributes: {} }, next as never)).toEqual({ url: 'next:zod-to-json-schema' })
  })

  it('finds the SDK importing them by the paths the hook and the build redirect', () => {
    const imports: [string, RegExp, string][] = [
      ['server/index.js', /\/@modelcontextprotocol\/sdk\/dist\/esm\/server\/index\.js$/, `import { AjvJsonSchemaValidator } from '../validation/ajv-provider.js';`],
      ['client/index.js', /\/@modelcontextprotocol\/sdk\/dist\/esm\/client\/index\.js$/, `import { AjvJsonSchemaValidator } from '../validation/ajv-provider.js';`],
      ['server/zod-json-schema-compat.js', /\/@modelcontextprotocol\/sdk\/dist\/esm\/server\/zod-json-schema-compat\.js$/, `import { zodToJsonSchema } from 'zod-to-json-schema';`],
    ]
    for (const [sub, url, line] of imports) {
      const file = sdkFile(sub)
      expect(pathToFileURL(file).href).toMatch(url)
      expect(readFileSync(file, 'utf8')).toContain(line)
    }
  })
})
