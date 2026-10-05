// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ToolShared } from '../src/shared'
import type { PilotTool } from '../src/tool'
import { createArrange } from './arrange/index'
import { createCalibrate } from './calibrate/index'
import { createCut } from './cut/index'
import { createCheckPrint, createPrintAdjust } from './check_print/index'
import { createDiagnose } from './diagnose/index'
import { createEstimate } from './estimate/index'
import { createOrient } from './orient/index'
import { createSlice } from './slice/index'
import { create as batchA } from './batch-a'
import { create as batchB } from './batch-b'
import { create as batchC } from './batch-c'
import { create as batchD } from './batch-d'
import { SKILL_TOOLS } from './catalog'

/** The skills mimir offers, in catalog order (knowledge/skills.yaml). */
export const SKILL_NAMES = ['check_print', 'diagnose', 'tune_from_failure', 'resume_from_layer', 'intent_to_settings', 'material_recommend', 'optimize_to_target', 'compare_setups', 'split_to_fit', 'make_model', 'text_to_part', 'knowledge_answer', 'printer_setup', 'calibrate', 'farm_schedule', 'queue_control'] as const

/**
 * One line per skill for the inspector and for suggestion chips in a docked
 * panel: `example` is a prompt the user can send as is. Kept in step with
 * knowledge/skills.yaml (a test checks it).
 */
export const SKILL_INFO: { name: (typeof SKILL_NAMES)[number]; title: string; version: string; description: string; example: string }[] = [
  { name: 'check_print', title: "Check on a print", version: '1.0.0', description: "Take a fresh camera frame of a running print, say what it shows, and propose fan, speed, temperature or pause changes, each behind an approval card.", example: "How's the print going?" },
  { name: 'diagnose', title: "Diagnose a failure", version: '1.0.0', description: "Explain a failed or bad print from photos, camera snapshots and printer logs, and propose fixes.", example: "Why did Bay 4 fail overnight?" },
  { name: 'tune_from_failure', title: "Tune a profile from a failed print", version: '1.0.0', description: "Turn a diagnosis into a tested profile change, print a small check part, and save the fix to a new profile version.", example: "Fix the stringing in my PETG profile for good" },
  { name: 'resume_from_layer', title: "Resume from a layer", version: '1.0.0', description: "After a failure with the part still on the bed, find the last good layer and build a resume file at the right height.", example: "Resume Bay 4 from layer 212" },
  { name: 'intent_to_settings', title: "Settings from a request", version: '1.0.0', description: "Turn a plain request (strong, fast, watertight, by Friday) into a settings diff with reasons and sources.", example: "12 functional brackets in PETG, strong, by tomorrow" },
  { name: 'material_recommend', title: "Recommend a material", version: '1.0.0', description: "Pick the material for a use case (heat, sun, flex, chemicals, food contact) from what the user owns first.", example: "What should I print a car phone mount in? It sits on the dashboard in summer." },
  { name: 'optimize_to_target', title: "Optimize to a target", version: '1.0.0', description: "Hit a target such as under 2 hours, under 40 g, or strongest within 3 hours by slicing hundreds of real candidates over layer height, walls, infill, speed and orientation, then show the best few with their tradeoffs.", example: "Make this under 2 hours but as strong as possible" },
  { name: 'compare_setups', title: "Compare two setups", version: '1.0.0', description: "Slice the same plate two ways and compare time, grams, strength proxies and risk before choosing.", example: "Is a 0.6 nozzle worth it for this batch?" },
  { name: 'split_to_fit', title: "Split to fit the bed", version: '1.0.0', description: "Cut an oversized model into parts that fit the printer, with dovetail, pin or dowel connectors and seams placed where they hide.", example: "This helmet is too tall for my A1 mini, split it" },
  { name: 'make_model', title: "Make a multi-color model", version: '1.0.0', description: "Build a multi-color model from a request (boxes, cylinders, extruded text, the SlicerX mark or an SVG), map the colors to filament slots with matching presets, add it to the project on its own plate, slice it and report time and grams per color. Optionally write a 3MF project.", example: "Build me a SlicerX logo in SlicerX black and X pink" },
  { name: 'text_to_part', title: "Part from a description", version: '1.0.0', description: "Generate a simple functional part from a description as parametric geometry, show it for review, then slice it.", example: "40 mm L bracket, two M3 holes, 3 mm thick" },
  { name: 'knowledge_answer', title: "Answer printing questions", version: '1.0.0', description: "Answer material, printer and technique questions from the knowledge base with sources, and fall back to a cited web lookup.", example: "Can the AMS 2 Pro dry nylon?" },
  { name: 'printer_setup', title: "Printer setup", version: '1.0.0', description: "Walk a new user through adding a printer: optional look and feel, brand, model, nozzle, connection method, test connection, first calibration suggestion. One question at a time, asking before each printer action, never taking access codes in chat.", example: "Set up my new printer" },
  { name: 'calibrate', title: "Calibration suites", version: '1.0.0', description: "Plan and print only the tests a situation needs (temperature, max volumetric speed, pressure advance, flow, retraction, tolerance, shrinkage), then save results to a new profile for that spool.", example: "Tune a profile for this new PETG spool" },
  { name: 'farm_schedule', title: "Schedule by due date and cost", version: '1.0.0', description: "Plan plates across the chosen printers (or a saved fleet group) to meet due dates at the lowest machine cost, using printers that already have the material loaded.", example: "Get these three orders done by Friday, cheapest printers first" },
  { name: 'queue_control', title: "Queue, start, pause, cancel", version: '1.0.0', description: "Send plates to printers and control running jobs, always behind the approval gate.", example: "Send plate 2 to Bay 3 and start it" },
]

/** Every tool this package defines with source `skill` (plus kb.sources). */
function allSkillTools(shared: ToolShared): PilotTool<never>[] {
  return [createOrient(), createArrange(shared), createSlice(shared), createEstimate(shared), createCut(), createCalibrate(), createDiagnose(), createCheckPrint(), createPrintAdjust(), ...batchA(shared), ...batchB(shared), ...batchC(shared), ...batchD(shared)] as PilotTool<never>[]
}

/** Registry tools some mimir skill runs with (skills/catalog.ts). */
const PILOT_TOOL_NAMES = new Set(Object.values(SKILL_TOOLS).flat())

/**
 * The skill tools mimir is offered: only those its catalog skills use.
 * Everything deterministic is in createAppFunctionTools instead.
 */
export function createSkills(shared: ToolShared): PilotTool<never>[] {
  return allSkillTools(shared).filter((t) => PILOT_TOOL_NAMES.has(t.name))
}

/**
 * Deterministic checks and project operations the app runs as plain functions,
 * with no model and no key (src/functions.ts). mimir does not see them.
 */
export function createAppFunctionTools(shared: ToolShared): PilotTool<never>[] {
  return allSkillTools(shared).filter((t) => !PILOT_TOOL_NAMES.has(t.name))
}
