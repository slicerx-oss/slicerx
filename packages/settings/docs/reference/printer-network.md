# Printer: Network and hosts

13 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `bbl_use_printhost`

**Bbl use printhost**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `flashforge_serial_number`

**Flashforge serial number**

- Type: string
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `host_type`

**Host type**

- Type: enum
- Default: "octoprint"
- Values: `prusalink` (PrusaLink), `prusaconnect` (Prusa Connect), `octoprint` (OctoPrint), `duet` (Duet), `flashair` (FlashAir), `astrobox` (AstroBox), `repetier` (Repetier), `mks` (MKS), `esp3d` (ESP3D), `crealityprint` (Creality Print), `obico` (Obico), `flashforge` (Flashforge), `simplyprint` (SimplyPrint), `elegoolink` (Elegoo Link), `3dprinteros` (3DPrinterOS), `moonraker` (Moonraker (Klipper))
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `print_host`

**Print host**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `print_host_webui`

**Print host webui**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_agent`

**Printer agent**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_apikey`

**Printhost apikey**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_authorization_type`

**Printhost authorization type**

- Type: enum
- Default: "key"
- Values: `key` (API key), `user` (HTTP digest)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_cafile`

**Printhost cafile**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_password`

**Printhost password**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_port`

**Printhost port**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_ssl_ignore_revoke`

**Printhost ssl ignore revoke**

- Type: boolean
- Default: off
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_user`

**Printhost user**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)
