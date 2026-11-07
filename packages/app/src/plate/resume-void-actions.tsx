// The two ways on from a resume plan that no longer matches its plate, shown wherever Print and Export say why they
// wait (the Prepare footer and the sliced plate in Preview), and the note on other plates that a plan is kept.
import { openResume } from './resume-state'
import { printEverythingAgain, resumeElsewhere } from './resume-tops'
import { useApp } from '../state/store'
import '../workspaces/prepare/estimate-footer.css'

/** Plan again (the resume dialog) or Print everything again (clears the plan). */
export function ResumeVoidActions() {
  return (
    <>
      {' '}
      <button type="button" className="est-show" data-testid="resume-plan-again" onClick={() => openResume()}>
        Plan again
      </button>{' '}
      <button type="button" className="est-show" data-testid="resume-print-everything" onClick={() => printEverythingAgain()}>
        Print everything again
      </button>
    </>
  )
}

/** On a plate other than the plan's, which prints in full: says which plate the plan is kept for. */
export function ResumeElsewhereNote() {
  const plate = useApp(resumeElsewhere)
  if (plate === null) return null
  return (
    <p className="app-note prose" data-testid="resume-elsewhere">
      A resume plan is kept for plate {plate}. This plate prints in full.
    </p>
  )
}
