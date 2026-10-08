// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Open as project" or "Import geometry only", for another slicer's project added to a plate that has objects.
import { Button, Dialog } from '@slicerx/ui'
import { answerOpenProject } from './open-ask'
import { useApp } from '../state/store'

export function ProjectOpenDialog() {
  const ask = useApp((s) => s.projectOpenAsk)
  return (
    <Dialog
      open={ask !== null}
      onClose={() => answerOpenProject(null)}
      title="Open this project?"
      testId="project-open-dialog"
      splitFooter
      footer={
        <>
          <Button variant="ghost" data-testid="project-open-geometry-only" onClick={() => answerOpenProject('geometry')}>
            Import geometry only
          </Button>
          <Button variant="primary" autoFocus data-testid="project-open-as-project" onClick={() => answerOpenProject('project')}>
            Open as project
          </Button>
        </>
      }
    >
      {ask ? (
        <p>
          {ask.source} is a project with its own printer and settings. Open it as the project in place of this plate, or add only its objects to the plate with your current printer and settings.
        </p>
      ) : null}
    </Dialog>
  )
}
