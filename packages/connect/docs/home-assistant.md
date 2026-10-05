# Home Assistant

Lets SlicerX see the switches, lights and fans in your Home Assistant, and (after you approve each action) turn them on or off. Typical uses: a smart plug that powers a printer, an enclosure fan, a camera light.

## For users

### In Home Assistant

1. Open your profile page, Security tab, and create a long-lived access token. Copy it now; Home Assistant shows it once.
2. Note the address, for example `http://192.168.1.60:8123` or `http://homeassistant.local:8123`.

### In SlicerX

Add Home Assistant under service plugins, enter the address and paste the token. SlicerX stores the token in your keychain and never shows it again. The address must be `http://` on your local network; `https://` and internet addresses are refused for now.

### What SlicerX can see and do

It lists entities in these domains, with their state and name:

| Domain | Example | Typical use |
| --- | --- | --- |
| `switch` | `switch.bay_2_power` | printer power plug |
| `light` | `light.bay_2_camera_light` | camera or enclosure light |
| `fan` | `fan.bay_2_enclosure` | enclosure fan |
| `input_boolean` | `input_boolean.printing_lights` | a flag your automations react to |
| `button` | `button.bay_2_restart_plug` | one press actions |

It can call services in those five domains, typically `turn_on`, `turn_off`, `toggle` and `press`. Locks, alarms, covers, climate, scripts and everything else are out of reach on purpose. Each call asks for approval and names the entity, the service and the parameters. An approval works once.

Listing entities needs no approval.

### Example automations

These run inside Home Assistant. SlicerX only flips the entity; Home Assistant does the rest.

Enclosure fan follows the printer plug:

```yaml
automation:
  - alias: Bay 2 enclosure fan follows printer power
    trigger:
      - platform: state
        entity_id: switch.bay_2_power
    action:
      - service: "fan.turn_{{ trigger.to_state.state }}"
        target:
          entity_id: fan.bay_2_enclosure
```

Camera light while a job runs, driven by a flag SlicerX sets (ask Pilot to turn `input_boolean.printing_lights` on at the start of a job and off after):

```yaml
automation:
  - alias: Printing lights
    trigger:
      - platform: state
        entity_id: input_boolean.printing_lights
    action:
      - service: "light.turn_{{ trigger.to_state.state }}"
        target:
          entity_id: light.bay_2_camera_light
```

Cut the plug after the printer has cooled, using a flag SlicerX sets when a job ends:

```yaml
automation:
  - alias: Bay 2 power off after cooldown
    trigger:
      - platform: state
        entity_id: input_boolean.bay_2_job_done
        to: "on"
        for: "00:30:00"
    action:
      - service: switch.turn_off
        target:
          entity_id: switch.bay_2_power
      - service: input_boolean.turn_off
        target:
          entity_id: input_boolean.bay_2_job_done
```

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | The token was deleted or mistyped. Create a new one. |
| "is unreachable" | Wrong address or port (8123), or Home Assistant is off. |
| "URLs must start with http://" | Use the local `http://` address. |
| "services in the lock domain are not supported" | Only switch, light, fan, input_boolean and button are allowed. |
| A plug does not turn off a printer that is printing | SlicerX does not stop you: cutting power mid-print ruins it. Approve carefully. |

### Untested on hardware

Checked against a simulator of the REST API, not a Home Assistant install. First things to check: that your token works over plain `http://`, and the state strings of your entities.

## For integrators

Plugin id `home-assistant` (kind `home`). Tools: `home-assistant.list_entities` (read; optional `domain`) and `home-assistant.call_service` (permission `start`; `domain`, `service`, `entityId`). Network: `lan:8123`.

`list_entities` returns `{entityId, state, name}` from `GET /api/states`. `call_service` posts `{"entity_id": ...}` to `POST /api/services/{domain}/{service}` with `Authorization: Bearer <token>`. Checks before the request: the domain is in the allow-list, the service name matches `[a-z0-9_]+`, the entity id starts with `<domain>.`, and a `plugin.call` approval is bound to `{pluginId, tool, input}` with the tool name `call_service`. The token comes from the keychain entry named by `secretRef` when the service is configured.

There is no rate limiting in the plugin. SlicerX does not publish printer entities to Home Assistant yet; it only reads and calls what Home Assistant already has.

### Testing

`tests/services.rs` runs the plugin against a Home Assistant fake (token `mock-ha-token`, five `switch.bay_N_power` entities). The allow-list, token binding and bad-token cases are covered.

### Sources

Home Assistant REST API: https://developers.home-assistant.io/docs/api/rest/.
