// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The optional last setup screen: the shared mimir setup (pilot-connect/mimir-setup.tsx) under the screen's title, with
// Skip. A local model downloads in the background; setup never waits for it.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { MimirSetup, type MimirChoice } from '../pilot-connect/mimir-setup'

export { mimirChoices, mimirOnFinish, type MimirChoice } from '../pilot-connect/mimir-setup'

export function MimirStep({ choice, onChoose }: { choice: MimirChoice; onChoose(c: MimirChoice): void }) {
  return (
    <div className="fr-mimir">
      <header className="fr-head">
        <h1 className="fr-title fr-display">Set up {ASSISTANT_NAME}</h1>
        <p className="fr-lede">{ASSISTANT_NAME} answers questions and suggests changes you approve. Optional; you can connect it later.</p>
      </header>
      <MimirSetup place="setup" idPrefix="fr" choice={choice} onChoose={onChoose} />
    </div>
  )
}
