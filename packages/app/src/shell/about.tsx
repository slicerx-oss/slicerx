// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// About (with Diagnostics) and the shortcut list. Loaded when first opened: neither is part of first paint.
import { attribution } from '@slicerx/edition-config'
import { Button, Dialog, Eyebrow, Icon, Kbd, Logo, StatusLine, useToast } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useCommands } from '../commands/registry'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { formatShortcut } from '../lib/keys'
import { set, useApp } from '../state/store'
import { checkForUpdates, updaterRegistered } from '../updates/updates'

function Diagnostics() {
  const host = useHost()
  const plate = useApp((s) => s.plate)
  const backend = useApp((s) => s.viewportBackend)
  const slice = useApp((s) => s.slice)
  const tris = plate.reduce((n, p) => n + p.handle.triangles, 0)
  return (
    <details className="about-diag">
      <summary>Diagnostics</summary>
      <ul className="sx-mono sx-small">
        <li>{host.capabilities.nativeSlicing ? 'Engine: sx-core, native' : 'Engine: sx-core, WebAssembly'}</li>
        <li>{host.capabilities.threads} {host.kind === 'web' ? 'workers' : 'threads'}</li>
        <li>{backend || (host.capabilities.webgpu ? 'WebGPU' : 'WebGL2')}</li>
        {plate.length ? <li>Plate: {plate.length} {plate.length === 1 ? 'object' : 'objects'}, {tris.toLocaleString('en-US')} triangles</li> : null}
        {slice.status === 'done' ? <li>Last slice: {Math.round(slice.result.wallMs)} ms</li> : null}
      </ul>
    </details>
  )
}

export function AboutDialog() {
  const open = useApp((s) => s.aboutOpen)
  const host = useHost()
  const edition = useEdition()
  const credit = attribution(edition)
  const close = () => set({ aboutOpen: false })
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`About ${edition.brand.name}`}
      splitFooter={updaterRegistered()}
      footer={
        <>
          {updaterRegistered() ? (
            <Button
              variant="ghost"
              onClick={() => {
                close()
                void checkForUpdates({ manual: true })
              }}
            >
              Check for updates
            </Button>
          ) : null}
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      <div className="about">
        {/* An edition's own logo comes through the logo slot (SlicerXApp); SlicerX shows its lockup. */}
        <Logo size="lg" tagline={edition.id === 'slicerx'} />
        {edition.brand.tagline && edition.id !== 'slicerx' ? <p>{edition.brand.tagline}</p> : null}
        <p className="sx-mono sx-small">
          Version {host.build.version}, {host.kind === 'desktop' ? 'desktop' : 'browser'} build, commit {host.build.commit.slice(0, 12)}
        </p>
        <p>
          Free and open source. The source for exactly this build is at{' '}
          <a href={host.build.sourceUrl} target="_blank" rel="noreferrer">
            {host.build.sourceUrl.replace(/^https?:\/\//, '')}
          </a>
          .
        </p>
        {/* The credit every edition shows: always Made possible by SlicerX (TRADEMARK.md). */}
        <p className="sx-small" data-testid="about-attribution">
          <a href={credit.url} target="_blank" rel="noreferrer">{credit.text}</a>
        </p>
        {edition.legal.license ? <p className="sx-small">License: {edition.legal.license}.</p> : null}
        <p className="sx-small sx-dim" data-testid="about-step-reader">
          STEP files are read with occt-import-js and Open CASCADE Technology, both under the LGPL 2.1. This app makes use of facilities provided by the Open CASCADE Technology software. Their source, build script and license texts are in packages/vendor/occt-import-js of the source above.
        </p>
        <p className="sx-small sx-dim">Telemetry is off.</p>
        <Diagnostics />
        {edition.legal.trademarkNotice ? <p className="sx-small sx-dim">{edition.legal.trademarkNotice}</p> : null}
        {edition.legal.terms || edition.legal.privacy ? (
          <p className="sx-small">
            {edition.legal.terms ? <a href={edition.legal.terms} target="_blank" rel="noreferrer">Terms</a> : null}
            {edition.legal.terms && edition.legal.privacy ? ' and ' : null}
            {edition.legal.privacy ? <a href={edition.legal.privacy} target="_blank" rel="noreferrer">Privacy</a> : null}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

const FIXED: [string, string][] = [
  ['Mod+K', 'Open the command bar'],
  ['?', 'Show keyboard shortcuts'],
  ['Delete', 'Remove the selected object'],
  ['Esc', 'Close a dialog'],
]

export function ShortcutsDialog() {
  const open = useApp((s) => s.shortcutsOpen)
  const commands = useCommands()
  const close = () => set({ shortcutsOpen: false })
  const rows: [string, string][] = [...FIXED, ...commands.filter((c) => c.shortcut).map((c): [string, string] => [c.shortcut ?? '', c.title])]
  return (
    <Dialog open={open} onClose={close} title="Keyboard shortcuts" footer={<Button onClick={close}>Close</Button>}>
      <dl className="keys-list">
        {rows.map(([k, label]) => (
          <div key={k + label}>
            <dt>{label}</dt>
            <dd>
              <Kbd>{formatShortcut(k)}</Kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}
