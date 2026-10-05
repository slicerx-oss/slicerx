#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Copies the integrator kit docs (docs/integrators) into a package folder before it is packed, so an
// app that installs @slicerx/mcp or @slicerx/embed has them in node_modules: AGENTS.md, quickstart.md,
// llms.txt, and llms-full.txt (AGENTS.md and the quickstart in one file).
//   node scripts/copy-integrator-docs.mjs packages/mcp
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'integrators')
const dest = resolve(process.argv[2] ?? '.')
const read = (f) => readFileSync(join(docs, f), 'utf8')
for (const f of ['AGENTS.md', 'quickstart.md', 'llms.txt']) writeFileSync(join(dest, f), read(f))
writeFileSync(join(dest, 'llms-full.txt'), `${read('AGENTS.md')}\n\n${read('quickstart.md')}`)
