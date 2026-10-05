// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The planner mimir uses by default: @slicerx/settings' planSettings (filament
// and printer profiles, clamps, blockers and questions) first, then the
// knowledge planner for what it leaves out (nozzle geometry, melt-rate speed
// caps, chamber and printer baseline speeds). Keys planSettings decides keep
// its value and reason.
import type { PilotMachine, SettingValue } from '@slicerx/contracts'
import { planSettings } from '@slicerx/settings'
import type { PlannedChange, PlanOptions, PlanResult, SettingsPlanner } from '../planner'
import type { KnowledgeBase } from './kb'
import { createKbPlanner } from './planner'

const unwrap = (v: SettingValue | null): SettingValue | null => (Array.isArray(v) && v.length === 1 && typeof v[0] !== 'object' ? (v[0] as SettingValue) : v)

export function createCombinedPlanner(kb: KnowledgeBase): SettingsPlanner {
  const kbPlanner = createKbPlanner(kb)
  const resolve = (kind: 'filament' | 'printer', q: string): string => (kb.get(kind, q) ?? kb.search(q, { kinds: [kind], limit: 1 })[0]?.doc)?.id ?? q
  return {
    plan(from: PilotMachine, to: PilotMachine, current?: Record<string, SettingValue>, opts: PlanOptions = {}): PlanResult {
      const f: PilotMachine = { printer: resolve('printer', from.printer), material: resolve('filament', from.material), nozzle: from.nozzle }
      const t: PilotMachine = { printer: resolve('printer', to.printer), material: resolve('filament', to.material), nozzle: to.nozzle }
      const fallback = kbPlanner.plan(f, t, current)
      let sp: ReturnType<typeof planSettings>
      try {
        const planOpts: Parameters<typeof planSettings>[3] = {}
        if (current && Object.keys(current).length) planOpts.keep = new Set(Object.keys(current))
        if (opts.goals?.length) planOpts.intent = { goals: opts.goals.map((g) => (g.level ? { id: g.id, level: g.level } : { id: g.id })) }
        sp = planSettings({ printer: f.printer, filament: f.material, nozzleDiameter: f.nozzle }, { printer: t.printer, filament: t.material, nozzleDiameter: t.nozzle }, opts.base, planOpts)
      } catch {
        return fallback
      }
      const changes = new Map<string, PlannedChange>()
      for (const c of sp.changes) {
        if (c.klass === 'read') continue
        const change: PlannedChange = { key: c.key, label: c.label, section: c.section, before: unwrap(c.before), after: unwrap(c.after) ?? c.after, reason: c.reason, sources: c.sources, approval: c.approval, origin: c.origin }
        if (c.unit) change.unit = c.unit
        if (c.goal) change.goal = c.goal
        changes.set(c.key, change)
      }
      // A blocked setup (abrasive filament on a soft nozzle) gets no settings, only the reasons.
      if (sp.blockers.length === 0) for (const c of fallback.changes) if (!changes.has(c.key)) changes.set(c.key, c)
      const warnings = [...new Set([...sp.warnings, ...fallback.warnings])]
      return {
        from,
        to,
        changes: [...changes.values()],
        warnings,
        blockers: sp.blockers,
        questions: sp.questions,
        caveats: sp.caveats,
        advice: sp.advice,
        clamps: sp.clamps,
        refused: sp.refused,
        tellUser: sp.tellUser,
        computedMs: sp.computedMs,
      }
    },
  }
}
