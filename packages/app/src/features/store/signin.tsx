// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Button } from '@slicerx/ui'
import { useEdition, useHost } from '@slicerx/app'
import type { ReactNode } from 'react'
import { openExternal, signInUrl } from './routes'

/** Shown where an action needs a session. Sign-in happens on the website; the studio picks the session up when you return. */
export function SignInNotice({ children }: { children: ReactNode }) {
  const host = useHost()
  const edition = useEdition()
  return (
    <div className="signin-note" role="status">
      <p className="sx-small">{children}</p>
      <Button size="sm" variant="primary" icon="creator" onClick={() => void openExternal(host, signInUrl(edition))}>
        Sign in
      </Button>
      <span className="sx-small sx-dim">Opens {host.kind === 'desktop' ? 'your browser' : 'a new tab'}.</span>
    </div>
  )
}
