// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/app/shell: what a host needs before the first screen, and nothing else. The package index re-exports
// every module of the app, so importing it at startup pulls them all into the first load; the rest of the index loads
// after startup (apps/web/src/main.tsx).
export { SlicerXApp } from './app'
export { setCurrentEdition } from './edition'
