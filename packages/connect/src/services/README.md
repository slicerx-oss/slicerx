# Service plugins

## Spoolman (`spoolman`)

Inventory over `GET /api/v1/spool`, `GET /api/v1/spool/{id}` and `PUT /api/v1/spool/{id}/use`. Spools are normalized to `{id, material, vendor, name, color, remainingG, initialG}`. `record_usage` needs a `plugin.call` approval token bound to its `{pluginId, tool, input}`.

Source: https://donkie.github.io/Spoolman/ (OpenAPI at `/api/v1/docs` on the server).

## Home Assistant (`home-assistant`)

`GET /api/states` and `POST /api/services/{domain}/{service}` with a long-lived access token (`Authorization: Bearer`). `call_service` only accepts the domains `switch`, `light`, `fan`, `input_boolean` and `button`, requires a `plugin.call` approval token bound to `{pluginId, tool, input}`, and validates the service name and entity id.

Source: https://developers.home-assistant.io/docs/api/rest/

Both plugins take an `http://` base URL on the local network. `https://` is refused until the app has a way to ask the user about a certificate.
