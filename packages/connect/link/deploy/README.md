# Running sx-link on its own

sx-link is the hub that talks to printers. The desktop app runs one inside itself. Run it on its own when a machine that stays on (a Raspberry Pi, a NAS, a home server) should keep queues, scheduled starts, phone alerts and the print watch going while laptops sleep.

| File | For |
| --- | --- |
| `sx-link.service` | A systemd system service on a Linux box without a desktop session. It runs as its own `slicerx` user, keeps state in `/var/lib/slicerx-hub` (0700), and is locked down to the network and that directory. Install steps are at the top of the file. |
| `Dockerfile`, `Dockerfile.dockerignore` | An image built from the repository root: `docker build -f packages/connect/link/deploy/Dockerfile -t slicerx/sx-link .` |
| `docker-compose.yml` | The image with host networking, a named volume for state, a read-only root and no capabilities. |
| `sx-relay.service` | The hosted pairing relay (`packages/connect/relay`) on a small VM. See "Hosted relay" below. |
| `scripts/real-printer-check.mjs` | The checks in [`packages/connect/docs/real-printer-checklist.md`](../../docs/real-printer-checklist.md), run against one printer the hub knows. |

On a desktop Linux machine, `sx-link service install` sets up a user service instead, and on macOS a login item.

## Network

The control socket listens on `127.0.0.1:47615` only. Apps on the same machine reach it directly; a phone reaches the hub through the app's encrypted pairing, over the phone listener the app turns on, or the relay. In Docker, use host networking so the hub reaches printers on the LAN, answers mDNS, and keeps its control socket on the host's loopback. Bridge networking would put the socket inside the container where nothing can reach it.

## Codes and keys

`sx-link code --state-dir <dir>` prints the app code, and `--agent` prints the code for the MCP server and other tools. The hub's public key is in `hub-key.pub`; clients check the hub against it before they send anything. Printer credentials are in `secrets.json` (0600) in the state directory, since a headless box has no keychain. Back up the state directory to keep pairings, queues and the hub's key across a reinstall.

## Camera stills

Bambu Lab X1 and H2 cameras send only H.264 video. For a still, the hub decodes one key frame: with VideoToolbox on macOS, and on Linux with Cisco's prebuilt OpenH264 2.6.0, which it downloads into the state directory the first time it needs one and checks against a pinned SHA-256 before loading. That needs `bzip2` on the box (the Docker image has it) and one outbound HTTP request to `ciscobinary.openh264.org`. Windows has no decoder yet, so those cameras give no still there. Snapshot and MJPEG cameras need none of this.

## Hosted relay

`sx-relay` forwards sealed frames between phones, hubs and remote agents when they are not on the same network. It cannot read them. It keeps nothing on disk: routes, queued frames and quota counters live in memory, so a restart drops queued frames and resets the monthly counters. Nothing has been deployed yet. These are the steps when it is.

1. Create one VM: Hetzner CX22 or similar (2 vCPU, 4 GB, 20 TB traffic), Debian 12. Point `relay.slicerx.app` (A and AAAA) at it.
2. Firewall: allow 22/tcp, 80/tcp, 443/tcp and 3478/udp, nothing else (`ufw allow ...`, then `ufw enable`).
3. Build on a Linux machine of the VM's architecture, or in the Docker build stage: `cargo build --locked --release -p sx-relay`. Copy `target/release/sx-relay` to `/usr/local/bin/sx-relay` (mode 0755).
4. Relay token keys: `sudo install -d -m 0755 /etc/sx-relay` and save the public half of the relay token key pair (see `packages/connect/relay/README.md`, "Relay tokens") as `/etc/sx-relay/jwks.json`. The relay accepts only tokens with audience `sx-relay`, never the project's own user sessions, so the Supabase project's JWKS does not go here. After rotating the relay key, replace the file and restart. Leave `SX_RELAY_JWT_SECRET` unset. If a minting function ever signs with HS256 instead, give it a new random secret used only for relay tokens, never the Supabase project's JWT secret, which would let anyone who reads `/etc/sx-relay/env` mint `service_role` tokens for the whole backend.
5. Install `sx-relay.service` from this folder to `/etc/systemd/system/`, replace `PROJECT` in its `--issuer`, then `sudo systemctl daemon-reload && sudo systemctl enable --now sx-relay`. It listens on `127.0.0.1:8787` only.
6. TLS with Caddy (`apt install caddy`), `/etc/caddy/Caddyfile`:

   ```
   relay.slicerx.app {
       reverse_proxy /v1 127.0.0.1:8787
       log {
           output discard
       }
   }
   ```

   Caddy gets the certificate and sets `X-Forwarded-For`, which the relay reads only on loopback connections (`--trust-proxy`). Access logs are discarded so routes are never written down.
7. STUN for direct video (`apt install coturn`), `/etc/turnserver.conf`:

   ```
   listening-port=3478
   stun-only
   no-cli
   no-tls
   no-dtls
   fingerprint
   log-file=/dev/null
   ```

   then `systemctl enable --now coturn`. STUN only: there is no TURN, so no video is ever relayed through the VM by coturn.
8. Check: `journalctl -u sx-relay` shows `sx-relay listening on ws://127.0.0.1:8787/v1 (accounts on)` and a line of counters every 10 minutes. From another machine, a WebSocket client sending `{"op":"quota"}` to `wss://relay.slicerx.app/v1` gets the anonymous quota back.

Limits (defaults in `packages/connect/relay/src/quota.rs`):

| | Signed in (per account) | Not signed in (per IP address, IPv6 per /64) |
| --- | --- | --- |
| Connections open at once | 8 | 4 |
| Frames a second | 50 | 20 |
| Bytes a minute | 20 MB | 5 MB |
| Bytes a month, sent plus received | 5 GB | 1 GB |

For everyone: 30 new connections a minute per address, bodies up to 1.5 MB, 256 routes per connection, 64 queued frames per route for up to 10 minutes, 256 MB queued in all, 20,000 connections in all. A connection that stops reading with 8 MB waiting is closed.

Cost: the VM is about 5 EUR a month with 20 TB of traffic included; traffic above that is about 1 EUR per TB.
