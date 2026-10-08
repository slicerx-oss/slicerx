// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Zod without its compiled parsers. Zod checks once whether `new Function` works, the first time an object schema is
// made, and the app's content security policy refuses it, which the web view reports as an error even though Zod
// catches it. With jitless set first, Zod never asks. The app's entry points import this before anything else, so it
// runs before any module makes a schema.
import { z } from 'zod'

z.config({ jitless: true })
