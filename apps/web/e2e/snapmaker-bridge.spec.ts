// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shared bridge flows on a simulated Snapmaker (the 2.0 API, and Moonraker on the U1) printer: see e2e/bridge-brands.ts.
import { brandFile, PRINTERS } from './bridge-brands'

// The A350 has no camera, so the guard's hand trip runs on the U1.
brandFile(PRINTERS.snapmaker, PRINTERS['snapmaker-u1'])
