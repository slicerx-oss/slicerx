// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The page side of the agent bridge, for dev and test builds only (docs/agent-bridge.md). The desktop entry imports this
// only when it was built with SLICERX_AGENT_BRIDGE=1, so other builds never carry it.
export { installCapture, redact, safeUrl, type Capture, type Entry, type LogKind } from './capture'
export { BridgeError, click, fill, pressKey, refusal, testids, waitFor } from './dom'
export { appState, createPageBridge, sliceSummary, type PageBridge } from './page'
