// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The engine refuses a malformed model file with a short code ("<file>: refused <code> <object> <element> <value>",
// packages/core/src/threemf.rs and mesh.rs); this words it for people, with the file, object, element and value.

const REFUSED = /(\S+): refused (\S+) (\d+) (\d+) ?(.*)$/

function sentence(file: string, code: string, object: number, at: number, value: string): string | null {
  const obj = object > 0 ? `object ${object}` : 'a build item'
  switch (code) {
    case 'unit':
      return `${file}: the unit "${value}" is not one 3MF defines.`
    case 'extension':
      return `${file}: the file requires the 3MF extension ${value}, which SlicerX does not read.`
    case 'id':
      return `${file}: ${object > 0 ? `a component of object ${object}` : 'an object or build item'} has no usable id ("${value}").`
    case 'vertex':
      return `${file}: object ${object}, vertex ${at}: the coordinate "${value}" is not a number.`
    case 'triangle':
      return `${file}: object ${object}, triangle ${at}: "${value}" is not a vertex number.`
    case 'index':
      return `${file}: object ${object}, triangle ${at} names a vertex past its ${value} vertices.`
    case 'transform':
      return `${file}: ${obj}, the transform "${value}" is not 12 numbers.`
    case 'stl-empty':
      return `${file}: the STL has no triangles.`
    case 'stl-number':
      return `${file}: triangle ${at} of the STL has a coordinate that is not a number.`
    case 'stl-cut':
      return `${file}: the STL ends inside facet ${at}, with ${value} of its 3 vertices.`
    default:
      return null
  }
}

/** The engine's message with a coded refusal in words; any other message as it is. */
export function engineErrorText(message: string): string {
  const m = REFUSED.exec(message)
  if (!m) return message
  const [whole, file = '', code = '', object = '0', at = '0', value = ''] = m
  const text = sentence(file, code, Number(object), Number(at), value.trim())
  return text ? message.slice(0, m.index) + text + message.slice(m.index + whole.length) : message
}
