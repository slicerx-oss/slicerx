// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A crash inside one workspace shows a message there and leaves the bar,
// the command bar and the other workspaces working. React only offers error
// boundaries as class components, hence the one class in the app.
import { noteViewClosing } from '../camera/closing'
import { Button, Icon } from '@slicerx/ui'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportCrash } from '../bugs/reports'

interface State {
  error: Error | null
}

export class WorkspaceBoundary extends Component<{ name: string; children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    // A camera view inside goes with it; its stream's close says why.
    noteViewClosing(`the view crashed: ${error.message.slice(0, 60)}`)
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.name} crashed`, error, info.componentStack)
    reportCrash(error, { where: `${this.props.name} stopped working`, ...(info.componentStack ? { componentStack: info.componentStack } : {}) })
  }

  override componentDidUpdate(prev: { name: string }): void {
    if (prev.name !== this.props.name && this.state.error) this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="ws-error" role="alert">
        <Icon name="alert" size={24} />
        <h2>{this.props.name} stopped working</h2>
        <p className="sx-mono sx-small">{error.message}</p>
        <Button onClick={() => this.setState({ error: null })}>Try again</Button>
      </div>
    )
  }
}
