// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition with its own knowledge folder, for test/brain-pack.test.ts.
import { defineEditionConfig } from '../../../../../edition-config/src/index.ts'

export default defineEditionConfig({
  id: 'harbor',
  brand: { logo: { appIcon: 'brand/harbor-icon.png' } },
  legal: { sourceUrl: 'https://git.harborprint.example/harbor-slice/tree/{commit}' },
  ai: { brain: { knowledge: ['knowledge'] } },
})
