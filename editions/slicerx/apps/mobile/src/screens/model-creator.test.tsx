// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen } from '@testing-library/react-native'
import { LIBRARY } from './fixtures'
import { CreatorScreen, cleanLinks, safeLinkUrl } from './creator-screen'
import { ModelScreen, type ModelDetail } from './model-screen'

const model: ModelDetail = {
  id: 'l1',
  title: 'Harbor lantern',
  description: 'A lantern shell for a tea light.',
  creator: { name: 'Tidewell Studio', handle: 'tidewell' },
  tags: ['home', 'lamp'],
  format: 'sx3mf',
  version: '1.2',
  sizeLabel: '6.8 MB',
  profiles: [{ printer: 'Bambu X1C', detail: 'Standard, PLA, 2 h 10 min, 41 g' }],
  likes: 12,
}

describe('ModelScreen', () => {
  it('shows the model, its tested settings and sends it to a printer', async () => {
    const onSend = jest.fn()
    const onOpenCreator = jest.fn()
    await render(<ModelScreen model={model} loading={false} onBack={jest.fn()} onRetry={jest.fn()} onOpenCreator={onOpenCreator} onSend={onSend} />)
    expect(screen.getByText('A lantern shell for a tea light.')).toBeTruthy()
    expect(screen.getByText('Bambu X1C')).toBeTruthy()
    expect(screen.getByText('SX3MF  version 1.2  6.8 MB')).toBeTruthy()
    await fireEvent.press(screen.getByTestId('model-send'))
    expect(onSend).toHaveBeenCalled()
    await fireEvent.press(screen.getByTestId('model-creator'))
    expect(onOpenCreator).toHaveBeenCalledWith('tidewell')
    expect(screen.queryByText(/price|subscribe|tier|vault/i)).toBeNull()
  })

  it('retries a failed load and says when a model is gone', async () => {
    const onRetry = jest.fn()
    const view = await render(<ModelScreen model={null} loading={false} failed onBack={jest.fn()} onRetry={onRetry} onOpenCreator={jest.fn()} onSend={jest.fn()} />)
    await fireEvent.press(screen.getByTestId('model-retry'))
    expect(onRetry).toHaveBeenCalled()
    await view.rerender(<ModelScreen model={null} loading={false} onBack={jest.fn()} onRetry={onRetry} onOpenCreator={jest.fn()} onSend={jest.fn()} />)
    expect(screen.getByText('Model not found')).toBeTruthy()
  })
})

describe('creator links', () => {
  it('keeps only https addresses without credentials', () => {
    expect(safeLinkUrl('https://patreon.com/tidewell')).toBe('https://patreon.com/tidewell')
    expect(safeLinkUrl('http://example.com')).toBeNull()
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(safeLinkUrl('https://user:pw@example.com/')).toBeNull()
    expect(safeLinkUrl('slicerx://auth/callback')).toBeNull()
    expect(safeLinkUrl('not a url')).toBeNull()
  })

  it('names links by site when the creator gave no label', () => {
    expect(cleanLinks([{ url: 'https://www.patreon.com/tidewell' }, { url: 'https://makerworld.com/@tidewell' }, { label: 'Shop', url: 'https://tidewell.example/shop' }, { url: 'http://bad.example' }]).map((l) => l.label)).toEqual(['Patreon', 'MakerWorld', 'Shop'])
  })
})

describe('CreatorScreen', () => {
  it('shows links and models and opens them', async () => {
    const onOpenLink = jest.fn()
    const onOpenModel = jest.fn()
    await render(
      <CreatorScreen
        creator={{ name: 'Tidewell Studio', tagline: 'Coastal home decor', bio: 'Small studio.', followers: 1 }}
        links={[{ label: 'Patreon', url: 'https://patreon.com/tidewell' }]}
        models={LIBRARY}
        loading={false}
        onBack={jest.fn()}
        onRetry={jest.fn()}
        onOpenLink={onOpenLink}
        onOpenModel={onOpenModel}
      />,
    )
    expect(screen.getByText('1 follower')).toBeTruthy()
    await fireEvent.press(screen.getByTestId('link-Patreon'))
    expect(onOpenLink).toHaveBeenCalledWith('https://patreon.com/tidewell')
    await fireEvent.press(screen.getByTestId('entry-m2'))
    expect(onOpenModel).toHaveBeenCalledWith(expect.objectContaining({ slug: 'cable-clip-set' }))
  })

  it('hides the links section when there are none', async () => {
    await render(<CreatorScreen creator={{ name: 'A', followers: 0 }} links={[]} models={[]} loading={false} onBack={jest.fn()} onRetry={jest.fn()} onOpenLink={jest.fn()} onOpenModel={jest.fn()} />)
    expect(screen.queryByText('Find them elsewhere')).toBeNull()
    expect(screen.getByText('No models yet.')).toBeTruthy()
  })
})
