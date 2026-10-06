// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A page of every primitive in a realistic state, for design review. Apps mount it on a
// dev-only route; the render test proves each component renders on the server.
import {
  AppBar,
  AppMark,
  Avatar,
  Block,
  Button,
  ButtonLink,
  Chip,
  CommandPalette,
  Eyebrow,
  Field,
  Frame,
  Icon,
  ICON_GROUPS,
  Input,
  Kbd,
  KeyValues,
  LinkButton,
  Logo,
  Menu,
  MenuAnchor,
  MenuHeading,
  MenuItem,
  MenuSeparator,
  Panel,
  Pill,
  Rail,
  Range,
  VectorField,
  SearchButton,
  Seg,
  Select,
  StatusLine,
  SwitchRow,
  Tabs,
  Textarea,
  ToastProvider,
  WORKSPACE_TABS,
} from './index'
import { MakerTile, MAKERS, type MakerSlug } from './components/maker-tile'
import { tipAttrs } from './components/tooltip'
import { ThemeProvider } from './theme-provider'
import type { Theme } from './theme'

const noop = () => undefined

export function Gallery({ palette = false, theme }: { palette?: boolean; theme?: Theme | undefined }) {
  const page = (
    <ToastProvider>
      <Frame
        bar={
          <AppBar right={<><SearchButton onClick={noop} /><span className="sx-online"><i className="sx-dot" /><span>4 of 5 printers online</span></span><Avatar initials="RV" /></>}>
            <Tabs tabs={WORKSPACE_TABS} active="prepare" />
          </AppBar>
        }
        status={<StatusLine items={['Engine: sx-core', '12 threads', 'GPU preview']} right="Concept mock. Names and numbers are examples." />}
      >
        <div className="g-body">
          <Rail
            side="left"
            label="Library"
            collapsed={false}
            onCollapsedChange={noop}
            items={[
              { id: 'all', label: 'All models', icon: 'grid', badge: 128, active: true },
              { id: 'recent', label: 'Recent', icon: 'time', badge: 12 },
              { id: 'vault', label: 'Vault files', icon: 'vault', badge: 9 },
              { id: 'plates', label: 'Plates', icon: 'prepare' },
            ]}
          >
            <div className="g-pad">
              <Eyebrow>Collections</Eyebrow>
              <p className="sx-dim sx-small">Drop a model here to add it.</p>
            </div>
          </Rail>
          <Rail side="left" label="Tools" collapsed onCollapsedChange={noop} items={[{ id: 'move', label: 'Move', icon: 'move', active: true }, { id: 'rotate', label: 'Rotate', icon: 'rotate' }, { id: 'scale', label: 'Scale', icon: 'scale' }, { id: 'cut', label: 'Cut', icon: 'cut', badge: 1 }]} />
          <div className="g-main">
            <section className="g-sec">
              <Eyebrow>Brand</Eyebrow>
              <div className="g-row">
                <Logo /> <Logo size="lg" /> <Logo size="xl" tagline /> <AppMark size={64} /> <AppMark size={32} /> <AppMark size={16} />
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Buttons</Eyebrow>
              <div className="g-row">
                <Button variant="primary" icon="slice">Slice plate</Button>
                <Button icon="send-to-printer">Print</Button>
                <Button variant="ghost" icon="more">More</Button>
                <Button variant="danger">Cancel print</Button>
                <Button size="sm" icon="plus">Add</Button>
                <Button size="sm" icon="filter" aria-label="Filter" />
                <Button icon="sliders" aria-label="Settings" pressed />
                <Button size="lg" variant="primary" icon="play">Start on Bay 1</Button>
                <Button disabled>Disabled</Button>
                <ButtonLink href="#" icon="download">Download</ButtonLink>
                <LinkButton expanded={false}>Show expert settings</LinkButton>
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Chips and pills</Eyebrow>
              <div className="g-row">
                <Chip>STL</Chip>
                <Chip tone="vault" icon="vault">Vault</Chip>
                <Chip tone="free" icon="download">Free</Chip>
                <Chip tone="purple" icon="pilot">mimir</Chip>
                <Chip tone="cyan" mono>0.20 mm</Chip>
                <Chip tone="orange" icon="alert">Overhangs</Chip>
                <Chip tone="red">Error</Chip>
                <Chip mono>v3</Chip>
                <Pill state="ok">Ready</Pill>
                <Pill state="run">Printing 62%</Pill>
                <Pill state="warn">Needs attention</Pill>
                <Pill state="bad">Error</Pill>
                <Pill state="off">Offline</Pill>
                <span><Kbd>Cmd</Kbd> <Kbd>K</Kbd></span>
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Inputs</Eyebrow>
              <div className="g-grid">
                <Field htmlFor="g-layer" label="Layer height" aside="0.20 mm">
                  <Input id="g-layer" type="number" defaultValue="0.20" step="0.04" unit="mm" />
                </Field>
                <Field htmlFor="g-nozzle" label="Nozzle temperature" hint="PLA prints well from 200 to 220 C">
                  <Input id="g-nozzle" type="number" defaultValue="215" unit="C" />
                </Field>
                <Field htmlFor="g-search" label="Search">
                  <Input id="g-search" icon="search" placeholder="Search models" />
                </Field>
                <Field htmlFor="g-name" label="File name" error="A file with this name exists">
                  <Input id="g-name" mono defaultValue="lamp-plate-1.3mf" aria-invalid="true" />
                </Field>
                <Field htmlFor="g-printer" label="Printer">
                  <Select id="g-printer" defaultValue="x1c">
                    <option value="x1c">Bay 1, Bambu Lab X1 Carbon</option>
                    <option value="p1s">Bay 2, Bambu Lab P1S</option>
                    <option value="mk4s">Bay 3, Prusa MK4S</option>
                  </Select>
                </Field>
                <Field htmlFor="g-notes" label="Notes">
                  <Textarea id="g-notes" placeholder="Anything mimir should know about this plate" />
                </Field>
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Segments and switches</Eyebrow>
              <div className="g-row">
                <Seg label="Quality" value="0.20" onChange={noop} mono options={[{ value: '0.12', label: '0.12' }, { value: '0.20', label: '0.20' }, { value: '0.28', label: '0.28' }]} />
                <Seg label="View" value="grid" onChange={noop} options={[{ value: 'grid', label: 'Grid', icon: 'grid' }, { value: 'list', label: 'List', icon: 'list' }]} />
                <Range id="g-range" label="Infill" value={15} min={0} max={100} unit="%" onChange={noop} ticks={['0', '50', '100']} />
                <Seg label="Mode" size="sm" value="easy" onChange={noop} options={[{ value: 'easy', label: 'Easy' }, { value: 'expert', label: 'Expert' }]} />
              </div>
              <div className="g-grid">
                <SwitchRow id="g-sw1" label="Supports" detail="Tree supports, 55 degree threshold" checked onChange={noop} />
                <SwitchRow id="g-sw2" label="Brim" checked={false} onChange={noop} />
                <SwitchRow id="g-sw3" label="Publish to members" tone="pink" checked onChange={noop} />
                <SwitchRow id="g-sw4" label="Printer online" tone="green" checked onChange={noop} disabled />
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Transform fields</Eyebrow>
              <div className="g-stack">
                <VectorField id="g-pos" label="Position" unit="mm" values={[165, 160, 0]} onCommit={noop} />
                <VectorField id="g-rot" label="Rotation" unit="°" digits={1} values={[0, 0, 90]} onCommit={noop} />
                <VectorField id="g-scale" label="Scale" unit="%" digits={1} min={0.1} values={[100, 100, 100]} onCommit={noop} />
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Menu</Eyebrow>
              <MenuAnchor>
                <Button icon="more" iconEnd="chevron-down">Plate actions</Button>
                <Menu open static label="Plate actions" onClose={noop}>
                  <MenuHeading>Plate 1</MenuHeading>
                  <MenuItem icon="arrange" aside="A">Arrange</MenuItem>
                  <MenuItem icon="orient" aside="O">Auto orient</MenuItem>
                  <MenuItem checked>Show overhangs</MenuItem>
                  <MenuItem checked={false}>Show seams</MenuItem>
                  <MenuSeparator />
                  <MenuItem icon="cut" disabled>Cut (select a part)</MenuItem>
                  <MenuItem tone="danger" icon="plus">Remove plate</MenuItem>
                </Menu>
              </MenuAnchor>
            </section>
            <section className="g-sec">
              <Eyebrow>Panel</Eyebrow>
              <div className="g-panelbox">
                <Panel edge="right">
                  <Block title="Estimate" aside="Plate 1">
                    <KeyValues items={[{ value: '2h 14m', label: 'time' }, { value: '38 g', label: 'PLA' }, { value: '508', label: 'layers' }]} />
                  </Block>
                  <Block id="g-blk" title="Supports" expanded onExpandedChange={noop}>
                    <p className="sx-small sx-muted">Tree supports on. 12 percent of the model needs them.</p>
                  </Block>
                  <Block id="g-blk2" title="Expert settings" expanded={false} onExpandedChange={noop} />
                </Panel>
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Printer makers</Eyebrow>
              <div className="g-icons">
                {(Object.keys(MAKERS) as MakerSlug[]).map((m) => (
                  <span key={m} className="g-icon" aria-label={MAKERS[m].name} {...tipAttrs({ title: MAKERS[m].name })}>
                    <MakerTile maker={m} size={22} />
                  </span>
                ))}
              </div>
            </section>
            <section className="g-sec">
              <Eyebrow>Icons ({Object.values(ICON_GROUPS).flat().length})</Eyebrow>
              {Object.entries(ICON_GROUPS).map(([g, names]) => (
                <div key={g} className="g-icons">
                  <span className="sx-dim sx-small g-icons-h">{g}</span>
                  {names.map((n) => (
                    <span key={n} className="g-icon" aria-label={n} {...tipAttrs({ title: n })}>
                      <Icon name={n} size={20} />
                    </span>
                  ))}
                </div>
              ))}
            </section>
          </div>
        </div>
      </Frame>
      <CommandPalette
        open={palette}
        onClose={noop}
        query="sli"
        onQueryChange={noop}
        onSelect={noop}
        footerRight={<><Icon name="pilot" size={13} /> Ask mimir</>}
        groups={[
          { title: 'Plate', items: [{ id: 'slice', label: 'Slice plate', icon: 'slice', hint: 'Prepare', keys: ['Cmd', 'R'] }, { id: 'slice-all', label: 'Slice all plates', icon: 'slice' }] },
          { title: 'Settings', items: [{ id: 'layer', label: 'Set layer height', icon: 'layer-height', hint: '0.20 mm' }] },
        ]}
      />
    </ToastProvider>
  )
  return theme ? <ThemeProvider theme={theme}>{page}</ThemeProvider> : page
}

export const GALLERY_CSS = `
.g-body{display:flex;min-height:100%}
.g-main{flex:1;min-width:0;padding:8px 24px 40px}
.g-sec{padding:20px 0;border-bottom:1px solid var(--line-soft)}
.g-sec .sx-eyebrow{margin-bottom:14px}
.g-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.g-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px 24px;margin-top:16px}
.g-stack{display:flex;flex-direction:column;gap:8px;max-width:360px}
.g-pad{padding:8px 14px}
.g-panelbox{max-width:300px;border:1px solid var(--line-soft);border-radius:var(--r-md);overflow:hidden}
.g-icons{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px}
.g-icons-h{width:90px}
.g-icon{width:32px;height:32px;display:grid;place-items:center;border-radius:7px;background:var(--ink-2);color:var(--muted)}
@media (max-width:900px){.g-body{flex-direction:column}.sx-rail{width:100%;border:0;border-bottom:1px solid var(--line-soft)}}
`
