// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether a step row's details may show the engine's own words and the call's command line. Those carry internal tool
// and field names, so the host turns them on only for a developer. Off where a host sets nothing.
import { createContext } from 'react'

/** True when an opened step row also shows the `$ source tool args` line and the raw refusal text. */
export const RawDetailsContext = createContext(false)
