// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// My models: models on this device (files opened here and the built-in
// examples). Catalogs from a store plug in as features.
import type { FileRef, MeshPart } from '@slicerx/contracts'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef, useState } from 'react'
import { Block, Button, Chip, Icon, Seg, type IconName } from '@slicerx/ui'
import { useHost } from '../../host'
import { LayerArt, Silhouette, Swatch } from '../../parts'
import { DEMO_MODELS } from '../../lib/demo-models'
import { fuzzyScore } from '../../commands/fuzzy'
import { addFileRefs, loadDemoModel, openModelFiles } from '../../state/actions'
import { setWorkspace } from '../../state/store'
import { newProject } from '../../project/new'
import { useTabLabel } from '../../first-run/look'
import { SidePane, type PaneSection } from '../../shell/pane'
import { appName } from '../../edition'

interface Item {
  id: string
  title: string
  creator: string
  thumb: string | null
  slug: string | null
  file: FileRef | null
  source: 'example' | 'file'
  bboxMm?: [number, number, number]
  triangles?: number
  parts?: MeshPart[]
  colors: string[]
  version: string
  sizeBytes?: number
}

type Folder = 'all' | 'files' | 'examples'

const FOLDERS: { id: Folder; label: string; icon: IconName }[] = [
  { id: 'all', label: 'All models', icon: 'library' },
  { id: 'files', label: 'Recent files', icon: 'folder' },
  { id: 'examples', label: 'Examples', icon: 'prepare' },
]

const LEFT: PaneSection[] = FOLDERS.map((f) => ({ id: f.id, icon: f.icon, label: f.label }))
const RIGHT: PaneSection[] = [{ id: 'detail', icon: 'more', label: 'Details' }]

function useItems(): Item[] {
  const host = useHost()
  const recent = useQuery({ queryKey: ['recent-files'], queryFn: () => host.files.recent(), staleTime: 5_000 })
  // The hook, clip and bracket load their meshes on demand, so the examples arrive a moment after the files.
  const built = useQuery({ queryKey: ['example-models'], queryFn: () => Promise.all(DEMO_MODELS.map(async (m) => ({ m, ...(await m.build()) }))), staleTime: Infinity })
  return useMemo(() => {
    const examples: Item[] = (built.data ?? []).map(({ m, parts, colors }) => {
      return {
        id: `example-${m.slug}`,
        title: m.name,
        creator: m.note,
        thumb: null,
        slug: m.slug,
        file: null,
        source: 'example' as const,
        triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0),
        parts,
        colors,
        version: 'example',
      }
    })
    const files: Item[] = (recent.data ?? []).map((f) => ({
      id: `file-${f.id}`,
      title: f.name.replace(/\.[^.]+$/, ''),
      creator: f.name.split('.').pop()?.toUpperCase() ?? 'File',
      thumb: null,
      slug: null,
      file: f,
      source: 'file' as const,
      colors: [],
      version: 'file',
      sizeBytes: f.size,
    }))
    return [...files, ...examples]
  }, [recent.data, built.data])
}

