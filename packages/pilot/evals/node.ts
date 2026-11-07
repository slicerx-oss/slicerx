// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node only, for evals in other packages: the geometry engine, the transport that reads the provider keys, and the
// folder of the eval log.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export { evalGeom } from './geom'
export { createNodeTransport } from '../src/node/index'

/** This folder: the eval log (LOG.md) and results (results.jsonl) every mimir eval appends to. */
export const EVALS_DIR = dirname(fileURLToPath(import.meta.url))
