// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import base from '../../../../editions/slicerx/edition.config.ts'
import { defineEditionConfig } from '../../../../packages/edition-config/src/index.ts'

export default defineEditionConfig({
  ...base,
  brand: {
    ...base.brand,
    assistant: {
      name: 'yourmate',
      icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#24b9af" stroke-width="1.75"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="m8 11 3 3 5-6"/></svg>')}`,
      accent: { light: '#006b65', dark: '#63e6d4' },
    },
  },
})
