// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A new server parses no knowledge file: the parse is most of what starting one costs, and a client that runs each call
// in a fresh process pays it every time. The first tool or resource that reads the knowledge base parses it.
import { join } from 'node:path'
import { assistantText, DEFAULT_POLICY } from '@slicerx/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const parsed = vi.hoisted(() => ({ calls: 0 }))
vi.mock('yaml', async (importOriginal) => {
  const yaml = await importOriginal<typeof import('yaml')>()
  return {
    ...yaml,
    parse: (...args: Parameters<typeof yaml.parse>) => {
      parsed.calls++
      return yaml.parse(...args)
    },
  }
})

import { DataStore, normalizeId, resolveDataPaths } from '../src/data'
import { createContext, createSlicerxServer } from '../src/index'
import { ProfileCatalog } from '../src/profiles'
import { createKb } from '../src/registry'
import { createKnowledgeBase, type KbIndex } from '@slicerx/pilot'
import kbIndex from '@slicerx/pilot/kb.json' with { type: 'json' }
import { connect, data, text } from './helpers'

beforeEach(() => {
  parsed.calls = 0
})

describe('a new server and the knowledge base', () => {
  it('creates the server without parsing a knowledge file', async () => {
    const ctx = await createContext({ engine: 'stub', policy: DEFAULT_POLICY })
    parsed.calls = 0
    createSlicerxServer(ctx)
    expect(parsed.calls).toBe(0)
  })

  // The first test here to read the knowledge base: later ones find its files parsed already (data.ts parsedYaml).
  it('parses the knowledge base on the first tool that reads it', async () => {
    const h = await connect()
    parsed.calls = 0
    const r = await h.call('slicerx_knowledge_lookup', { kind: 'filament', id: 'pla' })
    expect(r.isError).toBeFalsy()
    expect(parsed.calls).toBeGreaterThan(10)
  })

  it('still lists the skill catalog, with the text the parsed knowledge base gives', async () => {
    const h = await connect()
    const listed = (await h.client.listResources()).resources.map((r) => r.uri)
    expect(listed).toContain('slicerx://pilot/skills')
    const read = await h.client.readResource({ uri: 'slicerx://pilot/skills' })
    const first = read.contents[0]
    const own = new DataStore(resolveDataPaths()).knowledge().find((e) => e.kind === 'skill_catalog')
    expect(own).toBeDefined()
    expect(first && 'text' in first ? first.text : undefined).toBe(assistantText(own!.text))
    expect(new DataStore(resolveDataPaths()).skillCatalog()).toEqual({ text: own!.text })
  })

  it('slices a file on a machine profile without parsing a knowledge file', async () => {
    const h = await connect()
    parsed.calls = 0
    const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), profiles: ['machine:bambu-a1'] })
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ gcode_path?: string }>(r).gcode_path).toBeTruthy()
    expect(parsed.calls).toBe(0)
  })
})

describe('ProfileCatalog.find without the knowledge base', () => {
  /** find as it was, over the whole list. */
  const findInList = (all: ReturnType<ProfileCatalog['list']>, query: string) => {
    const q = normalizeId(query)
    return all.find((p) => p.id === query) ?? all.find((p) => p.name === query) ?? all.find((p) => normalizeId(p.id.slice(p.id.indexOf(':') + 1)) === q) ?? all.find((p) => normalizeId(p.name) === q)
  }

  it('finds every profile by its id, and by a name, as the whole list does', () => {
    const all = new ProfileCatalog(new DataStore(resolveDataPaths())).list()
    const profiles = new ProfileCatalog(new DataStore(resolveDataPaths()))
    const named = ['bambu-a1', 'Bambu Lab A1', 'pla', 'PETG', 'standard', 'machine:no-such-printer', 'printer:bambu_x1c', 'filament:petg', 'process:no-such-tier']
    for (const q of [...all.map((p) => p.id), ...named]) expect(profiles.find(q), q).toEqual(findInList(all, q))
  })

  it('reads no knowledge file for an id that is not the knowledge base\'s', () => {
    const profiles = new ProfileCatalog(new DataStore(resolveDataPaths()))
    parsed.calls = 0
    for (const id of ['machine:bambu-a1', 'process:standard', 'intent:strong', 'process:slicerx-default']) expect(profiles.find(id)?.id).toBe(id)
    expect(parsed.calls).toBe(0)
    expect(profiles.find('printer:bambu_x1c')?.source).toBe('knowledge')
  })
})

describe('mimir knowledge base, built on first use', () => {
  it('answers as the knowledge base built at once does', () => {
    const lazy = createKb()
    const now = createKnowledgeBase(kbIndex as unknown as KbIndex)
    expect(lazy.size).toBe(now.size)
    expect(lazy.skills()).toEqual(now.skills())
    expect(lazy.settings()).toEqual(now.settings())
    expect(lazy.all('filament')).toEqual(now.all('filament'))
    expect(lazy.get('filament', 'pla')).toEqual(now.get('filament', 'pla'))
    expect(lazy.setting('layer_height')).toEqual(now.setting('layer_height'))
    expect(lazy.search('stringing petg', { limit: 5 })).toEqual(now.search('stringing petg', { limit: 5 }))
    expect(lazy.cite(['bambu_wiki_drying'])).toEqual(now.cite(['bambu_wiki_drying']))
  })
})
