// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The live camera player: a printer's stream in a dialog with fullscreen, a quality choice that can adapt
// to the network by itself, and the route it takes (direct on the LAN or through the relay). A printer
// with no live stream shows stills instead and says so.
import { Button, Dialog, Pill, Seg } from '@slicerx/ui'
import { useEffect, useRef, useState } from 'react'
import { set, useApp } from '../state/store'
import { adapt, initialAdapt } from './adaptive'
import { CameraIdle, CameraProblem, FirstLookCover, useFirstLook } from './idle'
import { QUALITIES, type Quality, type StreamStats } from './stream'
import { useCamera } from './use-camera'

type Choice = 'auto' | Quality

export function CameraPlayer() {
  const printer = useApp((s) => s.cameraPlayer)
  const stage = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const { session, error, still, status } = useCamera(printer)
  const [stats, setStats] = useState<StreamStats | null>(null)
  const [choice, setChoice] = useState<Choice>('auto')
  const choiceRef = useRef<Choice>('auto')
  choiceRef.current = choice

  // Auto quality follows what the connection manages.
  useEffect(() => {
    setStats(null)
    if (!session) return
    let state = initialAdapt(session.quality)
    return session.onStats((st) => {
      setStats(st)
      if (choiceRef.current !== 'auto') return
      state = adapt(state, st, session.supported)
      if (state.quality !== session.quality) void session.setQuality(state.quality)
    })
  }, [session])

  useEffect(() => {
    if (video.current) video.current.srcObject = session?.media ?? null
  }, [session])

  const pick = (c: Choice) => {
    setChoice(c)
    if (c !== 'auto') void session?.setQuality(c)
  }
  const look = useFirstLook(session?.mode === 'live' || Boolean(still), printer?.id ?? null, Boolean(printer), printer ? `player:${printer.id}` : undefined)
  const held = look === 'hold' || undefined
  const fullscreen = () => {
    const el = stage.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.().catch(() => undefined)
  }
  const close = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    set({ cameraPlayer: null })
  }
  return (
    <Dialog open={Boolean(printer)} onClose={close} size="lg" className="camera-dialog" title={printer ? `${printer.name} camera` : 'Camera'}>
      <div ref={stage} className="cam-stage">
        {session?.mode === 'snapshot' ? (
          still ? <img className="cam-video cam-reveal" data-held={held} src={still} alt={`Latest picture from ${printer?.name ?? 'the printer'}`} /> : error ? null : <CameraIdle connecting text="Waiting for a picture" size="lg" />
        ) : (
          <video ref={video} className="cam-video cam-reveal" data-held={held} autoPlay muted playsInline aria-label={`Live view of ${printer?.name ?? 'the printer'}`} />
        )}
        <CameraProblem status={status} error={error} />
        {!session && !error ? <CameraIdle connecting text="Connecting to the camera" size="lg" /> : null}
        {session && !error && (session.mode === 'live' || still) ? <FirstLookCover look={look} size="lg" /> : null}
        <div className="cam-bar">
          {session ? <Pill state={session.mode === 'live' ? 'ok' : 'warn'}>{session.mode === 'live' ? 'Live' : 'Stills'}</Pill> : null}
          {session ? <span className="sx-mono sx-small">{session.route === 'lan' ? 'Direct on your network' : 'Through the relay'}</span> : null}
          {stats ? <span className="sx-mono sx-small">{stats.fps} fps, {stats.latencyMs} ms, {stats.kbps} kbps</span> : null}
          <span className="cam-grow" />
          {session?.mode === 'live' ? (
            <Seg
              label="Quality"
              size="sm"
              value={choice}
              onChange={(v) => pick(v as Choice)}
              options={[{ value: 'auto', label: 'Auto' }, ...QUALITIES.filter((q) => session.supported.includes(q)).map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) }))]}
            />
          ) : null}
          <Button size="sm" variant="ghost" icon="fullscreen" aria-label="Fullscreen" onClick={fullscreen} />
        </div>
      </div>
      {session?.mode === 'live' && session.quality ? <p className="sx-small sx-muted">Showing {session.quality} quality{choice === 'auto' ? ', chosen for your connection' : ''}.</p> : null}
      {session?.mode === 'snapshot' ? <p className="sx-small sx-muted">This printer offers no live stream, so the view refreshes every 2 seconds.</p> : null}
    </Dialog>
  )
}
