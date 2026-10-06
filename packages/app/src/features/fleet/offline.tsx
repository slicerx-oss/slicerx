// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer that is not reachable: the ravens rest and breathe slowly over when it was last seen,
// with Try again to ask every printer for its status now.
import { Button, Input } from '@slicerx/ui'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { CameraIdle } from '../../camera/idle'
import { appName } from '../../edition'
import { useHost } from '../../host'
import { lastSeenAt } from '../../lib/last-seen'
import { toast } from '../../state/store'

/**
 * "Last seen 4 min ago" from the last time the printer reported in while reachable. Seconds ago means
 * the link just dropped; never seen on this computer says so.
 */
export function lastSeen(seenAt: string | undefined, now: number): string {
  const at = Date.parse(seenAt ?? '')
  if (!Number.isFinite(at)) return 'Not seen on this computer yet'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'Lost the connection'
  if (s < 3600) return `Last seen ${Math.round(s / 60)} min ago`
  if (s < 86_400) return `Last seen ${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86_400)
  return `Last seen ${d} ${d === 1 ? 'day' : 'days'} ago`
}

export function OfflineIdle({ printerId, now, size = 'sm' }: { printerId: string; now: number; size?: 'sm' | 'lg' }) {
  const qc = useQueryClient()
  const checking = useIsFetching({ queryKey: ['fleet'] }) > 0
  return (
    <CameraIdle
      breathe
      size={size}
      text={lastSeen(lastSeenAt(printerId), now)}
      detail="The printer is not reachable. Check that it is on and on the same network as this computer."
      showDetail={size === 'lg'}
      action={
        <Button size="sm" variant="ghost" icon="refresh" className="cam-idle-act" disabled={checking} onClick={() => void qc.invalidateQueries({ queryKey: ['fleet'] })}>
          {checking ? 'Checking' : 'Try again'}
        </Button>
      }
    />
  )
}

/**
 * A printer whose access code is no longer stored on this computer (the system keychain kept it only for an
 * earlier session): one plain ask for the code, saved under `codeRef` as setup saves it, then every printer is
 * asked for its status again. Not a failed connection: the printer was never asked.
 */
export function CodeNeeded({ codeRef, name, size = 'sm' }: { codeRef: string; name: string; size?: 'sm' | 'lg' }) {
  const host = useHost()
  const qc = useQueryClient()
  const id = useId()
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!code.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const kept = await host.secrets.set(codeRef, code.trim())
      if (kept && kept.kept === 'session') toast(`${appName()} could not store the access code in your system keychain, so it is kept only until ${appName()} closes. You will be asked for it again next time.`, 'warn')
      setCode('')
      await qc.invalidateQueries({ queryKey: ['fleet'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <CameraIdle
      size={size}
      text="Access code needed"
      detail={`${appName()} no longer has the access code for ${name}. Enter it to connect again.`}
      showDetail={size === 'lg'}
      action={
        <form
          className="cam-idle-act"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Input id={id} type="password" size="sm" autoComplete="off" aria-label={`Access code for ${name}`} placeholder="Access code" value={code} onChange={(e) => setCode(e.currentTarget.value)} />
          <Button size="sm" type="submit" disabled={!code.trim() || saving}>
            {saving ? 'Saving' : 'Save'}
          </Button>
          {error ? (
            <span className="app-err" role="alert">
              {error}
            </span>
          ) : null}
        </form>
      }
    />
  )
}
