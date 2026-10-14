// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Hole: a plain hole in a block's top picked and refit for an M3 heat-set insert, wider with a counterbore.
import type { StageTool } from '@slicerx/ui'

export const loop: StageTool = {
  id: 'ho',
  badge: {cut: 0.9},
  readout: {rows: ["M3 free fit","M3 insert"],w: 86},
  css: ".sxs .ho-w{animation-name:ho-w}.sxs .ho-r{animation-name:ho-r}.sxs .ho-h{animation-name:ho-h;animation-timing-function:steps(1,end)}@keyframes ho-w{0%{transform:scale(1);animation-timing-function:cubic-bezier(.65,0,.35,1)}25.7%{transform:scale(1);animation-timing-function:cubic-bezier(.65,0,.35,1)}42.9%{transform:scale(1.6)}88.6%{transform:scale(1.6);animation-timing-function:cubic-bezier(.65,0,.35,1)}98.6%{transform:scale(1)}100%{transform:scale(1)}}@keyframes ho-r{0%{opacity:0}43.4%{opacity:0}45.7%{opacity:1}88.6%{opacity:1}97.1%{opacity:0}100%{opacity:0}}@keyframes ho-h{0%{translate:0 0px}34.3%{translate:0 -14px}100%{translate:0 -14px}}",
  body: "<polygon class=\"s-f2 s-ol\" points=\"75.5,110 142.2,148.5 142.2,113.5 75.5,75\"/><polygon class=\"s-f3 s-ol\" points=\"190.7,120.5 142.2,148.5 142.2,113.5 190.7,85.5\"/><polygon class=\"s-f1 s-ol\" points=\"124,47 190.7,85.5 142.2,113.5 75.5,75\"/><g class=\"ho-r s-a\"><ellipse class=\"s-af s-al\" cx=\"133.1\" cy=\"80.3\" rx=\"18\" ry=\"10.4\"/><ellipse class=\"s-g3 s-aol\" cx=\"133.1\" cy=\"83.4\" rx=\"13.3\" ry=\"7.7\" style=\"fill-opacity:.6\"/></g><g class=\"ho-w s-a\" style=\"transform-box:fill-box;transform-origin:center\"><clipPath id=\"ho-c\"><ellipse class=\"\" cx=\"133.1\" cy=\"80.3\" rx=\"6.9\" ry=\"4\"/></clipPath><ellipse class=\"s-f3\" cx=\"133.1\" cy=\"80.3\" rx=\"6.9\" ry=\"4\"/><g clip-path=\"url(#ho-c)\"><ellipse class=\"s-hole\" cx=\"133.1\" cy=\"82.5\" rx=\"6.9\" ry=\"4\"/></g><ellipse class=\"s-n s-ol\" cx=\"133.1\" cy=\"80.3\" rx=\"6.9\" ry=\"4\"/></g><circle class=\"sxs-rip s-a\" cx=\"147.1\" cy=\"87.3\" r=\"9\"/><use href=\"#sxs-ptr\" x=\"147.1\" y=\"87.3\"/><g class=\"s-hud s-a\"><use href=\"#sxs-hud-ho\" x=\"169.1\" y=\"109.3\"/><clipPath id=\"ho-hw\"><rect x=\"175.1\" y=\"101.3\" width=\"76\" height=\"16\"/></clipPath><g clip-path=\"url(#ho-hw)\"><g class=\"ho-h s-a\"><use href=\"#sxs-rows-ho\" x=\"169.1\" y=\"109.3\"/></g></g></g>",
}
