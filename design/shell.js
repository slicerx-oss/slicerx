// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
/* Shared app shell. Call sxShell({active, handles, onTab, status}) once the page markup exists. */
const SX_TABS = [["prepare","Prepare"],["preview","Preview"],["feed","Feed"],["library","Library"],["fleet","Fleet"],["pilot","Pilot"]];
function sxIcon(name, cls){
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SX_ICONS[name] || '') + '</svg>';
}
let sxUid = 0;
function sxHydrate(root){
  root = root || document;
  root.querySelectorAll('[data-i]:not([data-done])').forEach(function(el){ el.insertAdjacentHTML('afterbegin', sxIcon(el.dataset.i)); el.dataset.done = '1'; });
  root.querySelectorAll('[data-mark]:not([data-done])').forEach(function(el){ el.innerHTML = sxMark('m' + (sxUid++)); el.dataset.done = '1'; });
}
let sxToastTimer;
function sxToast(msg){
  let t = document.querySelector('.sx-toast');
  if (!t){ t = document.createElement('div'); t.className = 'sx-toast'; t.setAttribute('role','status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(sxToastTimer); sxToastTimer = setTimeout(function(){ t.hidden = true; }, 2600);
}
function sxShell(o){
  o = o || {};
  const handles = o.handles || [o.active];
  const bar = document.getElementById('sx-bar');
  bar.innerHTML = '<div class="sx-brand" aria-label="SlicerX"><span class="sx-word" aria-hidden="true">Slicer</span><span class="sx-x" data-mark></span></div>'
    + '<nav class="sx-tabs" aria-label="Workspaces">' + SX_TABS.map(function(t){
        return '<button class="sx-tab" data-tab="' + t[0] + '" title="' + t[1] + '" aria-label="' + t[1] + '"' + (t[0] === o.active ? ' aria-current="page"' : '') + '>' + sxIcon(t[0]) + '<span>' + t[1] + '</span></button>';
      }).join('') + '</nav>'
    + '<div class="sx-right"><div class="sx-search" role="search">' + sxIcon('search') + '<span>Search models, settings, printers</span><kbd>⌘K</kbd></div>'
    + '<div class="sx-online"><i class="sx-dot"></i><span>4 of 5 printers online</span></div><div class="sx-avatar" title="Your account">RV</div></div>';
  sxHydrate(bar);
  bar.querySelectorAll('.sx-tab').forEach(function(b){
    b.addEventListener('click', function(){
      const k = b.dataset.tab;
      if (handles.indexOf(k) > -1){
        bar.querySelectorAll('.sx-tab').forEach(function(x){ x.removeAttribute('aria-current'); });
        b.setAttribute('aria-current','page');
        if (o.onTab) o.onTab(k);
      } else {
        sxToast(b.textContent + ' is a separate concept page.');
      }
    });
  });
  const st = document.getElementById('sx-status');
  if (st) st.innerHTML = (o.status || ['Engine: OrcaSlicer core + SlicerX job graph','12 threads','GPU preview']).map(function(s){ return '<span>' + s + '</span>'; }).join('') + '<span class="sx-note">Concept mock. Names and numbers are examples.</span>';
}
