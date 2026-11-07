// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What evals in other packages build on (the creative eval in @slicerx/mcp, which runs mimir on the tab's design
// tools): the eval environment, the scripted client that replays recorded replies, the fit rule and the provider
// adapters. No node APIs here; evals/node.ts has the geometry engine and the key-reading transport.
export { CAD_TOOLS } from '../src/runtime'
export { createEvalEnv, evalKb, noteApprovals, type Audit, type EvalEnvOptions, type EvalHosts, type EvalProject } from './harness'
export { assessFit } from '../skills/fit_check/index'
export { adapterFor, createTransportClient } from '../src/provider/client'
export { createScriptedClient, type ScriptStepData } from '../src/provider/scripted'

/** This folder: the eval log (LOG.md) and results (results.jsonl) every mimir eval appends to. */
export const EVALS_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname)
