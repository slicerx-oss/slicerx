// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads 3MF projects and big binary STLs off the main thread (project-scan.ts, stl-scan.ts): the file comes in
// transferred, the meshes go back as transferred typed arrays. It also writes the autosave's project file
// (threemf.ts): the project's mesh parts come in one message each, transferred, and its painted triangles a few
// thousand at a time, then the rest of the project with a gap for each, and the file goes back transferred.
import type { MeshPart } from '@slicerx/contracts'
import type { PaintData } from '../state/store'
import { scanFailure, scanProject, transferables } from './project-scan'
import { scanStl } from './stl-scan'
import type { ProjectInput } from './threemf'

/** Painted triangles of one layer of one part, some of them. */
interface PaintPiece {
  at: [number, number]
  part: string
  layer: string
  codes: Record<string, string>
}

type Message =
  | { id: number; data: ArrayBuffer }
  | { id: number; stl: ArrayBuffer }
  | { id: number; part: { at: [number, number, number]; part: MeshPart } }
  | { id: number; paint: PaintPiece }
  | { id: number; drop: true }
  | { id: number; write: ProjectInput }

/** What the page sent ahead of a project write: mesh parts by plate, object and part index, and painted triangles. */
interface Pieces {
  parts: Map<string, MeshPart>
  paint: PaintPiece[]
}

const pieces = new Map<number, Pieces>()

function piecesFor(id: number): Pieces {
  let p = pieces.get(id)
  if (!p) pieces.set(id, (p = { parts: new Map(), paint: [] }))
  return p
}

/** Fills the gaps the page left in the project with the pieces sent for them. */
function withPieces(input: ProjectInput, sent: Pieces | undefined): ProjectInput {
  for (const { at, part, layer, codes } of sent?.paint ?? []) {
    const paint = input.plates[at[0]]?.objects[at[1]]?.paint as PaintData | undefined
    const target = paint?.[Number(part)]?.[layer as keyof PaintData[number]]
    if (!target) throw new Error('Painted triangles of the project did not reach the writer.')
    Object.assign(target, codes)
  }
  input.plates.forEach((plate, i) =>
    plate.objects.forEach((object, j) => {
      const own = object.parts as (MeshPart | null)[]
      own.forEach((part, k) => {
        if (part) return
        const got = sent?.parts.get(`${i}/${j}/${k}`)
        if (!got) throw new Error('A part of the project did not reach the writer.')
        own[k] = got
      })
    }),
  )
  return input
}

self.onmessage = async (e: MessageEvent<Message>) => {
  const msg = e.data
  if ('part' in msg) return void piecesFor(msg.id).parts.set(msg.part.at.join('/'), msg.part.part)
  if ('paint' in msg) return void piecesFor(msg.id).paint.push(msg.paint)
  if ('drop' in msg) return void pieces.delete(msg.id)
  try {
    if ('write' in msg) {
      const sent = pieces.get(msg.id)
      pieces.delete(msg.id)
      // Loaded the first time a project is written, so reading files does not wait for the writer's code.
      const result = await (await import('./threemf')).writeProjectCompressed(withPieces(msg.write, sent))
      self.postMessage({ id: msg.id, result }, { transfer: [result.buffer] })
      return
    }
    if ('stl' in msg) {
      const result = scanStl(new Uint8Array(msg.stl))
      self.postMessage({ id: msg.id, result }, { transfer: result ? [result.positions.buffer, result.indices.buffer] : [] })
      return
    }
    const result = await scanProject(new Uint8Array(msg.data))
    self.postMessage({ id: msg.id, result }, { transfer: transferables(result) })
  } catch (err) {
    self.postMessage({ id: msg.id, ...scanFailure(err) })
  }
}
