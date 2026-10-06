# Finding printers on your network

Add printer, then Scan, lists the printers SlicerX can see. It only lists them. Nothing connects until you pick one and enter its code or key.

## For users

### What a scan does

| Printer | How it is found | What SlicerX sends |
| --- | --- | --- |
| Bambu Lab | It answers an SSDP search and announces itself every five seconds (UDP 2021 and 1990), in LAN Only Mode and in cloud mode alike. The answer names the model, serial number and firmware. | One SSDP search per network interface, repeated twice in the scan. |
| Klipper with Moonraker | It announces `_moonraker._tcp` with multicast DNS. A Snapmaker U1 announces itself as U1.local and is listed as a U1. | One multicast DNS question. |
| Creality on stock firmware | It announces a service type of its own, `_Creality-<id>._udp` (as OrcaSlicer finds it). | The same multicast DNS question, which also asks for the list of service types. |
| OctoPrint | It announces `_octoprint._tcp`. | One multicast DNS question. |
| PrusaLink | It may announce `_prusalink._tcp`. This has not been seen on a printer yet. | One multicast DNS question. |
| UltiMaker | It announces `_ultimaker._tcp` with its model (a BOM number), firmware and name, as UltiMaker Cura reads it. | One multicast DNS question. |
| Elegoo Centauri Carbon | It answers one broadcast on UDP port 3000. | One broadcast, sent when you start the scan and never in the background. |
| Snapmaker A150, A250, A350, J1 and Artisan | They answer one broadcast of `discover` on UDP port 20054 with their name, address and model. The J1 and Artisan are listed, but SlicerX does not connect to them yet. | One broadcast, sent when you start the scan and never in the background. |
| Duet | It does not announce itself. | Nothing. Enter the IP address. |
| Anycubic in LAN Mode | No announcement is documented. A typed address is asked for `GET /info` on port 18910, which names the model and whether LAN Mode is on. | Nothing during a scan. |

A scan takes about three seconds. It lists only printers on your own network; anything else is dropped.

### If a scan finds nothing

1. Check that the computer and the printer are on the same network. A guest Wi-Fi, a VLAN or a router setting called client isolation or AP isolation blocks announcements.
2. Check that the printer is on and connected. Bambu Lab printers answer only while awake.
3. Multicast DNS uses UDP 5353. A firewall on the computer may block it. Allow SlicerX, or enter the IP address by hand.
4. Use Enter IP instead. A Bambu Lab printer asked at its address answers with its model and serial number (or SlicerX reads the serial from its certificate), so only the access code is left to type. Klipper printers are asked on Moonraker's 7125 and on 80, a Snapmaker U1 by its own Klipper object, and a Creality printer through its `/info` page and port 9999. Every guide says where to read the address on the printer.

On Windows, Hyper-V and WSL add virtual network adapters. SlicerX sends its questions out of every network adapter that has a private address, so the one the printer is on is always among them.

The browser build finds printers through `sx-link`, the small program that runs on your computer, so a scan there sees your network, not the browser's.

### What was checked on a real printer

On 2026-10-05 a Bambu Lab H2D (firmware 01.03.00.00) on a home Wi-Fi network broadcast its `NOTIFY` to 255.255.255.255:2021 every five seconds, nothing on 1990, and answered an `M-SEARCH` for `urn:bambulab-com:device:3dprinter:1` within 0.2 seconds by unicast, whether the search went to 239.255.255.250:1990, the broadcast address on 1990 or 2021, or the printer's own address. A three second scan that only listens catches a five second announcement about three times in five, and Wi-Fi drops some broadcasts, which is why the scan now asks.

## For integrators

### `discover` in sx-link

```json
{ "id": 7, "method": "discover", "params": { "timeoutMs": 3000 } }
```

`timeoutMs` is 300 to 10000 (default 3000). The reply is `{"printers": DiscoveredPrinter[]}`, sorted by plugin and host:

```ts
interface DiscoveredPrinter {
  plugin: string   // a printer plugin id, such as "moonraker"
  host: string     // IP address on the local network
  port?: number
  name?: string    // the announced instance or printer name
  model?: string
  serial?: string  // Bambu Lab
  firmware?: string
  lanOnly?: boolean // Bambu Lab: LAN Only Mode is on
  bound?: boolean   // Bambu Lab: bound to a Bambu account (DevBind)
  tls?: boolean     // Moonraker: HTTPS offered too (https_port)
  uid?: string      // an identity that survives an address change: Moonraker's uuid, a Creality id or MAC
}
```

`@slicerx/link-client` exposes it as `client.discover(timeoutMs?)`. The bridge runs every connector's own discovery and the mDNS browse at once and merges the results: the same plugin and host counts once, and a host that is not on the local network (`is_lan_host`) is dropped. Nothing runs unless a paired client calls it, so a scan is always the user's action. `sx-link --no-mdns` turns mDNS browsing and advertising off; the connector discovery still runs.

### `probe` in sx-link

```json
{ "id": 8, "method": "probe", "params": { "host": "192.168.1.52", "timeoutMs": 1500 } }
```

Asks one address on the local network, for Enter IP instead. Each connector that can ask a single address does: Bambu Lab (an SSDP search sent to the printer on 2021 and 1990, then the serial from the MQTT certificate), Moonraker (`/server/info` on 7125, then 80), Snapmaker (a U1's Moonraker on 80, then 7125), Creality (`GET /info`, then TCP 9999), Snapmaker 2.0, J1 and Artisan (`discover` on UDP 20054), Elegoo (`M99999` on UDP 3000), PrusaLink (`GET /api/version`), and the others their guides name. The reply is `{"printers": DiscoveredPrinter[]}`, empty when nothing answered. Nothing signs in.

### Interfaces

`sx_connect::netif` lists the private IPv4 interfaces that are up. Bambu Lab searches, the Elegoo and Snapmaker broadcasts and mDNS queries leave from one socket per interface, with the multicast interface set, because a socket on 0.0.0.0 reaches only the network the OS picks. The Bambu listeners on 2021 and 1990 set SO_REUSEADDR (and SO_REUSEPORT on Unix), so they share the ports with Bambu Studio and OrcaSlicer when those run too.

### mDNS in `sx_connect::mdns`

A small RFC 6762 and RFC 6763 implementation: a packet parser and encoder, `browse`, `browse_printers` and `Advert`. `browse` sends its query from an ephemeral port, so responders answer to that port by unicast (RFC 6762 section 6.7) and nothing has to bind 5353. The query is repeated after a third and two thirds of the window, because multicast loses packets. The parser follows only backward compression pointers, caps names at 255 bytes and refuses truncated packets.

The service types browsed are in `PRINTER_SERVICES`, plus the list of service types (`_services._dns-sd._udp.local`), where stock Creality firmware shows as `_Creality-<id>._udp.local`. `_moonraker._tcp` and `_octoprint._tcp` are announced by those projects. `_prusalink._tcp`, `_prusa-link._tcp` and `_duet._tcp` are the names their documentation suggests and are unverified on hardware. Moonraker's TXT record gives `uuid` (the printer's `uid`), `version` and `https_port`. A Moonraker whose host is U1.local arrives as a `snapmaker` U1; other Klipper printers arrive as `moonraker`, and the user still picks the brand entry for a Creality, QIDI or Sovol.

### Testing

`browse_finds_a_responder_over_udp` in `src/mdns.rs` runs a responder on a local socket. `discover_lists_printers_announced_over_mdns_and_drops_addresses_off_the_network` in `link/tests/link.rs` answers a browse with a printer on the mock Moonraker and one on a public address, checks that only the first is listed, then adds it and reads its status from the mock.
