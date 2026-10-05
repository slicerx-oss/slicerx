# Security model of @slicerx/pair

This covers pairing a phone with SlicerX and using it to send print jobs. To report a vulnerability, follow the repository's [SECURITY.md](../../SECURITY.md).

## What we protect

- Control of printers. Heating, moving and starting a printer can cause damage or a fire.
- The user's files, print history and printer list.
- The device keys and identity keys on each device.
- The user's trust decisions: which devices are paired and what each may do.

## Who we defend against

| Adversary | Can | Must not be able to |
| --- | --- | --- |
| Someone on the same network | Read and change LAN traffic, connect to the host's LAN port | Pair, read messages, send commands |
| The relay operator (including the SlicerX cloud) | Read, drop, delay, replay and inject relay frames; see which routes talk and when | Read or forge messages, pair a device, approve anything |
| Someone who has the account password | Sign in, post join requests, subscribe to account routes | Add a device without a person comparing digits on a trusted device |
| Someone who sees the QR code or code on screen | Try to pair first | Pair without the host user confirming matching digits |
| A paired phone that turns hostile | Whatever its rights allow | Exceed its rights, reach other phones' files, skip approvals |
| A compromised printer or model file | Return hostile names and replies | Change what a person approves |

Out of scope: a compromised host computer or an unlocked phone in someone else's hands (both hold the keys by design); denial of service by the relay or the network; traffic analysis beyond what is listed under residual risks.

## Design

Primitives: X25519, Ed25519, HKDF-SHA-256, HMAC-SHA-256 and XChaCha20-Poly1305 from the audited noble libraries. Every derived key has its own label under `sx-pair/v1`.

Identities. Each device has an Ed25519 signing key and an X25519 key-agreement key. Its device id is the first 16 bytes of SHA-256 of the signing key.

Pairing handshake (`src/handshake.ts`):

1. The host shows an offer: a random 16 byte id, a random 32 byte secret and a fresh X25519 key, in a QR link; or a 12 symbol code from which both sides derive the id and secret.
2. The phone sends its ephemeral key, a commitment to a random nonce, and an HMAC keyed from the secret.
3. The host checks the HMAC, then replies with its ephemeral key, its nonce and an HMAC. For QR links the phone checks that the key matches the one in the code.
4. The phone reveals its nonce; the host checks the commitment.
5. Both derive keys from the X25519 result and the transcript, and show six digits derived from the transcript.
6. After the person confirms on each screen, each side sends its identity and a signature over the transcript, encrypted under a key from step 5. The host stores the pairing only after its own person confirmed and the phone's confirm verified.

Because the phone commits before it sees the host's nonce, and the host reveals its nonce before it sees the phone's, a party in the middle gets the two screens to match with a chance of one in a million per attempt. Each offer serves one phone and burns after five wrong proofs, so an attacker gets one try per offer the user shows.

Sessions (`src/session.ts`, version 2). Each connection runs a fresh X25519 exchange. The device's `init` carries an HMAC under the device key. The host's `accept` carries an HMAC under a key derived from the device key and `DH(eD, host static key)`, where the host static key is the `dhPub` the phone pinned at pairing. The session keys come from the ephemeral exchange, the device key and that static exchange. Each direction has its own key and a counter that must rise strictly. A leaked device key does not open recorded sessions (forward secrecy), it does not let anyone answer as the host, and a frame cannot be replayed, reordered or sent back to its sender. Both frames carry the version; each side refuses any other version with an error that names the side to update, and neither falls back to the version 1 schedule.

Introductions (`src/grant.ts`). A trusted device signs a grant naming the new device's keys, one host, the account and the rights. The host accepts it only if the issuer is one of its own pairings with the introduce right and the same account, the grant is unexpired (7 days), and its id was never revoked. Rights are capped at the issuer's. The phone and host derive the device key from their static X25519 keys and the grant hash.

Approvals. Phone job requests become approval requests with one action per printer and step, hashed per the `ApprovalAction` contract. The approval broker mints the token only after a decision from the host's card or from a phone with the approve right. A phone's decision is signed with its identity key over the SHA-256 of the request as the host holds it. The phone never sees the token.

