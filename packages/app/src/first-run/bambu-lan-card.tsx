// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Lab card on the printer screen: LAN Only Mode and Developer Mode, where they are on each
// model family's screen, and what they change. Shown before anyone types an access code.
import { Icon, Seg } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { BAMBU_GUIDES, bambuGuide, DEVELOPER_EFFECT, LAN_ONLY_EFFECT, type BambuFamily } from './bambu-lan'

export function BambuLanCard({ family, lanOnly, open: wantOpen = false }: { family: BambuFamily | null; lanOnly?: boolean | undefined; open?: boolean }) {
  const [tab, setTab] = useState<BambuFamily>(family ?? 'x1')
  const [open, setOpen] = useState(wantOpen || lanOnly === false)
  const [more, setMore] = useState(false)
  useEffect(() => {
    if (family) setTab(family)
  }, [family])
  // Opens when it starts to matter (a Bambu Lab printer picked, or one in cloud mode) and folds once
  // the connection works; in between the person's own toggle stands.
  useEffect(() => {
    setOpen(wantOpen || lanOnly === false)
  }, [wantOpen, lanOnly])
  const g = bambuGuide(tab)
  return (
    <details className="fr-bambu" open={open} data-warn={lanOnly === false ? true : undefined} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="wifi" size={16} />
        <span>Bambu Lab printers: turn on LAN Only Mode and Developer Mode first</span>
        <Icon name="chevron-down" size={16} className="fr-bambu-chev" />
      </summary>
      <div className="fr-bambu-body">
        {lanOnly === false ? (
          <p className="fr-bambu-warn" role="status">
            <Icon name="warning" size={16} />
            This printer says LAN Only Mode is off. Turn it on, then enter the access code it shows.
          </p>
        ) : null}
        <Seg label="Printer family" size="sm" value={tab} onChange={(v) => setTab(v)} options={BAMBU_GUIDES.map((x) => ({ value: x.family, label: x.label }))} />
        <span className="fr-bambu-models">{g.models}</span>
        <ol>
          <li>{g.lanOnly}</li>
          <li>{g.developer}</li>
          <li>{g.accessCode}</li>
        </ol>
        <p>
          LAN Only Mode takes the printer off Bambu Cloud, so Bambu Handy stops working. Printing from this computer on your home network keeps working.{' '}
          {/* A click or a key opens the details in place: a hover tooltip does nothing on touch or in the desktop shell's links. */}
          <button type="button" className="fr-codecard-more" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? 'Less' : 'More'}
          </button>
        </p>
        {more ? (
          <p>
            {LAN_ONLY_EFFECT} {DEVELOPER_EFFECT}
          </p>
        ) : null}
      </div>
    </details>
  )
}
