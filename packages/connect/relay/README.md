# sx-relay

The hosted pairing relay. Phones, hubs and remote agents that are not on the same network reach each other through it. Every frame it carries is sealed end to end by the pairing protocol (`packages/pair`, and its Rust port in sx-link), so the relay sees opaque routes and ciphertext only.

It follows the rules of the reference relay, `createMemoryRelay` in `packages/pair/src/relay.ts` (protocol in `packages/pair/README.md`, "Relay protocol"), and adds quotas. It keeps nothing on disk and logs a line of counters every 10 minutes, never a route or a body.

```
sx-relay [--listen 127.0.0.1:8787] [--jwks FILE] [--issuer URL] [--trust-proxy]
         [--partner-routes N] [--partner-route-bytes N] [--partner-account-bytes N] [--partner-idle-secs N]
```

| Flag | Meaning |
| --- | --- |
| `--listen` | Plain WebSocket address. Put a TLS proxy (Caddy) in front of it. The path is `/v1`. |
| `--jwks` | Public keys (ES256 or RS256) of the service that mints relay tokens. |
| `--issuer` | Required `iss` of relay tokens. |
| `--trust-proxy` | Take the client address from `X-Forwarded-For`, on loopback connections only. |
| `SX_RELAY_JWT_SECRET` | An HS256 secret for relay tokens, instead of or besides `--jwks`. Generate a new random secret used for nothing else. Never set it to the Supabase project's JWT secret: anyone who can read the relay's environment could then mint `service_role` tokens for the whole backend. Prefer `--jwks`. |

Without keys or a secret, `auth` is refused and every connection gets the anonymous quotas.

## Relay tokens

`auth` takes a relay token: a JWT with `aud` `sx-relay`, the account id as `sub`, and an `exp` a few minutes out. The relay refuses every other audience, so an account's own Supabase session (`aud` `authenticated`), which works against the whole backend, is never accepted and never needs to reach the relay. Anonymous sign-ins (`is_anonymous: true`) are refused too. When a token expires the connection drops to its address's anonymous meter and leaves its `acct:` routes, and the relay sends `error` `expired`.

The verifying side is here. The minting side is a backend function the owner deploys, `relay-token`:

1. Generate an ES256 key pair for the relay alone. Keep the private key as a function secret (`SX_RELAY_SIGNING_KEY`, a JWK) and give the relay the public half as a JWKS file (`--jwks`).
2. `POST /functions/v1/relay-token` with the caller's session as `Authorization: Bearer` and the anon key as `apikey`. The function checks the session with `auth.getUser()`, refuses anonymous users and banned accounts, and answers `{ "token": <jwt>, "expiresAt": <unix ms> }`.
3. The token's claims are `{ "aud": "sx-relay", "sub": <user id>, "iss": <the function's URL>, "iat", "exp": iat + 600 }`, header `{ "alg": "ES256", "kid": <key id> }`. Start the relay with `--issuer` set to the same `iss`.

Clients: the desktop and web apps mint through `configureRelayTokens` (`@slicerx/app`) and hand the hub the token, never the session; the phone uses `relayTokenSource` (`@slicerx/pair`) for its account relay. Without the function every client stays on the anonymous tier, which keeps working.

## Additions to the reference protocol

| From | Frame | Meaning |
| --- | --- | --- |
| client | `{"op":"quota"}` | Ask for this connection's quota. |
| relay | `{"op":"quota","tier","used","cap","resetsAt","connections","maxConnections","framesPerSecond","bytesPerMinute","maxBody"}` | `tier` is `account` or `anonymous`; `used` and `cap` are bytes this UTC month; `resetsAt` is Unix milliseconds. |
| relay | `{"op":"auth","ok":true,"tier":"account"}` | The session was accepted. A bad one gets `error` `forbidden`. |
| relay | `error` `rate_limited` with `"scope"` | `second`, `minute`, `month` or `connections`. |
| relay | `error` `expired` | The relay token ran out; the connection is anonymous until it sends a new one. |
| client | `{"op":"partner.open","up","down"}` | A signed-in connection opens a partner route: two `pr:` routes (`pr:` and 43 base64url characters), `up` from the partner's phone and `down` to it. The relay answers `{"op":"partner.open","ok":true,"up"}`. |
| client | `{"op":"partner.close","up"}` | The connection that opened a partner route closes it. |
| relay | `{"op":"partner.closed","route","reason"}` | To everyone on either route and to the connection that opened it. `reason` is `closed`, `idle`, `route_cap`, `account_cap`, `owner_gone` or `signed_out`. |
| relay | `error` with `"route"` | A refusal about one partner route, with `scope` `partner_routes`, `partner_route_day` or `partner_day` when a cap refused it. |
| relay | `quota` `"partner"` | `{"routes","maxRoutes","usedToday","capPerDay","routeCapPerDay","idleSeconds"}` for the connection's account. |

## Partner routes

A partner route carries a partner app's sealed byte stream between the hub (for the partner's desktop app) and the partner's own paired phone. The hub opens it on its signed-in connection, so an anonymous connection never opens one. A `pr:` route takes `sub` and `send` only while it is open; before it opens and after it closes, both are refused. The relay meters each frame against the sender's own quota as usual and against the partner caps, all configurable on the command line:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--partner-routes N` | 4 | Partner routes one account may have open at once. |
| `--partner-route-bytes N` | 50000000 | Bytes one route may carry in a UTC day, both directions. Past it the route closes (`route_cap`). |
| `--partner-account-bytes N` | 200000000 | Bytes all of one account's routes may carry in a UTC day. Past it they all close (`account_cap`) and none opens until the next UTC day. |
| `--partner-idle-secs N` | 300 | A route that carries nothing this long closes (`idle`). |

A route also closes when the connection that opened it closes (`owner_gone`) or its account session runs out (`signed_out`). The relay counts sizes and times only and adds the number of partner routes and their bytes to its counter line. The hub's side is `packages/connect/link/src/partner_route.rs`; the partner's side is `docs/integrators/partner-route.md`.

A connection without an account is metered with every other connection from its IP address (an IPv6 /64), and at most 32 connections are open from one IPv6 /48. After `auth` it is metered as the account, so signing in raises the limits. Every inbound frame costs one from the meter's frame rate, a send pays the per-minute byte rate once per subscriber it reaches, an opaque route takes four subscribers, each meter may queue 16 MB, and a connection refused 64 times in a row is closed. Limits and the deployment are in `packages/connect/link/deploy/README.md`, "Hosted relay".

## Tests

`cargo test -p sx-relay` runs the route, token, quota, partner route and calendar rules and the relay over real sockets. `packages/pair/test/hosted-relay.test.ts` runs the memory relay's rules against both relays and pairs a phone through this one; it needs `cargo build -p sx-relay` first.
