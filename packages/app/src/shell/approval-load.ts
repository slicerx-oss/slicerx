// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The approval card's module. The app's lazy slot loads it the first time a card is asked for, and a view whose
// controls ask for one (a printer's live view) fetches it as it opens, so the card shows as soon as it is asked for.
export const loadApprovalDialog = () => import('./approval-dialog')