export function Library() {
  const host = useHost()
  const all = useItems()
  const [folder, setFolder] = useState<Folder>('all')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [selected, setSelected] = useState<string | null>(null)
  const items = useMemo(() => {
    const q = query.trim()
    const inFolder = all.filter((i) => folder === 'all' || (folder === 'files' && i.source === 'file') || (folder === 'examples' && i.source === 'example'))
    if (!q) return inFolder
    return inFolder
      .map((i) => ({ i, s: Math.max(fuzzyScore(q, i.title), fuzzyScore(q, i.creator) - 20) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.i)
  }, [all, folder, query])
  const sel = items.find((i) => i.id === selected) ?? items[0] ?? null
  const counts: Record<Folder, number> = {
    all: all.length,
    files: all.filter((i) => i.source === 'file').length,
    examples: all.filter((i) => i.source === 'example').length,
  }

  return (
    <div className="three library">
      <SidePane side="left" ws="library" label="Folders" sections={LEFT}>
        <Block>
          <ul className="folders" aria-label="Folders">
            {FOLDERS.map((f) => (
              <li key={f.id} data-section={f.id}>
                <button type="button" aria-current={folder === f.id ? 'true' : undefined} onClick={() => setFolder(f.id)}>
                  <Icon name={f.icon} />
                  <span>{f.label}</span>
                  <span className="sx-mono dim">{counts[f.id]}</span>
                </button>
              </li>
            ))}
          </ul>
        </Block>
        <Block title="Storage" aside="on this device">
          <p className="sx-muted sx-small">Models you open stay on this device. {appName()} never uploads them.</p>
        </Block>
      </SidePane>

      <section className="lib-main" aria-label="Models">
        <div className="lib-bar">
          <div className="search-in grow">
            <Icon name="search" />
            <label className="sr-only" htmlFor="library-search">
              Search my models
            </label>
            <input id="library-search" className="bare" placeholder="Search by name or creator" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
          </div>
          <Seg
            label="Layout"
            value={view}
            options={[
              { value: 'grid', label: '', icon: 'grid', title: 'Grid' },
              { value: 'list', label: '', icon: 'list', title: 'List' },
            ]}
            onChange={setView}
          />
          <Button size="sm" icon="download" onClick={() => void openModelFiles(host)}>
            Import
          </Button>
        </div>
        <h1 className="lib-h sx-display">
          {FOLDERS.find((f) => f.id === folder)?.label} <span className="sx-mono dim">{items.length}</span>
        </h1>
        {view === 'grid' ? (
          <div className="grid lib-grid">
            {items.map((i) => (
              <button key={i.id} type="button" className="tile" aria-pressed={sel?.id === i.id} onClick={() => setSelected(i.id)} onDoubleClick={() => void openItem(host, i)}>
                <span className="tile-art">
                  {i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : i.parts ? <Silhouette parts={i.parts} /> : <LayerArt seed={i.id} muted />}
                </span>
                <span className="tile-t">{i.title}</span>
                {i.source === 'file' ? (
                  <Chip mono className="tile-ver">
                    {i.creator}
                  </Chip>
                ) : null}
                <span className="tile-m">
                  <span>{i.creator}</span>
                  {i.sizeBytes ? <span className="sx-mono">{(i.sizeBytes / 1e6).toFixed(1)} MB</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <ListView items={items} selected={sel?.id ?? null} onSelect={setSelected} />
        )}
        {items.length === 0 ? <p className="app-empty">No model matches "{query}".</p> : null}
      </section>

      <SidePane side="right" ws="library" label="Model details" sections={RIGHT}>
        {sel ? <Detail item={sel} /> : null}
      </SidePane>
    </div>
  )
}

/** Opening a model starts a new project, after asking about unsaved work. */
async function openItem(host: ReturnType<typeof useHost>, i: Item): Promise<void> {
  setWorkspace('prepare')
  if (i.slug) {
    if (await newProject()) await loadDemoModel(host, i.slug, { replace: true })
  } else if (i.file) await addFileRefs(host, [i.file], { fresh: true })
}

function ListView({ items, selected, onSelect }: { items: Item[]; selected: string | null; onSelect: (id: string) => void }) {
  const parent = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: items.length, getScrollElement: () => parent.current, estimateSize: () => 52, overscan: 8 })
  return (
    <div className="vlist" ref={parent} role="listbox" aria-label="Models">
      <div style={{ height: v.getTotalSize() }} className="vlist-in">
        {v.getVirtualItems().map((row) => {
          const i = items[row.index]
          if (!i) return null
          return (
            <div key={i.id} role="option" aria-selected={selected === i.id} className="lrow" style={{ transform: `translateY(${row.start}px)` }} onClick={() => onSelect(i.id)}>
              <span className="obj-thumb">{i.thumb ? <img src={i.thumb} alt="" loading="lazy" /> : null}</span>
              <b>{i.title}</b>
              <span className="sx-muted sx-small">{i.creator}</span>
              <span className="sx-mono dim small">{i.version}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Detail({ item }: { item: Item }) {
  const host = useHost()
  const tab = useTabLabel('prepare')
  return (
    <Block className="detail" data-section="detail">
      <div className="detail-art">{item.thumb ? <img src={item.thumb} alt={item.title} /> : item.parts ? <Silhouette parts={item.parts} /> : <LayerArt seed={item.id} layers={20} muted />}</div>
      <h2>{item.title}</h2>
      <p className="small">
        <span className="muted">{item.source === 'example' ? `Example model. ${item.creator}.` : `${item.creator} file on this device`}</span>
      </p>
      <div className="stack8">
        <Button variant="primary" size="lg" full icon="prepare" onClick={() => void openItem(host, item)}>
          Open in {tab}
        </Button>
      </div>
      <dl className="used">
        {item.bboxMm ? (
          <div>
            <dt>Bounding box</dt>
            <dd>{item.bboxMm.map((v) => v.toFixed(1)).join(' x ')} mm</dd>
          </div>
        ) : null}
        {item.triangles ? (
          <div>
            <dt>Triangles</dt>
            <dd>{item.triangles.toLocaleString('en-US')}</dd>
          </div>
        ) : null}
        {item.colors.length ? (
          <div>
            <dt>Colors</dt>
            <dd className="sw-row">
              {item.colors.map((c, i) => (
                <Swatch key={`${c}-${i}`} color={c} size="sm" />
              ))}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Version</dt>
          <dd>{item.version}</dd>
        </div>
      </dl>
    </Block>
  )
}
