// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one-time notice before the first chat on mimir cloud: what is sent to the cloud model provider, and that the
// edition keeps sessions to improve mimir unless the person turns that off (here or in Settings > mimir). It names the
// edition, so LayerMate's says LayerMate. A changed notice gets a new version and shows again.
import type { EditionConfig } from '@slicerx/edition-config'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { Button, SwitchRow } from '@slicerx/ui'
import { appName, useEdition } from '../edition'
import { pilotState, set, useApp, type AppState } from '../state/store'
import { useMimirCloudHost } from './cloud'
import { cloudReady } from './cloud-edition'
import { pilotModel } from './llm'
import './connect.css'

export const CLOUD_NOTICE_VERSION = 1

/** Whether mimir would answer on mimir cloud and the person has not read this notice yet. */
export function cloudNoticeDue(edition: EditionConfig, s: Pick<AppState, 'pilot' | 'setupPilotOff' | 'mimirNotice'>, cloud: boolean): boolean {
  if (s.mimirNotice === CLOUD_NOTICE_VERSION || pilotState(s) === 'off') return false
  return pilotModel(edition, s.pilot, cloud)?.provider === 'mimir-cloud'
}

export function useCloudNoticeDue(): boolean {
  const edition = useEdition()
  const cloud = cloudReady(edition, useMimirCloudHost())
  const pilot = useApp((s) => s.pilot)
  const setupPilotOff = useApp((s) => s.setupPilotOff)
  const mimirNotice = useApp((s) => s.mimirNotice)
  return cloudNoticeDue(edition, { pilot, setupPilotOff, mimirNotice }, cloud)
}

export function CloudNotice() {
  const share = useApp((s) => s.mimirShare)
  const app = appName()
  return (
    <section className="pc-notice" data-testid="mimir-cloud-notice" aria-labelledby="pc-notice-title">
      <h3 id="pc-notice-title">Before you start</h3>
      <p>
        {ASSISTANT_NAME} in {app} runs on a cloud model provider. What you send {ASSISTANT_NAME}, your messages, photos and the parts it works on, goes to
        the provider to get an answer.
      </p>
      <p>
        {app} keeps your {ASSISTANT_NAME} sessions for 180 days to improve {ASSISTANT_NAME}. You can turn that off here, or later in Settings, {ASSISTANT_NAME}.
      </p>
      <SwitchRow
        id="pc-notice-share"
        testId="mimir-notice-share"
        label={`Share my ${ASSISTANT_NAME} sessions to improve ${ASSISTANT_NAME}`}
        checked={share}
        onChange={(v) => set({ mimirShare: v })}
      />
      <div className="pc-act">
        <Button variant="primary" data-testid="mimir-notice-ok" onClick={() => set({ mimirNotice: CLOUD_NOTICE_VERSION })}>
          Start
        </Button>
      </div>
    </section>
  )
}
