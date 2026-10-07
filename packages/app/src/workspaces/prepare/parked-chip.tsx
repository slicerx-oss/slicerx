// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A modeling tool left open in Design waits there (cad/park.ts); Slice says so on the viewport, with the way back
// and a way to drop it.
import { Button, Icon } from '@slicerx/ui'
import { set, setModelMode, useApp, type CadTool } from '../../state/store'
import { SHELF_TOOLS } from '../design/shelf-tools'

/** The tool's short name, as the shelf shows it. */
export function parkedLabel(tool: CadTool): string {
  const t = SHELF_TOOLS.find((x) => x.tool === tool)
  return t?.short ?? t?.label ?? 'A tool'
}

export function ParkedChip() {
  const tool = useApp((s) => s.parked?.tool ?? null)
  if (!tool) return null
  const label = parkedLabel(tool)
  const icon = SHELF_TOOLS.find((x) => x.tool === tool)?.icon ?? 'ruler'
  return (
    <div className="parked-chip sx-overlay" role="status" data-testid="parked-chip">
      <Icon name={icon} size={15} />
      <span>{label} in progress</span>
      <Button size="sm" variant="ghost" onClick={() => setModelMode('design')}>
        Back to Design
      </Button>
      <Button size="sm" variant="ghost" icon="close" aria-label={`Discard the ${label.replace(/^[A-Z][a-z]/, (m) => m.toLowerCase())} in progress`} data-tip-title="Discard" data-tip-body="Close the tool and drop what it had." onClick={() => set({ parked: null })} />
    </div>
  )
}
