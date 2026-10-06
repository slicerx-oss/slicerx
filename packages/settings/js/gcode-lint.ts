// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The G-code linter of packages/core/src/gcode_lint.rs, for hosts that review G-code text before it reaches the
// engine (a project's start G-code shown to a person, an MCP refusal). The engine lints the rendered text again when
// it writes the file, so this copy decides what a person is asked, never what runs. The two agree on every case in
// packages/core/tests/gcode_lint_cases.json.
//
// `template: true` reads unrendered template text: placeholders (`[name]`, `{expr}`) stand for unknown values
// instead of being errors, so the commands around them are still checked.

export type LintSection = 'start' | 'end' | 'layerChange' | 'toolChange' | 'pause' | 'other'
export type LintTrust = 'trusted' | 'untrusted'
export type LintSeverity = 'warning' | 'error'

export interface LintFinding {
  /** 1-based line of the section text. */
  line: number
  code: string
  severity: LintSeverity
  message: string
}

export interface LintLimits {
  nozzleMaxC?: number | undefined
  bedMaxC?: number | undefined
  chamberMaxC?: number | undefined
}

const FALLBACK_NOZZLE_C = 350
const FALLBACK_BED_C = 150
const FALLBACK_CHAMBER_C = 90

const DENIED: [string, string, string][] = [
  ['M500', "writes settings to the printer's memory", 'eeprom_write'],
  ['M501', "reloads settings from the printer's memory, undoing the profile", 'eeprom_load'],
  ['M502', 'resets the printer to factory settings', 'factory_reset'],
  ['M504', 'validates or rewrites stored settings', 'eeprom_write'],
  ['SAVE_CONFIG', "rewrites the printer's config file and restarts it", 'config_save'],
  ['SAVE_VARIABLE', "writes to the printer's saved variables", 'config_save'],
  ['FIRMWARE_RESTART', "restarts the printer's firmware", 'firmware_restart'],
  ['RESTART', "restarts the printer's host software", 'firmware_restart'],
  ['M999', 'restarts the printer after an error', 'firmware_restart'],
  ['M997', "updates the printer's firmware", 'firmware_update'],
  ['M112', 'is an emergency stop', 'emergency_stop'],
  ['M851', 'changes the probe offset', 'probe_offset'],
  ['M301', 'changes the hotend PID values', 'pid_change'],
  ['M303', 'runs PID autotune', 'pid_change'],
  ['M304', 'changes the bed PID values', 'pid_change'],
  ['M306', 'changes the thermal model', 'pid_change'],
  ['PID_CALIBRATE', 'runs PID autotune', 'pid_change'],
  ['M92', 'changes steps per millimeter', 'steps_change'],
  ['M665', 'changes delta geometry', 'geometry_change'],
  ['M666', 'changes endstop or delta offsets', 'geometry_change'],
  ['M906', 'changes stepper motor current', 'motor_current'],
  ['M907', 'changes stepper motor current', 'motor_current'],
  ['M913', 'changes stepper motor sensitivity', 'motor_current'],
  ['M914', 'changes stepper motor sensitivity', 'motor_current'],
  ['M211', 'changes the software endstops', 'endstops'],
  ['M32', "starts a file on the printer's storage", 'sd_control'],
  ['M28', "writes a file to the printer's storage", 'sd_control'],
  ['M29', "writes a file to the printer's storage", 'sd_control'],
  ['M30', "deletes a file on the printer's storage", 'sd_control'],
  ...['M810', 'M811', 'M812', 'M813', 'M814', 'M815', 'M816', 'M817', 'M818', 'M819'].map((c): [string, string, string] => [c, 'runs a stored G-code macro', 'stored_macro']),
  ['RUN_SHELL_COMMAND', "runs a program on the printer's host", 'shell'],
  ['SHELL_COMMAND', "runs a program on the printer's host", 'shell'],
  ['SET_KINEMATIC_POSITION', 'overrides where the printer thinks it is', 'position_override'],
  ['SET_HEATER_PWM', 'drives a heater without a temperature control', 'heater_raw'],
  ['SET_PIN', 'drives a pin directly', 'pin_write'],
  ['M42', 'drives a pin directly', 'pin_write'],
  // RepRapFirmware: a file could lock the owner out or take the printer off the network.
  ['M551', "sets the printer's password", 'network_change'],
  ['M552', "changes the printer's network connection", 'network_change'],
  ['M553', "changes the printer's network mask", 'network_change'],
  ['M554', "changes the printer's network gateway", 'network_change'],
  ['M587', 'adds a Wi-Fi network to the printer', 'network_change'],
  ['M588', 'removes a Wi-Fi network from the printer', 'network_change'],
  ['M589', "changes the printer's access point", 'network_change'],
  ['M98', 'runs a macro file on the printer', 'macro_file'],
  ['M43', 'changes pin state', 'pin_write'],
]

