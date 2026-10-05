# sx-relay

The hosted pairing relay. Phones, hubs and remote agents that are not on the same network reach each other through it. Every frame it carries is sealed end to end by the pairing protocol (`packages/pair`, and its Rust port in sx-link), so the relay sees opaque routes and ciphertext only.

It follows the rules of the reference relay, `createMemoryRelay` in `packages/pair/src/relay.ts` (protocol in `packages/pair/README.md`, "Relay protocol"), and adds quotas. It keeps nothing on disk and logs a line of counters every 10 minutes, never a route or a body.

```
sx-relay [--listen 127.0.0.1:8787] [--jwks FILE] [--issuer URL] [--trust-proxy]
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

A connection without an account is metered with every other connection from its IP address (an IPv6 /64), and at most 32 connections are open from one IPv6 /48. After `auth` it is metered as the account, so signing in raises the limits. Every inbound frame costs one from the meter's frame rate, a send pays the per-minute byte rate once per subscriber it reaches, an opaque route takes four subscribers, each meter may queue 16 MB, and a connection refused 64 times in a row is closed. Limits and the deployment are in `packages/connect/link/deploy/README.md`, "Hosted relay".

## Tests

`cargo test -p sx-relay` runs the route, token, quota and calendar rules and the relay over real sockets. `packages/pair/test/hosted-relay.test.ts` runs the memory relay's rules against both relays and pairs a phone through this one; it needs `cargo build -p sx-relay` first.
