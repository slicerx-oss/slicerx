// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Zod without its compiled parsers. Zod checks once whether `new Function` works, the first time an object schema is
// made, and the app's content security policy refuses it, which the web view reports as an error even though Zod
// catches it. With jitless set first, Zod never asks. The app's entry points import this before anything else, so it
// runs before any module makes a schema.
//
// This is what z.config({ jitless: true }) does, without importing Zod: Zod keeps its settings on
// globalThis.__zod_globalConfig and adopts an object already there, so the startup bundle does not grow by the Zod
// that otherwise loads later. test/zod-jitless.test.ts proves it against the real Zod.
const g = globalThis as { __zod_globalConfig?: { jitless?: boolean } }
;(g.__zod_globalConfig ??= {}).jitless = true

export {}