/** Findings of DENIED that the makers' own start G-code uses: only warnings for trusted text. */
// Duet start G-code calls its own macros with `M98`, so a profile may too.
const MAKER_SETUP = new Set(['eeprom_write', 'eeprom_load', 'endstops', 'macro_file'])

const WARNED: [string, string, string][] = [
  ['M413', 'changes power loss recovery', 'power_loss'],
  ['M206', 'changes the home offset', 'home_offset'],
  ['M85', 'changes the inactivity shutdown timer', 'inactivity_timer'],
  ['M81', "turns the printer's power supply off", 'power_off'],
  ['M80', "turns the printer's power supply on", 'power_on'],
  ['M420', 'changes bed leveling state', 'leveling_state'],
  ['M290', 'changes baby stepping, which moves Z', 'babystep'],
  ['M710', 'changes the controller fan behavior', 'fan_control'],
  ['SET_GCODE_OFFSET', 'changes the Z offset', 'gcode_offset'],
  ['M0', 'stops the print until someone presses a button', 'hard_pause'],
  ['M1', 'stops the print until someone presses a button', 'hard_pause'],
  ['M226', 'waits for a pin', 'pin_wait'],
  ['M291', 'waits for a person to answer a message', 'prompt_wait'],
  ['M600', 'starts a filament change', 'filament_change'],
  ['M601', 'pauses the print', 'hard_pause'],
  ['PAUSE', 'pauses the print', 'hard_pause'],
  ['BED_MESH_CLEAR', 'clears the bed mesh', 'leveling_state'],
  ['SET_VELOCITY_LIMIT', 'changes speed limits', 'motion_limits'],
]

const END_MACROS = new Set(['PRINT_END', 'END_PRINT', 'END_GCODE', 'TURN_OFF_HEATERS', 'M81', 'M2'])

/** Warnings that block when the text is from an imported file. */
const WARN_BLOCKS_UNTRUSTED = new Set(['power_loss', 'home_offset', 'inactivity_timer', 'power_off', 'power_on', 'leveling_state', 'gcode_offset'])

/** Codes about the section as a whole rather than one line. */
export const SECTION_CODES: ReadonlySet<string> = new Set(['leaves_relative_xyz', 'leaves_absolute_extruder', 'end_leaves_heaters_on', 'end_leaves_bed_on'])

/** A placeholder in a template, which stands for a value only known when the file is written. */
const UNKNOWN = '\u0000'

interface Words {
  cmd: string
  params: [string, string][]
}

function parseLine(raw: string): Words | undefined {
  const code = (raw.split(';')[0] ?? '').trim()
  if (!code) return undefined
  const it = code.split(/[ \t\n\r\f\v]+/)
  let first = it.shift()
  if (first === undefined) return undefined
  let cmd = first.toUpperCase()
  // "N123 G1 ..." line numbers and "*57" checksums.
  if (cmd.length > 1 && cmd.startsWith('N') && /^\d+$/.test(cmd.slice(1))) {
    first = it.shift()
    if (first === undefined) return undefined
    cmd = first.toUpperCase()
  }
  const star = cmd.indexOf('*')
  if (star >= 0) cmd = cmd.slice(0, star)
  const params: [string, string][] = []
  for (const w of it) {
    const eq = w.indexOf('=')
    if (eq >= 0) {
      params.push([w.slice(0, eq).toUpperCase(), w.slice(eq + 1)])
      continue
    }
    const k = String.fromCodePoint(w.codePointAt(0)!)
    // A trailing "*57" is a line checksum.
    params.push([k.toUpperCase(), (w.slice(k.length).split('*')[0] ?? '')])
  }
  return { cmd, params }
}

const param = (w: Words, key: string): string | undefined => w.params.find(([k]) => k === key)?.[1]
const has = (w: Words, key: string): boolean => w.params.some(([k]) => k === key)

/** Rust's `str::parse::<f64>` on a trimmed value: plain decimal numbers, `inf` and `nan` only. */
function number(w: Words, key: string): number | undefined {
  const v = param(w, key)?.trim()
  if (v === undefined || v.includes(UNKNOWN)) return undefined
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return Number(v)
  if (/^[+-]?(inf|infinity)$/i.test(v)) return v.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/i.test(v)) return NaN
  return undefined
}

/** True when the line still has a `[name]` that looks like a placeholder. */
function unrendered(code: string): boolean {
  return /\[[A-Za-z_][A-Za-z0-9_]*\]/.test(code)
}

