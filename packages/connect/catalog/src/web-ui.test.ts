// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The link to a printer's own web page: where each connection and model serves it, and which hosts get one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ROOT_TLDS } from './root-tlds.ts'
import { CONNECTION_METHODS, PRINTER_MODELS, isLanHost, modelById, modelFor, printerWebUi, printerWebUiUrl, webUiUrl } from './index.ts'

const at = (plugin: string, host: string, extra: { port?: number; tunnel?: string } = {}) => ({ plugin, host, ...extra })

test('each connection that serves a page links to it on its default port', () => {
  assert.equal(printerWebUiUrl(at('moonraker', '192.168.1.20'), modelById('generic-klipper')), 'http://192.168.1.20/')
  assert.equal(printerWebUiUrl(at('moonraker', 'voron.local')), 'http://voron.local/')
  assert.equal(printerWebUiUrl(at('octoprint', '192.168.1.30')), 'http://192.168.1.30:5000/')
  assert.equal(printerWebUiUrl(at('prusalink', '10.0.0.7')), 'http://10.0.0.7/')
  assert.equal(printerWebUiUrl(at('duet', 'duet3.local')), 'http://duet3.local/')
})

test('connections with no page of their own get no link', () => {
  for (const plugin of ['bambu-lan', 'anycubic', 'elegoo', 'snapmaker', 'ultimaker', 'bambuddy', 'export', 'no-such-plugin']) {
    assert.equal(printerWebUiUrl(at(plugin, '192.168.1.40')), null, plugin)
  }
  assert.equal(printerWebUi({ ...at('bambu-lan', '192.168.1.40'), vendor: 'Bambu Lab', model: 'X1 Carbon' }), null)
})

test('a model whose page is on another port overrides the connection', () => {
  const qidi = { ...at('moonraker', '192.168.1.50'), vendor: 'QIDI', model: 'X-Max 3' }
  assert.equal(modelFor(qidi)?.id, 'qidi-x-max-3')
  assert.equal(printerWebUi(qidi), 'http://192.168.1.50:10088/')
  assert.equal(printerWebUi({ ...qidi, model: 'Q1 Pro' }), 'http://192.168.1.50:10088/')
  // A K2 serves Fluidd on 4408 on stock firmware, whichever connection reaches it.
  assert.equal(printerWebUi({ ...at('creality', '192.168.1.60'), vendor: 'Creality', model: 'K2 Plus' }), 'http://192.168.1.60:4408/')
  assert.equal(printerWebUi({ ...at('moonraker', '192.168.1.60'), vendor: 'Creality', model: 'K2 Plus' }), 'http://192.168.1.60:4408/')
  // A K1 has Fluidd only once Moonraker is installed with root: none on its stock connection.
  assert.equal(printerWebUi({ ...at('creality', '192.168.1.61'), vendor: 'Creality', model: 'K1 Max' }), null)
  assert.equal(printerWebUi({ ...at('moonraker', '192.168.1.61'), vendor: 'Creality', model: 'K1 Max' }), 'http://192.168.1.61:4408/')
  // The Creality entry behind OctoPrint is OctoPrint's page.
  assert.equal(printerWebUi({ ...at('octoprint', '192.168.1.62', { port: 80 }), vendor: 'Creality', model: 'Ender-3 with OctoPrint' }), 'http://192.168.1.62/')
})

test('a saved port moves a page served by the connection itself, not a Klipper page', () => {
  assert.equal(printerWebUiUrl(at('octoprint', 'octopi.local', { port: 80 })), 'http://octopi.local/')
  assert.equal(printerWebUiUrl(at('octoprint', '192.168.1.30', { port: 5001 })), 'http://192.168.1.30:5001/')
  assert.equal(printerWebUiUrl(at('prusalink', '192.168.1.31', { port: 8080 })), 'http://192.168.1.31:8080/')
  // The saved Moonraker port is the API's; Mainsail and Fluidd stay on their own.
  assert.equal(printerWebUiUrl(at('moonraker', '192.168.1.20', { port: 7125 })), 'http://192.168.1.20/')
  assert.equal(printerWebUi({ ...at('moonraker', '192.168.1.50', { port: 7125 }), vendor: 'QIDI', model: 'X-Max 3' }), 'http://192.168.1.50:10088/')
})

// The bridge's is_lan_host (sx-link, src/net.rs) runs the same table.
const HOSTS = JSON.parse(readFileSync(new URL('../../fixtures/lan-hosts.json', import.meta.url), 'utf8')) as { lan: string[]; notLan: string[]; webLink: { allowed: string[]; refused: string[] } }