Pairing a client with sx-link (`packages/connect/cpace`, `packages/connect/link-client/src/cpace.ts`). The app, tools and the print watch pair with the hub by its eight symbol code through CPace as specified in draft-irtf-cfrg-cpace-18, cipher suite CPACE-RISTR255-SHA512, with the initiator and responder transcript. The group operations come from curve25519-dalek and @noble/curves, including element derivation (`RistrettoPoint::from_uniform_bytes`, `deriveToCurve`); both implementations reproduce the draft's appendix B.3 vectors and a shared set of cross-implementation vectors. The channel identifier binds the protocol version (`sx-link pair v2`), the hub's identity key and its port; the session id is both `hello` nonces; the associated data names the client side and the role. A message that does not decode, or gives the identity, ends the run. Tags are compared in constant time, and scalars and session keys are wiped after use where the language allows (Rust; in JavaScript only the random bytes and key arrays, since a bigint cannot be wiped). A program posing as the hub gets one guess per attempt and nothing it can test offline, and the hub must confirm the exchange before a client pins its key. Wrong confirms count toward the hub's lockout.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Someone on the LAN pairs while the QR code is shown | They need the secret from the code, and the host user must confirm digits that match their own phone. |
| Someone photographs the QR code and pairs first | The offer is single use; the host user sees digits that do not match their phone and rejects. |
| Guessing the short code | 55 random bits and a 5 minute lifetime, with the relay rate-limiting route use. Even with the code, the six digits stop a party in the middle. |
| The relay learns the short code by brute force of the route | Possible offline in principle. It gains no more than the code's holder: the digits still protect the pairing. |
| Relay reads or forges messages | Session keys come from X25519 authenticated with the device key; every frame is encrypted and authenticated. |
| A device key copied from a phone backup, used to pose as the computer | The host's accept needs its static X25519 key as well, which never leaves the computer and the hub. The phone refuses the session. |
| An attacker strips the version to force the old key schedule | Hosts refuse an `init` without version 2 with `update`; phones refuse an `accept` without it. There is no fallback. |
| Relay replays old frames or whole sessions | Fresh keys per session and strict counters. A replayed session start gets an answer the relay cannot use. |
| Pairing link points the phone at an attacker's server | Relay URLs must be on the app's trusted list; LAN URLs must be private addresses. |
| Account password stolen, attacker adds a device | Join requests need a person on a trusted device to compare digits with the new device and approve. |
| SlicerX cloud forges a grant | Grants are signed by a device key the host itself paired with; the cloud holds no such key. |
| Revoked device returns | Its keys are deleted on the host. Revoked grant ids are kept, so a stored grant cannot pair again. |
| A phone approves something other than what it showed | The decision is signed over the request hash; the host compares with its own copy. |
| Phone code tricked into approving a computer request it did not ask for | The phone's PrinterHost signs a computer request only when each of its actions verifies against the token the person approved on the phone, which is consumed on use. |
| A phone exceeds its rights | Rights are checked on the host for each request. A device without `approve` cannot decide, even its own job. |
| Hostile parameters from a paired phone | Every frame and request is parsed with length limits before use; unknown methods fail; uploads are size-capped and hash-checked. |
| Hostile printer names or file names | Rendered as text. Approval requests are built on the host, not from phone text, apart from the file name, which the request shows with its hash. |
| Oversized frames or floods | Frame, message, upload and session limits on the host; the relay caps bodies and queues. |
| Clock skew | Only the host's clock matters for approval expiry. Grant dates allow 5 minutes of skew. |

## Residual risks

- A phone with the approve right can start printers. A stolen unlocked phone can do so until someone revokes it. The phone app should require the device passcode or biometrics before approving.
- The relay sees timing, sizes and which routes talk, and so can tell that two devices are paired and active. It also sees the device name in account join requests.
- A new device's name and keys travel in the clear in its first contact after an introduction.
- A device key alone still lets someone pose as that phone to the host, since the phone side of a session has no static key of its own. Approvals stay safe: decisions are signed with the phone's Ed25519 identity key, which the device key does not give.
- Short code pairing: the relay routes come from the code, so the relay can test guesses of the 55 bit code offline. This is accepted by design. The six digits both people compare are what stop a party in the middle, and knowing the code gives the relay no more than a person who saw it.
- The hub holds the host's static X25519 secret (in its secret store) so it can answer phones while the app is closed. Whoever reads the hub's secret store can pose as the host to phones paired with it.
- Keys live where the platform stores them. The browser build has no OS keychain and keeps pairings in IndexedDB, so a script injected into the app could read them.
- If a host's confirm is lost after the host stored the pairing, the host lists a phone that does not know the pairing. The host user can remove it.
- Grant checks cost an Ed25519 verification each, which a flood of first-contact frames could exploit to load the host. The relay's rate limits bound it.
