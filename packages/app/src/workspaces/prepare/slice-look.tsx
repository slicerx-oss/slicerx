// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How Slice shows the slice, since it slices as you edit: Toolpaths (the default) draws the sliced paths in place of
// the models, with the model under the pointer solid; Layer lines draws the layer height on the solid models; Solid
// is the models alone. The choice is remembered.
import { Seg } from '@slicerx/ui'
import { set, useApp } from '../../state/store'

export function SliceLookSwitch() {
  const look = useApp((s) => s.sliceLook)
  return (
    <div className="slice-look sx-overlay">
      <Seg
        size="sm"
        label="How the plate shows the slice"
        value={look}
        onChange={(v) => set({ sliceLook: v })}
        options={[
          { value: 'solid', label: 'Solid', title: 'Solid: the models alone' },
          { value: 'print', label: 'Layer lines', title: 'Layer lines: the models with their layer height drawn on them' },
          { value: 'toolpaths', label: 'Toolpaths', title: 'Toolpaths: the sliced paths in place of the models; the one under the pointer shows as the model' },
        ]}
      />
    </div>
  )
}
