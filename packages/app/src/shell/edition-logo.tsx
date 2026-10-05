// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A white-label edition's logo and mark, from brand.logo in its config. SlicerX keeps its own.
import { logoImage, type EditionConfig } from '@slicerx/edition-config'
import { Icon } from '@slicerx/ui'
import type { ReactNode } from 'react'

/** The logo slot's content for an edition: its wordmark, or its mark beside its name. Undefined keeps the SlicerX logo. */
export function editionLogo(edition: EditionConfig): ReactNode | undefined {
  if (edition.id === 'slicerx') return undefined
  const wordmark = logoImage(edition, 'wordmark')
  return (
    <span className="sx-edition-logo">
      {wordmark ? (
        <img src={wordmark} alt={edition.brand.name} />
      ) : (
        <>
          <EditionMark edition={edition} />
          <span className="sx-brand-word">{edition.brand.name}</span>
        </>
      )}
    </span>
  )
}

/** The edition's mark: the X for SlicerX, the edition's own image, or nothing when it ships none. */
export function EditionMark({ edition, size }: { edition: EditionConfig; size?: number }) {
  if (edition.id === 'slicerx') return <Icon name="slicerx" size={size ?? 24} />
  const src = logoImage(edition, 'mark')
  return src ? <img className="sx-edition-mark" src={src} alt="" {...(size ? { width: size, height: size } : {})} /> : null
}
