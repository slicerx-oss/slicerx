// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { assistantName, onAssistantBrand } from '@slicerx/contracts'
export { assistantBrand, assistantName, assistantText, setAssistantBrand, setAssistantName } from '@slicerx/contracts'

/** Live compatibility export for chat, cards, prompts and alerts. Only mimir is always lowercase. */
export let ASSISTANT_NAME = assistantName()
onAssistantBrand(() => { ASSISTANT_NAME = assistantName() })
