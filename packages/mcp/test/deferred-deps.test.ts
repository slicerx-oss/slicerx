// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The built server loads Ajv and the YAML parser on first use (src/deferred.ts, scripts/build.mjs). The SDK's server
// and client import their Ajv provider at start, so the built server points that one import at a stand-in
// (src/sdk-ajv.ts, src/sdk-ajv-hook.ts). These check that the stand-in checks a schema exactly as the SDK's provider
// does, that the hook redirects that import and nothing else, and that the SDK still imports its provider by the path
// the hook and the build look for. scripts/mcp-package.test.mjs checks the built package itself.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AjvJsonSchemaValidator as SdkValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { describe, expect, it } from 'vitest'
import { yaml } from '../src/deferred'
import { AjvJsonSchemaValidator } from '../src/sdk-ajv'
import { sdkAjvResolve } from '../src/sdk-ajv-hook'

const pkg = resolve(__dirname, '..')
// The ES module build of the SDK (what the server imports), found beside the CommonJS one require() resolves.
const sdkFile = (sub: string): string =>
  createRequire(resolve(pkg, 'package.json')).resolve(`@modelcontextprotocol/sdk/${sub}`).replace(/([\\/])cjs([\\/])/, '$1esm$2')

describe('deferred dependencies', () => {
  it('parses YAML with the yaml package', () => {
    expect(yaml().parse('kind: material\nid: pla\naliases: [PLA, pla+]\n')).toEqual({ kind: 'material', id: 'pla', aliases: ['PLA', 'pla+'] })
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

  it('redirects only the SDK server and client import of the provider', () => {
    const target = 'file:///dist/sdk-ajv.js'
    const hook = sdkAjvResolve(target)
    const passed: string[] = []
    const next = (specifier: string): { url: string } => {
      passed.push(specifier)
      return { url: `next:${specifier}` }
    }
    const from = (parentURL: string, specifier = '../validation/ajv-provider.js') =>
      hook(specifier, { parentURL, conditions: [], importAttributes: {} }, next as never)
    for (const side of ['server', 'client']) {
      expect(from(`file:///p/node_modules/@modelcontextprotocol/sdk/dist/esm/${side}/index.js`)).toEqual({ url: target, format: 'module', shortCircuit: true })
    }
    expect(from('file:///p/node_modules/@modelcontextprotocol/sdk/dist/esm/validation/index.js')).toEqual({ url: 'next:../validation/ajv-provider.js' })
    expect(from('file:///p/src/server.js')).toEqual({ url: 'next:../validation/ajv-provider.js' })
    expect(from('file:///p/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js', '../types.js')).toEqual({ url: 'next:../types.js' })
    expect(passed).toHaveLength(3)
  })

  it('finds the SDK importing its provider by the path the hook and the build redirect', () => {
    for (const sub of ['server/index.js', 'client/index.js']) {
      const file = sdkFile(sub)
      expect(pathToFileURL(file).href).toMatch(/\/@modelcontextprotocol\/sdk\/dist\/esm\/(?:server|client)\/index\.js$/)
      expect(readFileSync(file, 'utf8')).toContain(`import { AjvJsonSchemaValidator } from '../validation/ajv-provider.js';`)
    }
  })
})
