// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Icons added for the Model tab: the tool shelf, the model tree and the inspector. Same contract as icons/extra.mjs: a
// 24px grid, drawn for stroke 1.75 with round caps and joins, no fill except tiny dots, currentColor. Their 16px
// versions go in icons/small.mjs.


// dashed: each shape carries its own dash, as the set draws no groups
const dash = (inner, d = '2 2.2') => inner.replace(/<(path|rect|circle|ellipse)\b/g, `<$1 stroke-dasharray="${d}"`)
const DOT = (x, y, r = 1.5) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`

// the isometric cube of the view icons, and its hidden diagonals for a mesh
const CUBE = '<path d="M12 3l7.5 4.25v9L12 20.5l-7.5-4.25v-9z"/><path d="M4.5 7.25L12 11.5l7.5-4.25M12 11.5v9"/>'
// a pointer, tip at (x, y)
const POINTER = (x, y) => `<path d="M${x} ${y}l7.5 3-3 1.25-1.25 3z"/>`

export const MODEL_ICONS = {
  // the Model tab: a part with a hole and one rounded edge
  model: '<path d="M4 20.5V11a7.5 7.5 0 0 1 7.5-7.5h9v17z"/><circle cx="14" cy="13.5" r="2.5"/>',
  // a pencil drawing on a plane
  sketch: '<path d="M2.5 20.5l4.5-4h14.5l-4.5 4z"/><path d="M15 3.5l3.5 3.5-7.5 7.5H7.5V11z"/><path d="M12.75 5.75l3.5 3.5"/>',
  // a profile on a plane, pushed up
  extrude: '<path d="M3 19.5l4-3.5h14l-4 3.5z"/><path d="M12 13V4M9 7l3-3 3 3"/>' + dash('<path d="M3 19.5V13M17 19.5V13"/>'),
  // a profile turned about its axis, the far side ghosted
  revolve: dash('<path d="M12 2.5v19"/>', '1.5 2.2') + '<path d="M12 5.5h4l2.5 3.5v6L16 18.5h-4"/>' + dash('<path d="M12 5.5H8L5.5 9v6L8 18.5h4"/>'),
  // a body: a solid with a history, the clock at its corner
  body: '<path d="M9.5 3l6 3.4v4.1M9.5 17l-6-3.4V6.4L9.5 3"/><path d="M3.5 6.4l6 3.4 6-3.4M9.5 9.8V17"/><circle cx="17" cy="17" r="4"/><path d="M17 15v2l1.25 1"/>',
  // a mesh: the cube with its faces split into triangles
  'mesh-object': CUBE + '<path d="M12 3v8.5M4.5 7.25 12 20.5M19.5 7.25 12 20.5"/>',
  // a part of an object: a block with a corner taken out
  part: '<path d="M3.5 4.5h17v15h-9v-6h-8z"/>',
  // a modifier volume: a dashed cube
  modifier: dash(CUBE),
  // the box primitive, wider than it is tall
  'box-shape': '<path d="M12 5l8.5 4v7.5L12 20.5l-8.5-4V9z"/><path d="M3.5 9 12 13l8.5-4M12 13v7.5"/>',
  // copies in a row
  'array-linear': '<rect x="2.5" y="9.5" width="5" height="5" rx="1"/>' + dash('<rect x="9.5" y="9.5" width="5" height="5" rx="1"/><rect x="16.5" y="9.5" width="5" height="5" rx="1"/>', '1.6 1.8'),
  // copies around a center
  'array-polar': '<rect x="10" y="6" width="4" height="4" rx="1"/>' + dash('<rect x="2.5" y="11.25" width="4" height="4" rx="1"/><rect x="17.5" y="11.25" width="4" height="4" rx="1"/>', '1.4 1.6') + DOT(12, 17.5),
  // a mesh with a missing face
  'repair-mesh': '<path d="M3.5 19 12 4.5 20.5 19z"/>' + dash('<path d="M7.8 11.8h8.4L12 19z"/>'),
  // the mesh tools: a fan of triangles
  'mesh-menu': '<path d="M12 3.5l7.36 4.25v8.5L12 20.5l-7.36-4.25v-8.5z"/><path d="M12 3.5v17M4.64 7.75l14.72 8.5M19.36 7.75 4.64 16.25"/>',
  // pick whole objects
  'select-object': '<rect x="3.5" y="3.5" width="11" height="11" rx="2"/>' + POINTER(12.5, 12.5),
  // pick faces: one face of a block, marked
  'select-face': '<path d="M3.5 14.5 7 4h10l-3.5 10.5z"/>' + DOT(10.25, 9.25) + POINTER(12.5, 12.5),
  // pick edges: one edge drawn heavy
  'select-edge': '<path d="M3.5 14.5V5.5a2 2 0 0 1 2-2h9"/><path d="M3.5 14.5V5.5" stroke-width="3"/>' + POINTER(12.5, 12.5),
  // drag a box to pick
  'box-select': dash('<rect x="3.5" y="3.5" width="13" height="11" rx="1.5"/>') + POINTER(13.5, 12.5),
  // the rollback marker: the history up to here, the rest waiting
  'roll-to-here': '<path d="M15.5 3.5v17"/><path d="M3.5 12h8.5M9 9l3 3-3 3"/><path d="M19.5 7v.01M19.5 12v.01M19.5 17v.01"/>',
  // a broken step: a badge, not an icon of its own
  'step-broken': DOT(12, 12, 4.5),
}

export const MODEL_ICON_GROUPS = {
  Model: ['model', 'body', 'mesh-object', 'part', 'modifier', 'box-shape'],
  Steps: ['sketch', 'extrude', 'revolve', 'array-linear', 'array-polar', 'repair-mesh', 'mesh-menu', 'step-broken'],
  Picking: ['select-object', 'select-face', 'select-edge', 'box-select', 'roll-to-here'],
}
