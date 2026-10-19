// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The running edition's own knowledge index (scripts/build-kb.ts writes src/kb/generated/edition-kb.<id>.json). An
// app build swaps this module for the edition it builds (editionKbPlugin in @slicerx/edition-config/node), so a build
// carries only its own edition's docs and never another's. Outside a build (tests, typecheck) there is none.
import type { KbIndex } from './kb'

const editionKb: KbIndex | null = null
export default editionKb
