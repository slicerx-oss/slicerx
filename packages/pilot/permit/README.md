# sx-permit

Approval broker. Registers pending approval requests, mints single-use HMAC tokens bound to session, action, target and parameter hash after the user approves, and verifies them for every call with a side effect. Tokens expire after 5 minutes. Used by the desktop app, `sx-link` and `sx-connect`.

The TypeScript mirror is `packages/pilot/src/permit/broker.ts` (browser demo, fleet-sim, evals). Both follow the same rules and check in the same order.

## Public API

```rust
pub struct ApprovalBroker;
impl ApprovalBroker {
    pub fn new() -> Result<Self, Error>;                                  // random 32 byte secret, system clock
    pub fn with_clock(clock: impl Clock + 'static) -> Result<Self, Error>; // tests inject a fake clock
    pub fn register(&self, req: ApprovalRequest) -> Result<(), Error>;
    pub fn grant(&self, request_id: &str) -> Result<ApprovalToken, Error>;
    pub fn deny(&self, request_id: &str) -> Result<(), Error>;
    pub fn verify(&self, token: &ApprovalToken, action: &str, target: &str, params_hash: &str) -> Result<(), Error>;
    pub fn pending(&self) -> Vec<String>;
}

pub trait Clock: Send + Sync { fn now(&self) -> SystemTime; }
pub const TOKEN_TTL: Duration; // 5 minutes

pub fn canonical_json(value: &serde_json::Value) -> String;
pub fn hash_params(params: &serde_json::Value) -> String; // lowercase hex SHA-256 of canonical_json
```

`ApprovalRequest`, `ApprovalAction`, `ApprovalToken` and `PermissionClass` mirror `packages/contracts/src/pilot.ts` with camelCase serde. `ApprovalToken`'s `Debug` leaves the token out.

Rules:

- `register` copies the request, so changing the caller's value afterwards cannot widen the grant. It refuses a repeated id and any action with an empty target or a `paramsHash` that is not 64 lowercase hex characters.
- `grant` works once and only on a pending request. The token is base64url (no padding) of HMAC-SHA256 over the canonical JSON of `{id, session, tool, params, actions, exp}`, the same payload the TS broker signs. The secret is per broker and never leaves memory.
- `deny` marks the request denied. A granted request is revoked, so its token stops verifying. Unknown ids are ignored, as in the TS broker.
- `verify` returns `Unknown`, `Denied`, `BadSignature` (constant-time compare through `hmac`'s `verify_slice`), `Expired`, `Mismatch` or `Used`, checked in that order. Each action in the request verifies once. A mismatch does not consume anything. `Error::failure_reason()` gives the contract's `ApprovalFailure` string.

`canonical_json` matches the TS `canonicalJson` byte for byte: keys sorted by UTF-16 code units at every level, no whitespace, strings escaped as `JSON.stringify` escapes them, and numbers written as JavaScript writes a double (`1` for `1.0`, `1e+21`, `1e-7`, ties to the even digit, integers past 2^53 rounded). `packages/contracts/fixtures/pilot-canonical-json.json` holds test vectors for both sides.

## Dependencies

- `base64` =0.23.1: base64url encoding of the token; same version as `sx-link`.
- `getrandom` =0.4.3: the 32 byte HMAC secret from the OS random source; same version as `sx-connect`.
- `hmac` =0.13.0: HMAC-SHA256 signing and constant-time verification; pairs with `sha2` 0.11.
- `serde` =1.0.229: derives for the contract types.
- `serde_json` =1.0.151 with `float_roundtrip`: the `Value` that `hash_params` takes. The feature makes float parsing exact, as `JSON.parse` is. Without it, some parsed doubles are off by one unit in the last place and hash differently from the TS side.
- `sha2` =0.11.0: SHA-256 for `hash_params` and the HMAC; same version as the rest of the workspace.
- `thiserror` =2.0.21: the crate error enum.

Every direct dependency is MIT or Apache-2.0. `subtle`, which `hmac` pulls in, is BSD-3-Clause. `deny.toml` allows all of them.

## Status

Working, with 24 unit tests, 2 fixture tests and 3 doc tests:

- The broker: register, grant, deny, verify and pending, with an injectable clock. Tests cover token reuse, a token for another printer, other params or another action, expiry on a fake clock, denied requests that cannot be granted, revocation after a grant, tampered or empty tokens, a token moved to another request or from another broker, granting twice, and a request mutated by the caller after `register`.
- `canonical_json` and `hash_params`. Beyond the unit tests, the output matched the TS `canonicalJson` on about 600,000 random doubles and 50,000 random keys and strings when checked with Node.
- Fixtures: `pilot-approval-request.json` and `pilot-canonical-json.json` in `packages/contracts/fixtures`, checked by `tests/contract_json.rs`. Run with `UPDATE_FIXTURES=1` to rewrite them after an intentional change.

Not done: expired and decided requests stay in memory for the life of the broker, as in the TS broker. The app has not wired `ApprovalGate` over the broker yet.
