// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design toolset: design.* and the geom.* CAD and mesh tools, defined once and run on any design host. The server builds
// them with its files; the app builds the same definitions on its plate, where a model file is not a design and
// every file call says so.
import type { DesignHost } from '@slicerx/cad-history'
import type { PilotTool } from '@slicerx/pilot'
import { cadTools, type CadFiles } from './cad'
import { designTools, type DesignFiles, type DesignToolOptions } from './design-tools'
import { ToolInputError } from './errors'
import { modelingTools, type ModelingFiles } from './modeling-tools'
import { mimirTabTools, type CardPlans } from './tab-tools'

export { appValueInputs, type AppValuesResult } from './app-values'
export { brimEditInput, brimReadInput } from './brim-input'
export { checkResultSchema, createPlanRegistry, DEFAULT_NOZZLE_MM, designCheck, FIX_ROUNDS, MAX_PLANS, nozzleOr, partPlanSchema, PLAN_SIZE_MAX, PlanOwnedError, type BodyFacts, type CheckItem, type CheckResult, type PartPlan, type PlanEntry, type PlanOrigin, type PlanRegistry } from './design-check'
export type { DesignToolOptions } from './design-tools'
export { createCardPlans, mimirTabTools, PartPlanSchema, PLAN_CHANGE, PLAN_GO, PLAN_KEEP, planChoiceId, PlanInputSchema, samePlan, type CardPlans, type PlanAnswer, type PlanInput } from './tab-tools'

export { appVolumeInputs, type AppVolumes } from './app-volumes'
export { appPartInputs, type AppParts } from './app-parts'
export { appDimensionInputs, type AppDimensions } from './app-dimensions'

export { appPlateInputs } from './app-plate-inputs'

export { projectSettingsInput, projectSettingsReadInput } from './project-settings-input'

const noFiles = (): never => {
  throw new ToolInputError('Model files are for the MCP server; here, give a design instead.', 'not_supported')
}

/** Files where there are none: every call refuses with not_supported. */
export const NO_DESIGN_FILES: DesignFiles = { model: async () => noFiles(), open: async () => noFiles(), save: async () => noFiles() }
export const NO_CAD_FILES: CadFiles = { engine: false, call: async () => noFiles(), path: async () => noFiles(), stl: () => noFiles() }
export const NO_MODELING_FILES: ModelingFiles = { call: async () => noFiles(), mesh: async () => noFiles() }

/** A host for a server with no geometry engine: every design call says so (the app link may still take them). */
export const NO_ENGINE_HOST: DesignHost = {
  get: () => noEngine(),
  list: () => [],
  create: async () => noEngine(),
  add: async () => noEngine(),
  replay: async () => noEngine(),
  call: async () => noEngine(),
}

function noEngine(): never {
  throw new ToolInputError('Designs need the sx-geom engine, which this server did not find, or the app link to the open app.', 'engine_unavailable')
}

/** The design tools and the CAD tools on `host`, with the files the caller has. */
export function designToolset(host: DesignHost, files: { design?: DesignFiles; cad?: CadFiles; modeling?: ModelingFiles } = {}, opts: DesignToolOptions = {}): PilotTool<never>[] {
  return [...designTools(host, files.design ?? NO_DESIGN_FILES, opts), ...cadTools({ files: files.cad ?? NO_CAD_FILES, designs: host, nozzleMm: opts.nozzleMm }), ...modelingTools({ files: files.modeling ?? NO_MODELING_FILES, designs: host })]
}

/**
 * The mimir tab's tools on `host`: its own (the question, the lookup card, the dimension sheet, design.plan) and the
 * design toolset with no files. design.check reads the card's plans and holds walls to `nozzleMm`; the part built after
 * an approved plan ties to it (withPlanTies), so design.check checks that design. The app's tab and the creative eval
 * both make their tools here, so the eval offers what the tab offers. `newPlanId` names each plan (default random).
 */
export function tabToolset(host: DesignHost, card: CardPlans, opts: { nozzleMm?: () => number | undefined; newPlanId?: () => string } = {}): PilotTool<never>[] {
  const plan = card.planTool(opts.newPlanId ? { newId: opts.newPlanId } : {})
  return card.withPlanTies(mimirTabTools(plan, designToolset(host, {}, { plans: card.plans, nozzleMm: opts.nozzleMm, cardSide: true })))
}

export { appUnitInputs, type AppUnits } from './app-units'
export { appPaintReadInput, appPaintPreviewInput, appPaintApplyInput, appPaintClearInput, appPaintFromTextureInput, storedTarget } from './app-paint-input'
