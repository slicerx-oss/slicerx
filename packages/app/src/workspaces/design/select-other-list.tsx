// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Select Other's list and tag in Model's view (plate/select-other.ts). The list opens where a press or a finger held
// still, or at the pointer with Alt+S: what a click picks first, then the faces behind, then the bodies, each a plain
// name with the object it is on. A row under the pointer or keyboard focus shows what it would pick; choosing it picks
// it. Arrow keys move, Enter picks, Escape closes and gives focus back to the view. A finger's list has 44 px rows and
// ends with More actions, the ring a held finger opened before. The tag beside the pointer after a click says which
// of how many things under that spot is picked; clicking the same spot again steps to the next.
import { ContextMenu, MenuHeading, MenuItem, MenuSeparator, focusGoesBack, type IconName } from '@slicerx/ui'
import { useStore } from 'zustand'
import { applyCandidate } from '../../plate/select-other-pick'
import { candidateWords, closeOtherList, otherView, selectOther, type OtherCandidate, type OtherKind } from '../../plate/select-other'

/** The tag's widest, px (its CSS max-width), so it stays inside the window. */
const TAG_MAX = 280

const ICON: Readonly<Record<OtherKind, IconName>> = { face: 'select-face', edge: 'select-edge', body: 'select-object' }

function close(): void {
  closeOtherList()
  // back to the view, unless the person has gone on to another control
  requestAnimationFrame(() => {
    if (focusGoesBack(document.activeElement, document.body)) otherView()?.focus()
  })
}

export function SelectOtherList() {
  const open = useStore(selectOther, (s) => s.open)
  const tag = useStore(selectOther, (s) => s.tag)
  const hover = (c: OtherCandidate | null) => selectOther.setState({ hover: c })
  const leave = (c: OtherCandidate) => {
    if (selectOther.getState().hover === c) hover(null)
  }
  return (
    <>
      <ContextMenu at={open?.at ?? null} onClose={close} label="Select other" testId="select-other" className={open?.touch ? 'so-list so-touch' : 'so-list'} target={open?.touch ? 'touch' : 'pointer'}>
        <MenuHeading>Select other</MenuHeading>
        {open?.list.map((c, i) => (
          <MenuItem
            key={`${c.kind}:${c.objectId}:${c.partIndex}:${c.patch ?? c.triangle}:${i}`}
            icon={ICON[c.kind]}
            aside={c.object}
            aria-label={candidateWords(c)}
            data-testid="select-other-row"
            data-kind={c.kind}
            data-index={i}
            onPointerEnter={() => hover(c)}
            onPointerLeave={() => leave(c)}
            onFocus={() => hover(c)}
            onBlur={() => leave(c)}
            onClick={() => {
              applyCandidate(c)
              close()
            }}
          >
            {c.label}
          </MenuItem>
        ))}
        {open?.touch ? (
          <>
            <MenuSeparator />
            <MenuItem
              icon="more"
              data-testid="select-other-more"
              onClick={() => {
                const at = open.at
                closeOtherList()
                otherView()?.ring([at.x, at.y])
              }}
            >
              More actions
            </MenuItem>
          </>
        ) : null}
      </ContextMenu>
      {tag && !open ? (
        <div className="so-tag sx-overlay" data-testid="select-other-tag" role="status" style={{ left: Math.max(16, Math.min(tag.at.x + 16, window.innerWidth - 16 - TAG_MAX)), top: Math.max(16, Math.min(tag.at.y + 16, window.innerHeight - 60)) }}>
          <span>{tag.label}</span>
          <span className="so-tag-count">
            {tag.index + 1} of {tag.count}
          </span>
        </div>
      ) : null}
    </>
  )
}
