# PrusaLink

Plugin id `prusalink`, default port 80. Authentication is the `X-Api-Key` header, or HTTP digest login (MD5, `qop=auth`, RFC 7616) when the config names a `username` and the secret is the password. The first request draws a 401 challenge, which is answered once and reused for the session (`../../digest.rs`). Covers the local API of MK4S, MK3.9, MINI+, XL, Core One and other printers running PrusaLink. Prusa Connect's cloud API is not used.

## Endpoints used

`GET /api/v1/info`, `GET /api/v1/status`, `GET /api/v1/job` (204 when idle), `PUT /api/v1/files/{storage}/{path}` with `Overwrite: ?1` and `Print-After-Upload: ?0`, `POST /api/v1/files/{storage}/{path}` to start, `PUT /api/v1/job/{id}/pause|resume`, `DELETE /api/v1/job/{id}`, `GET /api/v1/cameras` and `/api/v1/cameras/{id}/snap`.

`ATTENTION` (filament change, for example) reports as paused with a message. The v1 API has no layer counts and no G-code console.

## Sources

- PrusaLink OpenAPI spec: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml

## Unverified

Digest login is tested against a mock that checks the response with an independent implementation and against the RFC 2617 example, not against a printer. The storage name defaults to `usb`.
