// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Two presets of one kind side by side, as the app's Compare presets lists them (@slicerx/settings compareConfigs): the
// settings that differ, by settings group, with labels, both values as the app writes them, and each key.
import { productName, type PrintConfig, type SettingSection } from '@slicerx/contracts'
import { compareConfigs, defaultConfig, vendorParent } from '@slicerx/settings'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { readPresetFiles } from '../presets'
import { serverTool, type ServerToolDeps } from './deps'

interface Side {
  name: string
  section: SettingSection
  /** The keys the preset sets, over the stock settings in `compare`. */
  config: Record<string, unknown>
  inherits?: string
  from: 'profile' | 'file' | 'parent' | 'stock'
}

const SECTION_WORD: Record<SettingSection, string> = { process: 'process', filament: 'filament', printer: 'printer' }

export default (d: ServerToolDeps) => {
  async function profile(q: string): Promise<Side> {
    await d.profiles.prepare([q])
    const p = d.profiles.get(q)
    if (!p) throw new ToolInputError(`No profile "${q}". Use slicerx_list_profiles to find ids such as process:standard or machine:bambu-a1.`, 'unknown_profile', { reason: 'unknown_profile', profile: q })
    return { name: p.name, section: p.section, config: p.config, ...(p.inherits ? { inherits: p.inherits } : {}), from: 'profile' }
  }
  async function file(path: string): Promise<Side> {
    const layers = await readPresetFiles(d.policy, [path])
    if (layers.length !== 1) throw new ToolInputError(`That file holds ${layers.length} presets; compare one preset file at a time.`, 'invalid_input', { reason: 'several_presets', presets: layers.length })
    const l = layers[0]!
    return { name: l.name, section: l.section, config: l.values, ...(l.inherits ? { inherits: l.inherits } : {}), from: 'file' }
  }
  async function parent(of: Side): Promise<Side> {
    // Profiles from slicerx_list_profiles are whole, so only a preset file names a parent.
    if (!of.inherits) throw new ToolInputError(`${of.name} names no parent preset, so there is nothing to compare it with. Compare it with the stock settings instead (against: "stock").`, 'invalid_input', { reason: 'no_parent' })
    const shipped = await vendorParent(of.section, of.inherits)
    if (shipped) return { name: shipped.name, section: of.section, config: shipped.config, from: 'parent' }
    throw new ToolInputError(`The parent preset "${of.inherits}" of ${of.name} is not one ${productName()} ships, so it cannot be compared.`, 'unknown_profile', { reason: 'parent_not_shipped', parent: of.inherits })
  }

  return serverTool({
    name: 'preset_compare',
    title: 'Compare presets',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'settings',
    ungated: true,
    description:
      'Compare two presets of the same kind (process, filament or printer) side by side, or one preset with the maker preset it inherits from (against: "parent") or with the stock settings (against: "stock"), grouped and labeled the way Compare presets in the app lists them. ' +
      'Each side is a profile id or name from slicerx_list_profiles (a, b) or a preset file (a_file, b_file: a preset .json or preset bundle the server can read, as profile_files in slicerx_slice_file reads). A setting a side leaves out reads as its default, and the stock side is the defaults of the kind (slicerx_list_setting_defaults); the app compares over the stock settings of the printer on the plate instead, which slicerx_app_preset_compare reads. ' +
      'Returns the settings that differ (every setting of the kind with all: true, each marked differs), grouped by settings group in the app\'s order, each with its label, key, both values and both as the app writes them (aText, bText); G-code settings also carry the lines the second side adds and removes and a unified diff. ' +
      'Printer connection details and hidden bookkeeping keys are never listed. Reads only; nothing is changed.',
    input: z
      .object({
        a: z.string().min(1).optional().describe('First preset: a profile id or name, such as "process:standard"'),
        a_file: z.string().min(1).optional().describe('First preset as a preset file path'),
        b: z.string().min(1).optional().describe('Second preset: a profile id or name of the same kind'),
        b_file: z.string().min(1).optional().describe('Second preset as a preset file path'),
        against: z.enum(['parent', 'stock']).optional().describe('Compare the first preset with its parent preset or the stock settings instead of a second preset'),
        all: z.boolean().default(false).describe('List every setting of the kind, not only those that differ'),
      }),
    async run(args) {
      const firsts = [args.a, args.a_file].filter((x) => x !== undefined).length
      if (firsts !== 1) throw new ToolInputError(firsts ? 'Give the first preset once: a or a_file, not both.' : 'Give the first preset as a (a profile) or a_file (a preset file).', 'invalid_input', { reason: firsts ? 'two_firsts' : 'no_first' })
      const seconds = [args.b, args.b_file, args.against].filter((x) => x !== undefined).length
      if (seconds !== 1) throw new ToolInputError(seconds ? 'Give the second side once: b, b_file or against.' : 'Give the second side as b (a profile), b_file (a preset file) or against ("parent" or "stock").', 'invalid_input', { reason: seconds ? 'two_seconds' : 'no_second' })
      const a = args.a ? await profile(args.a) : await file(args.a_file!)
      const b = args.against === 'parent' ? await parent(a) : args.against === 'stock' ? { name: 'Stock', section: a.section, config: {}, from: 'stock' as const } : args.b ? await profile(args.b) : await file(args.b_file!)
      if (a.section !== b.section) throw new ToolInputError(`${a.name} is a ${SECTION_WORD[a.section]} preset and ${b.name} a ${SECTION_WORD[b.section]} preset; compare presets of the same kind.`, 'invalid_input', { reason: 'kinds_differ', a: a.section, b: b.section })
      const stock = defaultConfig(a.section)
      const c = compareConfigs({ ...stock, ...a.config } as PrintConfig, { ...stock, ...b.config } as PrintConfig, { section: a.section, all: args.all, names: [a.name, b.name] })
      const n = c.differ
      return {
        summary: `${a.name} and ${b.name}: ${n === 0 ? 'no settings differ' : `${n} ${n === 1 ? 'setting differs' : 'settings differ'}`}${n ? ` (${c.groups.filter((g) => g.rows.some((r) => r.differs)).map((g) => g.label).join(', ')})` : ''}.`,
        structured: { section: a.section, a: { name: a.name, from: a.from }, b: { name: b.name, from: b.from }, differ: n, groups: c.groups, unknown_keys: c.unknownKeys } as unknown as Record<string, unknown>,
      }
    },
  })
}
