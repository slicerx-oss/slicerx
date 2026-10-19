// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plans the tab's mimir checks its parts against (design.check), by planId. One registry for the window.
import { createPlanRegistry } from '@slicerx/mcp/toolset'

export const mimirPlans = createPlanRegistry()

// Test hook: with localStorage 'slicerx.debug' set (as for window.__sx), scripts reach the plans as window.__mimirPlans.
if (typeof window !== 'undefined' && typeof localStorage !== 'undefined' && localStorage.getItem('slicerx.debug')) Object.assign(window, { __mimirPlans: mimirPlans })