test('the host rule is the bridge\'s, from the table both run', () => {
  for (const ok of HOSTS.lan) assert.ok(isLanHost(ok), ok)
  for (const bad of HOSTS.notLan) assert.ok(!isLanHost(bad), bad)
})

test('a host outside the local network never gets a link', () => {
  for (const host of HOSTS.notLan) {
    assert.equal(printerWebUiUrl(at('moonraker', host)), null, host)
    assert.equal(webUiUrl(host, 80), null, host)
  }
  // Names a browser reads as IPv4 numbers, and octal octets: 8.8.8.8, 127.0.0.1 and 8.0.0.1 there.
  for (const host of ['134744072', '0x08080808', '0x7f000001', '010.0.0.1', '172.016.0.1']) assert.equal(webUiUrl(host, 80), null, host)
  // Through a tunnel the host is the tunnel's, so there is no page on this network.
  assert.equal(printerWebUiUrl(at('octoprint', '192.168.1.30', { tunnel: 'obico' })), null)
  assert.equal(printerWebUiUrl({ plugin: 'moonraker' }), null)
})

test('a single label that is a root-zone TLD gets no link, and plain printer names do', () => {
  for (const ok of HOSTS.webLink.allowed) assert.ok(webUiUrl(ok, 80), ok)
  for (const bad of HOSTS.webLink.refused) {
    assert.ok(isLanHost(bad), `${bad} still connects`)
    assert.equal(webUiUrl(bad, 80), null, bad)
    assert.equal(printerWebUiUrl(at('octoprint', bad)), null, bad)
  }
  assert.equal(ROOT_TLDS.size > 1400, true)
})

test('the address is written as a browser writes it, so the open check matches it', () => {
  assert.equal(webUiUrl('VORON.LOCAL', 80), 'http://voron.local/')
  assert.equal(webUiUrl('voron.local.', 80), 'http://voron.local/')
  assert.equal(webUiUrl('fd00::5', 7125), 'http://[fd00::5]:7125/')
  assert.equal(webUiUrl('FD00:0:0::5', 80), 'http://[fd00::5]/')
  assert.equal(webUiUrl('fe80:0:0:0:0:0:0:1', 80), 'http://[fe80::1]/')
  assert.equal(webUiUrl('::1', 80), 'http://[::1]/')
  assert.equal(webUiUrl('fd00:1:0:1::1', 80), 'http://[fd00:1:0:1::1]/')
  for (const host of [...HOSTS.lan, 'Pi.Home.Arpa']) {
    const url = webUiUrl(host, 8080)
    assert.ok(url, host)
    assert.equal(new URL(url).href, url, host)
  }
})

test('a connection over TLS links its own page as https', () => {
  assert.equal(printerWebUiUrl({ plugin: 'prusalink', host: '192.168.1.31', port: 443, tls: true }), 'https://192.168.1.31/')
  assert.equal(printerWebUiUrl({ plugin: 'octoprint', host: 'octopi.local', port: 443, tls: true }), 'https://octopi.local/')
  // TLS on Moonraker is the API's; Mainsail and Fluidd stay on plain http.
  assert.equal(printerWebUiUrl({ plugin: 'moonraker', host: '192.168.1.20', tls: true }), 'http://192.168.1.20/')
})

test('a printer with no model name matches no model', () => {
  assert.equal(modelFor({ vendor: 'Creality', model: '' }), undefined)
  assert.equal(modelFor({ vendor: '', model: 'K2 Plus' }), undefined)
  assert.equal(printerWebUi({ ...at('moonraker', '192.168.1.60'), vendor: 'Creality', model: '' }), 'http://192.168.1.60/')
})

test('ports and paths are checked before a link is made', () => {
  assert.equal(webUiUrl('192.168.1.20', 0), null)
  assert.equal(webUiUrl('192.168.1.20', 70000), null)
  assert.equal(webUiUrl('192.168.1.20', 80, '//evil.example/'), null)
  assert.equal(webUiUrl('192.168.1.20', 80, 'x'), null)
  assert.equal(webUiUrl('192.168.1.20', 80, '/a?b'), null)
  assert.equal(webUiUrl('192.168.1.20', 80, '/fluidd/'), 'http://192.168.1.20/fluidd/')
})

test('every web page in the catalog is well formed', () => {
  for (const m of CONNECTION_METHODS) if (m.webUi) assert.match(m.webUi.path, /^\//, m.id)
  for (const m of PRINTER_MODELS) {
    const ui = m.webUi
    if (!ui) continue
    assert.ok(Number.isInteger(ui.port) && ui.port > 0 && ui.port < 65536, m.id)
    assert.match(ui.path, /^\//, m.id)
    for (const via of ui.via ?? []) assert.ok(m.connections.includes(via), `${m.id} via ${via}`)
  }
})
