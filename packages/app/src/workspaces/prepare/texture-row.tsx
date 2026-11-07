// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint from texture, in the paint panel: paints the selected object from the texture it was opened with (or files the
// person picks), after a look at what it would paint. Apply is one undo step.
import { Button } from '@slicerx/ui'
import { useEffect, useRef, useState } from 'react'
import type { Host } from '@slicerx/contracts'
import { useHost } from '../../host'
import { Swatch } from '../../parts'
import { useResolvedSlots } from '../../filament/use-slots'
import { applyTexturePlans, filamentColors, listSlots, objCompanions, paletteAllowed, planCurrent, planTexturePaint, rememberTexture, TEXTURE_FAILED, textureSourceOf, type TextureMode, type TexturePlan, type TextureSource } from '../../plate/texture-paint'
import { history } from '../../plate/history'
import { get, type PlateEntry } from '../../state/store'

type State = { busy: true } | { plan: TexturePlan; mode: TextureMode } | { note: string } | null

/** The files picked for a texture, a note saying what is missing, or null when nothing was picked. */
export async function pickTexture(host: Host): Promise<TextureSource | { note: string } | null> {
  const refs = await host.files.open({ accept: ['.obj', '.mtl', '.png', '.jpg', '.jpeg', '.3mf'], multiple: true })
  const model = refs.find((r) => /\.(obj|3mf)$/i.test(r.name))
  if (!model) return null
  const data = new Uint8Array(await host.files.read(model))
  if (/\.3mf$/i.test(model.name)) return { kind: '3mf', name: model.name, data }
  const files: Record<string, Uint8Array> = {}
  for (const r of refs) if (r !== model) files[r.name] = new Uint8Array(await host.files.read(r))
  const { missing } = objCompanions(data, files)
  if (missing.length) return { note: `Pick ${missing.join(', ')} together with ${model.name}.` }
  return { kind: 'obj', name: model.name, obj: data, files }
}

const sameColors = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c.toLowerCase() === b[i]?.toLowerCase())

export function TextureRow({ entry }: { entry: PlateEntry | undefined }) {
  const host = useHost()
  const slots = useResolvedSlots()
  const [state, setState] = useState<State>(null)
  // each run takes a number; one that ends after the selection changed or a newer run started shows nothing
  const runs = useRef(0)
  useEffect(() => {
    runs.current += 1
    setState(null)
  }, [entry?.id])

  async function run(mode: TextureMode) {
    if (!entry) return
    const token = ++runs.current
    const say = (s: State) => {
      if (runs.current === token) setState(s)
    }
    setState({ busy: true })
    try {
      const picked = textureSourceOf(entry.id) ?? (await pickTexture(host))
      if (!picked) return say(null)
      if ('note' in picked) return say({ note: picked.note })
      const filaments = filamentColors()
      if (filaments.length < 2 && mode === 'nearest') return say({ note: 'Set up two or more filaments to paint from a texture.' })
      const plan = await planTexturePaint(entry, picked, mode, mode === 'palette' ? filaments.map(() => '#808080') : filaments)
      if (runs.current !== token) return
      if (!plan.reply.textured) return say({ note: plan.reply.notes.join(' ') || `${picked.name} has no texture on this object.` })
      rememberTexture(entry.id, picked)
      say({ plan, mode })
    } catch (e) {
      console.warn('paint from texture', e)
      say({ note: TEXTURE_FAILED })
    }
  }

  function apply(plan: TexturePlan, mode: TextureMode) {
    // a preview made for another object, for filaments that changed since, or before an edit, is not applied
    if (plan.objectId !== entry?.id) return setState(null)
    if (mode === 'nearest' && !sameColors(plan.filaments, filamentColors())) return setState({ note: 'The filaments changed since this preview. Press From texture again.' })
    // its edits were made against the object as it was: any edit since (a stroke, an Undo, a repair) or another plate
    if (plan.revision !== history().state().revision || plan.plate !== get().activePlate || !planCurrent(plan)) return setState({ note: 'The object changed since this preview. Press From texture again.' })
    applyTexturePlans([plan], mode === 'palette' ? plan.reply.palette : undefined)
    setState(null)
  }

  const plan = state && 'plan' in state ? state : null
  const colors = plan?.plan.reply.colors ?? []
  const colorOf = (slot: number) => (plan?.mode === 'palette' ? plan.plan.reply.palette[slot - 1] : slots[slot - 1]?.color) ?? '#808080'
  return (
    <div className="paint-texture">
      <div className="paint-act">
        <Button size="sm" variant="ghost" data-testid="paint-from-texture" disabled={!entry || (state !== null && 'busy' in state)} onClick={() => void run('nearest')}>
          From texture
        </Button>
      </div>
      {plan ? (
        <div className="paint-texture-preview" role="status" data-testid="paint-texture-preview">
          <p className="sx-small">
            Paints {colors.length} {colors.length === 1 ? 'color' : 'colors'} to {colors.length === 1 ? 'filament' : 'filaments'} {listSlots(colors)}
            {plan.mode === 'palette' ? ', with filament colors picked from the texture' : ''}.
          </p>
          <div className="paint-slots">
            {plan.plan.reply.slots.map((s) => (
              <span key={s.slot} className="paint-slot paint-slot-area">
                <Swatch color={colorOf(s.slot)} />
                <span>{s.slot}</span>
                <span className="sx-muted">{Math.round(s.areaMm2)} mm²</span>
              </span>
            ))}
          </div>
          {plan.plan.reply.notes.length ? <p className="sx-small sx-muted">{plan.plan.reply.notes.join(' ')}</p> : null}
          <div className="paint-act">
            <Button size="sm" data-testid="paint-texture-apply" onClick={() => apply(plan.plan, plan.mode)}>
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setState(null)}>
              Cancel
            </Button>
          </div>
          {plan.mode === 'nearest' && paletteAllowed() ? (
            <Button size="sm" variant="ghost" data-testid="paint-texture-palette" onClick={() => void run('palette')}>
              Pick filament colors from the texture
            </Button>
          ) : null}
        </div>
      ) : null}
      {state && 'note' in state ? <p className="sx-small sx-muted">{state.note}</p> : null}
    </div>
  )
}
