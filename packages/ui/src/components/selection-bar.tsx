// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HTMLAttributes, ReactNode } from 'react'
import { Icon } from '../icons/icon'
import { tipAttrs } from './tooltip'

export interface SelectionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** What is selected, in words: "2 selected". */
  count: ReactNode
  /** Clears the selection; the bar's close button and Escape in the caller. */
  onClear: () => void
  clearLabel?: string
  /** A test id for the clear button. */
  clearTestId?: string
  /** The actions for the selection, buttons or menu anchors. */
  children?: ReactNode
}

/** A lifted bar over a list while something in it is selected: how many, what you can do with them, and a way out. */
export function SelectionBar({ count, onClear, clearLabel = 'Clear selection', clearTestId, className, children, ...rest }: SelectionBarProps) {
  return (
    <div role="toolbar" aria-label="Selection" className={className ? `sx-selbar sx-overlay ${className}` : 'sx-selbar sx-overlay'} {...rest}>
      <span className="sx-selbar-count" aria-live="polite">
        {count}
      </span>
      <span className="sx-selbar-actions">{children}</span>
      <button type="button" className="sx-selbar-clear" aria-label={clearLabel} {...(clearTestId ? { 'data-testid': clearTestId } : {})} {...tipAttrs({ title: clearLabel, key: 'Esc' })} onClick={onClear}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
