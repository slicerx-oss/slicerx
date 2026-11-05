// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The YAML parser for the knowledge base. The library (dist/index.js) and runs from source import it like any other
// module, so a host that bundles the library takes it in. The server's own builds replace this file in their CLI
// entries (scripts/build.mjs) so yaml loads the first time a knowledge file is parsed, not at every start: the npm
// build with require() from node_modules, the self-contained build with a bundled require() that runs on first call.
import * as yamlModule from 'yaml'

/** The `yaml` package. */
export const yaml = (): typeof import('yaml') => yamlModule
