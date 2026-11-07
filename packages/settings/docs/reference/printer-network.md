# Printer: Network and hosts

13 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `bbl_use_printhost`

**Send through a print host**

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

**Print host type**

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

**Print host web page**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printer_agent`

**Printer network connection type**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_apikey`

**Print host API key**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_authorization_type`

**Print host authorization type**

- Type: enum
- Default: "key"
- Values: `key` (API key), `user` (HTTP digest)
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_cafile`

**Print host certificate file**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_password`

**Print host password**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_port`

**Print host port**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_ssl_ignore_revoke`

**Ignore certificate revocation checks**

- Type: boolean
- Default: off
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `printhost_user`

**Print host user**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)
