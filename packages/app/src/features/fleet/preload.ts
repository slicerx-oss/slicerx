// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What Pause, Resume, Stop and a speed change load before their approval card can show: the send and printer flow
// and the card itself, both loaded on first use. A printer's live view starts them as it opens, so on a slow phone a
// press brings up the card at once instead of waiting on the network and the parse.
import { loadSendActions } from '../../state/actions'
import { loadApprovalDialog } from '../../shell/approval-load'

/**
 * Starts both loads and returns at once. A load that fails here would fail the press the same way (the browser keeps a
 * failed module), so it gets the app's usual handling now instead of then: a reload, or a note to save and reload
 * (lib/chunk-reload.ts).
 */
export function preloadPrinterControls(): void {
  void loadSendActions().catch(() => undefined)
  void loadApprovalDialog().catch(() => undefined)
}
