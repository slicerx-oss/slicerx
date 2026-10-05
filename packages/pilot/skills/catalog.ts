// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Binds the skill catalog (knowledge/skills.yaml) to the tool registry. Each
// catalog skill lists the registry tools it runs with; a skill is offered to
// the model as a playbook when every tool it needs is registered. Skills with
// a dedicated tool of the same id do their multi-step work in code.
import type { KbSkill } from '../src/kb/kb'

/**
 * Registry tools per catalog skill. The first entry is the main tool. mimir
 * keeps the jobs a settings panel cannot do: diagnosing failed prints, turning
 * goals into settings and geometry, cited answers, setup help and farm batches.
 * Deterministic checks (preflight, risk, spool fit, overnight readiness, the
 * material switch diff, slicing) are plain functions the app calls instead.
 */
export const SKILL_TOOLS: Record<string, string[]> = {
  check_print: ['check_print', 'print.adjust', 'printer.status', 'kb.troubleshoot'],
  diagnose: ['diagnose', 'kb.troubleshoot', 'printer.status'],
  tune_from_failure: ['kb.troubleshoot', 'settings.plan', 'slice', 'settings.apply'],
  resume_from_layer: ['resume_from_layer'],
  intent_to_settings: ['kb.intent', 'settings.plan', 'settings.apply'],
  material_recommend: ['material_recommend', 'kb.intent', 'kb.filament'],
  optimize_to_target: ['optimize_to_target'],
  compare_setups: ['compare_setups'],
  split_to_fit: ['cut', 'orient', 'arrange'],
  make_model: ['make_model'],
  text_to_part: ['text_to_part'],
  knowledge_answer: ['kb.search', 'kb.filament', 'kb.printer', 'kb.workflow', 'kb.troubleshoot', 'kb.sources', 'web.lookup'],
  printer_setup: ['printer_setup', 'printer_discover', 'printer_profile_search', 'setup.look', 'printer_test', 'printer_add'],
  calibrate: ['calibrate', 'kb.workflow', 'printer.queue', 'settings.apply'],
  farm_schedule: ['schedule', 'slice', 'estimate', 'printer.list', 'printer.queue'],
  queue_control: ['printer.queue', 'printer.pause', 'printer.resume', 'printer.cancel', 'printer.status'],
}

/** Catalog skills whose tools are all registered. */
export function availableSkills(catalog: KbSkill[], registered: (name: string) => boolean): KbSkill[] {
  return catalog.filter((s) => {
    const tools = SKILL_TOOLS[s.id]
    return tools !== undefined && tools.length > 0 && tools.every(registered)
  })
}

/** The playbook section of the system prompt: one line per available skill. */
export function playbooks(skills: KbSkill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.id}: ${s.purpose} Tools: ${(SKILL_TOOLS[s.id] ?? []).join(', ')}. Approval: ${s.approval}.`)
  return `Skills. When a request matches one, follow it with the tools named; a tool of the same name as the skill does the whole job in one call.\n${lines.join('\n')}`
}