/** A template line with each placeholder replaced by a value nobody knows yet. */
function withUnknowns(code: string): string {
  let s = code
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(/\{[^{}]*\}/g, UNKNOWN)
  }
  return s.replace(/\[[A-Za-z_][A-Za-z0-9_]*\]/g, UNKNOWN).replace(/[{}]/g, UNKNOWN)
}

/** Lints one section of G-code text. Rendered text unless `template` is set. */
export function lintGcode(text: string, section: LintSection, trust: LintTrust, limits: LintLimits = {}, opts: { template?: boolean } = {}): LintFinding[] {
  const out: LintFinding[] = []
  const nozzleMax = limits.nozzleMaxC ?? FALLBACK_NOZZLE_C
  const bedMax = limits.bedMaxC ?? FALLBACK_BED_C
  const chamberMax = limits.chamberMaxC ?? FALLBACK_CHAMBER_C
  const push = (line: number, code: string, severity: LintSeverity, message: string): void => {
    // Untrusted text: what would only need a yes from the person's own file blocks here.
    const s = trust === 'untrusted' && severity === 'warning' && WARN_BLOCKS_UNTRUSTED.has(code) ? 'error' : severity
    out.push({ line, code, severity: s, message })
  }
  const template = opts.template === true
  let absXyz = true
  let relE: boolean | undefined
  let heatersOff = false
  let bedOff = false
  let macroEnd = false
  // Rust's `str::lines`: a final line break ends the last line instead of starting another.
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  if (text === '') lines.length = 0
  let lineNo = 0
  for (const rawLine of lines) {
    lineNo++
    let raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const codePart = raw.split(';')[0] ?? ''
    if (unrendered(codePart) || codePart.includes('{') || codePart.includes('}')) {
      if (!template) {
        push(lineNo, 'unrendered_placeholder', 'error', 'has a placeholder that was not filled in')
        continue
      }
      raw = withUnknowns(codePart)
    }
    const w = parseLine(template ? raw.replace(/^[\s\u0000]+/, '') : raw)
    // `{if a}M500{endif}`: the command is what comes before the next placeholder.
    if (w && template) w.cmd = w.cmd.split(UNKNOWN)[0] ?? ''
    if (!w || !w.cmd) continue
    const cmd = w.cmd
    const denied = DENIED.find(([c]) => c === cmd)
    if (denied) {
      // A maker's own start and layer G-code sets up its printer with these; the person who trusts the text sees
      // them as warnings, imported text still stops on them.
      const severity = trust === 'trusted' && MAKER_SETUP.has(denied[2]) ? 'warning' : 'error'
      push(lineNo, denied[2], severity, `${cmd} ${denied[1]}`)
      continue
    }
    const warned = WARNED.find(([c]) => c === cmd)
    if (warned) {
      const expected = (['M600', 'M601', 'PAUSE', 'M0', 'M1', 'M291'].includes(cmd) && ['pause', 'other', 'toolChange'].includes(section)) || (cmd === 'M81' && section === 'end')
      if (!expected) push(lineNo, warned[2], 'warning', `${cmd} ${warned[1]}`)
    }
    if (END_MACROS.has(cmd) && section === 'end') macroEnd = true
    // In a template a value left to a placeholder still counts as a target.
    const target = (...keys: string[]): boolean => template && keys.some((k) => has(w, k) && param(w, k)!.includes(UNKNOWN))
    switch (cmd) {
      case 'M104':
      case 'M109': {
        const t = number(w, 'S') ?? number(w, 'R')
        if (t !== undefined && t > nozzleMax) push(lineNo, 'nozzle_over_limit', 'error', `${cmd} sets the nozzle to ${fmt(t)} C, above the limit of ${fmt(nozzleMax)} C`)
        else if (t !== undefined && t < 0) push(lineNo, 'negative_target', 'error', `${cmd} has a negative temperature`)
        else if (t !== undefined) {
          if (t === 0 && cmd === 'M104') heatersOff = true
          if (limits.nozzleMaxC === undefined && t > 300) push(lineNo, 'nozzle_limit_unknown', 'warning', `${cmd} sets ${fmt(t)} C and the printer's limit is not known`)
        } else if (cmd === 'M109' && !target('S', 'R')) push(lineNo, 'wait_without_target', 'error', 'M109 waits with no S or R target')
        break
      }
      // Bambu's H2C writes the bed target as `D` (its start G-code: `M190 D[bed_temperature_initial_layer_single]`).
      case 'M140':
      case 'M190': {
        const t = number(w, 'S') ?? number(w, 'R') ?? number(w, 'D')
        if (t !== undefined && t > bedMax) push(lineNo, 'bed_over_limit', 'error', `${cmd} sets the bed to ${fmt(t)} C, above the limit of ${fmt(bedMax)} C`)
        else if (t !== undefined && t < 0) push(lineNo, 'negative_target', 'error', `${cmd} has a negative temperature`)
        else if (t !== undefined) {
          if (t === 0 && cmd === 'M140') bedOff = true
        } else if (cmd === 'M190' && !target('S', 'R', 'D')) push(lineNo, 'wait_without_target', 'error', 'M190 waits with no S or R target')
        break
      }
      case 'M141':
      case 'M191': {
        const t = number(w, 'S') ?? number(w, 'R')
        if (t !== undefined && t > chamberMax) push(lineNo, 'chamber_over_limit', 'error', `${cmd} sets the chamber to ${fmt(t)} C, above the limit of ${fmt(chamberMax)} C`)
        else if (t === undefined && cmd === 'M191' && !target('S', 'R')) push(lineNo, 'wait_without_target', 'error', 'M191 waits with no S or R target')
        break
      }
      case 'SET_HEATER_TEMPERATURE': {
        const heater = (param(w, 'HEATER') ?? '').toLowerCase()
        const t = number(w, 'TARGET')
        const cap = heater.includes('bed') ? bedMax : heater.includes('chamber') || heater.includes('cavity') ? chamberMax : nozzleMax
        if (t !== undefined && t > cap) push(lineNo, 'heater_over_limit', 'error', `SET_HEATER_TEMPERATURE sets ${heater} to ${fmt(t)} C, above ${fmt(cap)} C`)
        else if (t === 0) {
          if (heater.includes('bed')) bedOff = true
          else if (!heater.includes('chamber')) heatersOff = true
        }
        break
      }
      case 'TEMPERATURE_WAIT':
        if (!has(w, 'MINIMUM') && !has(w, 'MAXIMUM')) push(lineNo, 'wait_without_target', 'error', 'TEMPERATURE_WAIT has no MINIMUM or MAXIMUM')
        break
      case 'M106': {
        const s = number(w, 'S')
        if (s !== undefined && !(s >= 0 && s <= 255)) push(lineNo, 'fan_out_of_range', 'error', `M106 sets the fan to ${fmt(s)}, outside 0 to 255`)
        break
      }
      case 'M302': {
        // Lowering the cold extrusion limit a little is common; turning it off is not.
        const s = number(w, 'S')
        const p = number(w, 'P')
        const safe = s !== undefined && s >= 150 && (p === undefined || p === 0)
        if (!safe) push(lineNo, 'cold_extrusion', 'error', `${cmd} allows extruding below 150 C`)
        break
      }
      case 'M84':
      case 'M18': {
        // `M84 E` frees the extruder motor only, which is common before homing.
        const axes = has(w, 'X') || has(w, 'Y') || has(w, 'Z') || w.params.every(([k]) => k !== 'E')
        if (axes && section !== 'end' && section !== 'pause') {
          // A maker's start sequence frees the motors to home or level; the person who trusts it sees a warning.
          const severity = trust === 'trusted' && section === 'start' ? 'warning' : 'error'
          push(lineNo, 'motors_off', severity, `${cmd} turns the motors off before the print ends`)
        }
        break
      }
      case 'G28':
        if (section === 'layerChange' || section === 'toolChange') push(lineNo, 'home_mid_print', 'error', 'G28 homes the printer in the middle of a print')
        break
      case 'G92':
        if ((has(w, 'X') || has(w, 'Y') || has(w, 'Z')) && section !== 'start') push(lineNo, 'position_override', 'error', "G92 moves the printer's idea of X, Y or Z during the print")
        break
      case 'G91':
        absXyz = false
        break
      case 'G90':
        absXyz = true
        break
      case 'M82':
        relE = false
        break
      case 'M83':
        relE = true
        break
    }
  }
  const last = Math.max(lineNo, 1)
  // The engine writes G90 and M83 after a start sequence, so only the sections between moves must restore them.
  if (!absXyz && section !== 'start') push(last, 'leaves_relative_xyz', 'error', 'ends in relative XYZ mode (G91) without G90')
  if (section !== 'start' && section !== 'end' && relE === false) push(last, 'leaves_absolute_extruder', 'error', 'switches the extruder to absolute mode (M82) without M83 again')
  if (section === 'end' && !macroEnd) {
    // A hot nozzle left over is the hazard; a warm bed is common in stock profiles.
    if (!heatersOff) push(last, 'end_leaves_heaters_on', 'error', 'the end G-code does not turn the nozzle heater off')
    else if (!bedOff) push(last, 'end_leaves_bed_on', 'warning', 'the end G-code leaves the bed heater on')
  }
  return out
}

/** A number as Rust's `{}` prints an f64: no trailing `.0` difference for whole values. */
function fmt(n: number): string {
  return Number.isFinite(n) ? String(n) : n > 0 ? 'inf' : n < 0 ? '-inf' : 'NaN'
}
