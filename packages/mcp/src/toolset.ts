// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design toolset: design.* and the geom.* CAD and mesh tools, defined once and run on any design host. The server builds
// them with its files; the app builds the same definitions on its plate, where a model file is not a design and
// every file call says so.
import type { DesignHost } from '@slicerx/cad-history'
import { lookTool } from './look'
import type { Bed } from './plan-detail'
import type { PilotTool } from '@slicerx/pilot'
import { cadTools, type CadFiles } from './cad'
import { createPlanRegistry } from './design-check'
import { designTools, type DesignFiles, type DesignToolOptions } from './design-tools'
import { ToolInputError } from './errors'
import { modelingTools, type ModelingFiles } from './modeling-tools'
import { paintTools } from './paint'
import { filamentTools, withNewFilaments, type FilamentList } from './tab-filaments'
import { mimirTabTools, type CardPlans } from './tab-tools'

export { appValueInputs, type AppValuesResult } from './app-values'
export { brimEditInput, brimReadInput } from './brim-input'
export { layerProfileEditInput, layerProfileReadInput } from './layer-profile-input'
export { checkResultSchema, createPlanRegistry, DEFAULT_NOZZLE_MM, designCheck, FIX_ROUNDS, MAX_PLANS, nozzleOr, partPlanSchema, PLAN_SIZE_MAX, PlanOwnedError, type BodyFacts, type CheckItem, type CheckResult, type PartPlan, type PlanEntry, type PlanOrigin, type PlanRegistry } from './design-check'
export type { DesignToolOptions } from './design-tools'
export { FILAMENT_TOOLS, filamentTools, SLOT_TOOLS, withNewFilaments, type FilamentList, type FilamentPatch, type TabFilament } from './tab-filaments'
export { DEFAULT_BED, DETAIL_LABEL, DETAIL_LEVELS, DETAIL_LINE, DISPLAY_FILL, displaySize, type Bed, type DetailLevel } from './plan-detail'
export { createCardPlans, mimirTabTools, PartPlanSchema, PLAN_CHANGE, PLAN_GO, PLAN_KEEP, planChoiceId, PlanInputSchema, samePlan, type CardPlans, type PlanAnswer, type PlanInput } from './tab-tools'
// the print-in-place gap rule design.check and geom.fit_check use: limits by direction, the way a gap runs, and whether it clears
export { clearsFitLimit, FIT_TOLERANCE_MM, fitDirection, fitLimitFor, fitLimits, fitVerdict, type FitDirection, type FitProfile } from './fit-facts'
export type { FitGap, FitLimits } from './design-check'

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
  // one registry for design.check and geom.fit_check, which records the fit checks design.check asks for
  const plans = opts.plans ?? createPlanRegistry()
  return [...designTools(host, files.design ?? NO_DESIGN_FILES, { ...opts, plans }), ...cadTools({ files: files.cad ?? NO_CAD_FILES, designs: host, nozzleMm: opts.nozzleMm, fitProfile: opts.fitProfile, plans }), ...modelingTools({ files: files.modeling ?? NO_MODELING_FILES, designs: host, plans, nozzleMm: opts.nozzleMm, fitProfile: opts.fitProfile })]
}

/**
 * The mimir tab's tools on `host`: its own (the question, the lookup card, the dimension sheet, design.plan) and the
 * design toolset with no files. design.check reads the card's plans and holds walls to `nozzleMm`; the part built after
 * an approved plan ties to it (withPlanTies), so design.check checks that design, and design.plan refuses a second plan of a part built from one. The app's tab and the creative eval
 * both make their tools here, so the eval offers what the tab offers. `newPlanId` names each plan (default random).
 * `filaments` (the open project's) adds project.add_filament and project.set_filament, and part makers given a slot past
 * the last filament add it, and so does applying color paint in one. The paint tools are the server's, on `host`.
 */
export function tabToolset(host: DesignHost, card: CardPlans, opts: { nozzleMm?: () => number | undefined; fitProfile?: DesignToolOptions['fitProfile']; newPlanId?: () => string; filaments?: FilamentList; bed?: () => Bed | undefined; exactByDefault?: boolean } = {}): PilotTool<never>[] {
  // design.plan names the gaps design.check holds a print-in-place part to: the same nozzle, layer height and material
  const fitProfile = () => ({ ...opts.fitProfile?.(), nozzleMm: opts.nozzleMm?.() })
  const plan = card.planTool({ ...(opts.newPlanId ? { newId: opts.newPlanId } : {}), fitProfile, designs: () => host.list(), ...(opts.bed ? { bed: opts.bed } : {}) })
  // paint.preview, paint.apply and paint.regions paint a design's parts as a step of its history, as on the server
  // design.look draws the design for a cloud model to look at on a vague follow-up (look.ts); a local model is not offered it
  // design.check reads the open project's filament colors, to hold a colored plan's paint to them
  const filaments = opts.filaments
  const tools = [...card.withPlanTies(mimirTabTools(plan, designToolset(host, {}, { plans: card.plans, nozzleMm: opts.nozzleMm, fitProfile: opts.fitProfile, cardSide: true, exactByDefault: opts.exactByDefault, ...(filaments ? { filamentColors: () => filaments.list().map((f) => f.color) } : {}) }))), ...paintTools(host), lookTool(host, opts.filaments)]
  // the open project's filaments, where the host has them: the part makers add the ones their slot is past, and two
  // tools add and set them
  return opts.filaments ? [...withNewFilaments(tools, opts.filaments), ...filamentTools(opts.filaments)] : tools
}


export { appUnitInputs, type AppUnits } from './app-units'
export { appPaintReadInput, appPaintPreviewInput, appPaintApplyInput, appPaintClearInput, appPaintFromTextureInput, bandDepth, storedTarget } from './app-paint-input'
