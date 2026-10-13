// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Plain words for the printer problems Bambu Lab printers report most: filament runout, AMS, AMS
//! lite and AMS HT feed problems, the filament cutter, a clogged nozzle, heater and fan faults, an
//! open door, the build plate, the storage card, homing, and what first layer inspection and the
//! AI monitor find. The codes are the printer's own (as the Bambu Lab wiki lists them); the
//! wording is ours. Anything not here keeps the generic text and a link to the wiki page.
//!
//! An HMS code reads `AAAA_BBBB_CCCC_DDDD`: `AAAA` the module and its number (`07uu` is AMS unit
//! `uu`, `12uu` AMS lite unit `uu`, `18uu` AMS HT unit `uu`), `BBBB` the part (`2s00` and `7s00` are slot `s` of that unit), `CCCC` the severity and
//! `DDDD` the error. A print error reads `AAAA_EEEE` with the same module.

/// The wiki page for an HMS code (`0300_0100_0001_0001`) or a print error (`0300_4006`).
pub(crate) fn wiki_url(code: &str) -> String {
    format!("https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/{code}")
}

/// AMS unit letter and slot number from `07uu` (or an AMS lite's `12uu`) and `?s00`.
fn ams_slot(module: u16, part: u16) -> Option<(char, u16)> {
    let unit = module & 0xff;
    let slot = (part >> 8) & 0x0f;
    (unit <= 3 && slot <= 3).then(|| (char::from(b'A' + u8::try_from(unit).unwrap_or(0)), slot + 1))
}

/// Our text for an HMS code, when it is one of the common ones.
pub(crate) fn describe_hms(module: u16, part: u16, level: u16, error: u16) -> Option<String> {
    let text = match (module, part >> 8, level, error) {
        // Heated bed: heater or sensor shorted or open, overheating, control fault.
        (0x0300, 0x01, 0x0001, 0x0001..=0x0008 | 0x000A) => {
            "The heated bed is not holding its temperature: the printer found a heater or sensor fault and stopped heating. Let it cool, then check the bed cable and connector before printing again.".to_owned()
        }
        // Hotend: heater or sensor shorted or open, overheating, cannot reach the target.
        (0x0300, 0x02, 0x0001, 0x0001..=0x0009) => {
            "The nozzle is not holding its temperature: the printer found a hotend heater or sensor fault. Let it cool, check that the hotend is seated and its cable is plugged in, then try again.".to_owned()
        }
        (0x0300, 0x1A, 0x0002, 0x0002) | (0x0300, 0x09, 0x0002, 0x0001..=0x0005) => {
            "The nozzle looks clogged: the extruder is pushing much harder than normal. Heat the nozzle and clear it (a cold pull or the cleaning needle), or swap the hotend.".to_owned()
        }
        (0x0300, 0x1A, 0x0002, 0x0001) => {
            "Something is off where the nozzle meets the plate: filament built up around the nozzle, or a plate that is not lying flat. Look at both before you continue.".to_owned()
        }
        (0x0C00, 0x03, 0x0002, 0x000E | 0x001C) => {
            "The camera saw filament stuck around the nozzle. Check the nozzle and clean it before going on.".to_owned()
        }
        // Hotend cooling fan: stopped (fatal) or slow (serious).
        (0x0300, 0x03 | 0x17, 0x0001, 0x0001) | (0x0300, 0x03 | 0x17, 0x0002, 0x0002) => {
            "The fan that cools the hotend is not reaching its speed. Clear anything caught in it and check its cable: without that airflow the heatbreak runs hot and the nozzle can clog.".to_owned()
        }
        (0x0300, 0x04, 0x0002, 0x0001) | (0x0300, 0x31, 0x0001, 0x0001) | (0x0300, 0x31, 0x0002, 0x0002) => {
            "The part cooling fan is slow or stopped. Check it for debris and its cable.".to_owned()
        }
        (0x0300, 0x0D, 0x0002, 0x0003) | (0x0C00, 0x03, 0x0002, 0x000C) => {
            "The build plate may not be placed right. Seat it flat and aligned with the bed.".to_owned()
        }
        (0x0C00, 0x03, 0x0002, 0x0010) => {
            "The camera saw something on the bed. Clear the plate before printing.".to_owned()
        }
        (0x0500, 0x03, 0x0002, 0x000D) => {
            "The printer cannot read its SD card. Reseat the card, or format or replace it.".to_owned()
        }
        (0x0300, 0x96, 0x0001 | 0x0003, 0x0001) => {
            "The front door is open. Close it; for materials that need a warm chamber the print waits until it is shut.".to_owned()
        }
        (0x0C00, 0x03, 0x0003, 0x0007) => {
            "First layer inspection found possible defects. Look at the first layer before letting the print go on.".to_owned()
        }
        (0x0C00, 0x03, 0x0003, 0x0008 | 0x001B) => {
            "The camera saw what may be spaghetti (loose strands of filament). Check the print.".to_owned()
        }
        (0x07FF | 0x07FE, 0x20, 0x0002, 0x0001) => {
            "The external spool ran out of filament. Load a new spool, then resume.".to_owned()
        }
        (0x0700..=0x0703 | 0x1200..=0x1203, 0x20..=0x23, 0x0002 | 0x0003, 0x0001) => {
            let (unit, slot) = ams_slot(module, part)?;
            format!("AMS {unit} slot {slot} ran out of filament. Load a new spool in that slot (or one with the same filament), then resume.")
        }
        (0x0700..=0x0703, 0x20..=0x23, 0x0002, 0x0009) | (0x1200..=0x1203, 0x20..=0x23, 0x0002, 0x0006) => {
            let (unit, slot) = ams_slot(module, part)?;
            format!("The filament from AMS {unit} slot {slot} would not extrude. The nozzle may be clogged or the filament tangled; check both, then retry.")
        }
        (0x0700..=0x0703, 0x70..=0x73, 0x0002, 0x0002 | 0x0005) => {
            let (unit, slot) = ams_slot(module, part)?;
            format!("AMS {unit} slot {slot} could not feed its filament to the toolhead. Cut the filament end square, check the tube for a snag or broken piece, then retry.")
        }
        (0x0700..=0x0703, 0x70..=0x73, 0x0002, 0x0001 | 0x0004) => {
            let (unit, slot) = ams_slot(module, part)?;
            format!("AMS {unit} slot {slot} could not pull its filament back. The spool may be stuck or tangled, or the filament broke in the toolhead; free it, then retry.")
        }
        _ => return None,
    };
    Some(text)
}

/// Our text for a print error (`print_error`), when it is one of the common ones.
pub(crate) fn describe_print_error(module: u16, error: u16) -> Option<String> {
    let text = match (module, error) {
        (0x0300, 0x4006 | 0x8016 | 0x801C) => {
            "The nozzle looks clogged. Heat the nozzle and clear it (a cold pull or the cleaning needle), or swap the hotend, then print again."
        }
        (0x0300, 0x800F | 0x8042) => "The print paused because the door is open. Close it and resume.",
        (0x0300, 0x404B) => "The print stopped because the front door or the top cover was open.",
        (0x0300, 0x8002) | (0x0C00, 0x8001) => {
            "First layer inspection found possible defects and paused the print. Look at the first layer, then resume or cancel."
        }
        (0x0300, 0x8003) | (0x0C00, 0x8042) => {
            "The camera saw what may be spaghetti (loose strands of filament) and paused the print. Check it, then resume or cancel."
        }
        (0x0300, 0x8015) | (0x07FF, 0x8011) => {
            "The external spool ran out of filament. Load a new spool, then resume."
        }
        (0x0300, 0x8008 | 0x806E) => {
            "The nozzle is not holding its temperature. Let it cool, check that the hotend is seated and its cable is plugged in, then try again."
        }
        (0x0300, 0x806F) => {
            "The heated bed warmed up abnormally and the printer stopped heating it. Let it cool and check the bed cable before printing again."
        }
        (0x0700..=0x0703 | 0x1200..=0x1203 | 0x1800..=0x1807, 0x8003 | 0x8004) => {
            "The AMS could not pull the filament back. The spool may be stuck or tangled, or the filament broke in the toolhead; free it, then retry."
        }
        (0x0700..=0x0703 | 0x1200..=0x1203 | 0x1800..=0x1807, 0x8007) => {
            "The filament would not extrude. The nozzle may be clogged; check it, then retry."
        }
        (0x0700..=0x0707 | 0x1200..=0x1203 | 0x1800..=0x1807, 0x8006) => {
            "The AMS could not feed the filament into the toolhead. The filament may be tangled, the spool stuck or the tube loose; check them, then retry."
        }
        (0x0700..=0x0707 | 0x1200..=0x1203 | 0x12FF | 0x1800..=0x1807, 0x8010) => {
            "The AMS feed motor is straining. The filament may be tangled or the spool stuck; free it, then retry."
        }
        (0x1200..=0x1203 | 0x12FF | 0x1800..=0x1807, 0x8011) => {
            "The AMS ran out of filament. Load a new spool in the same slot, then resume."
        }
        (0x0700..=0x0703 | 0x07FE | 0x07FF | 0x1200..=0x1203 | 0x12FF, 0x8001) => {
            "The filament cutter did not cut the filament. Check the cutter, then retry."
        }
        (0x0700..=0x0703 | 0x07FE | 0x07FF | 0x1200..=0x1203 | 0x12FF, 0x8002) => {
            "The filament cutter is stuck. Make sure its handle is pulled out, then retry."
        }
        (0x0300, 0x4000 | 0x4030) => {
            "Homing the Z axis failed. Check that nothing blocks the bed or the toolhead, then try again."
        }
        (0x0300, 0x4009 | 0x4032) => {
            "Homing the X and Y axes failed. Check that nothing blocks the toolhead, then try again."
        }
        (0x0300, 0x4005 | 0x8010) => {
            "The fan that cools the hotend is not reaching its speed. Clear anything caught in it and check its cable: without that airflow the heatbreak runs hot and the nozzle can clog."
        }
        (0x0300, 0x8014) => {
            "Filament may have built up around the nozzle, or the plate is not in its place. Cancel the print, clean the nozzle or seat the plate again, then start over."
        }
        (0x0300, 0x8019) | (0x0500, 0x8061 | 0x4095) => {
            "No build plate is on the bed. Place it, then try again."
        }
        (0x0500, 0x8051) => {
            "The build plate on the bed is not the one the file was sliced for. Swap the plate or slice for this one."
        }
        (0x0C00, 0x8009) | (0x0500, 0x808C) => {
            "The printer could not find where the build plate sits. Align the plate with the bed, then go on."
        }
        (0x0300, 0x800E) | (0x0500, 0x8013) => {
            "The print file is no longer there. Check that the storage card is still in the printer."
        }
        (0x0500, 0x4006 | 0x4015) => {
            "The printer's storage is full. Delete files or format the card, then send the job again."
        }
        (0x0500, 0x400C) => "The printer has no SD card. Insert one, then send the job again.",
        (0x0500, 0x4016) => "The SD card is write protected. Replace it, then send the job again.",
        (0x0C00, 0x8005 | 0xC006) => {
            "Purged filament may have piled up at the waste chute. Clear it before going on."
        }
        _ => return None,
    };
    Some(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_common_codes_read_in_plain_words() {
        assert!(
            describe_hms(0x0700, 0x2000, 0x0002, 0x0001)
                .unwrap()
                .starts_with("AMS A slot 1 ran out")
        );
        assert!(
            describe_hms(0x0703, 0x2300, 0x0002, 0x0001)
                .unwrap()
                .starts_with("AMS D slot 4 ran out")
        );
        assert!(
            describe_hms(0x0701, 0x7200, 0x0002, 0x0002)
                .unwrap()
                .starts_with("AMS B slot 3 could not feed")
        );
        assert!(
            describe_hms(0x0300, 0x1A00, 0x0002, 0x0002)
                .unwrap()
                .contains("clogged")
        );
        assert!(
            describe_hms(0x0300, 0x0100, 0x0001, 0x0001)
                .unwrap()
                .starts_with("The heated bed")
        );
        assert!(
            describe_hms(0x0300, 0x0200, 0x0001, 0x0003)
                .unwrap()
                .starts_with("The nozzle is not holding")
        );
        assert!(
            describe_hms(0x0300, 0x9600, 0x0003, 0x0001)
                .unwrap()
                .contains("door is open")
        );
        assert!(
            describe_hms(0x0C00, 0x0300, 0x0003, 0x0007)
                .unwrap()
                .starts_with("First layer inspection")
        );
        assert!(
            describe_hms(0x07FF, 0x2000, 0x0002, 0x0001)
                .unwrap()
                .starts_with("The external spool")
        );
        assert_eq!(
            describe_hms(0x0300, 0x0100, 0x0001, 0x00FF),
            None,
            "an unknown code keeps the link"
        );
        assert_eq!(describe_hms(0x0780, 0x2000, 0x0002, 0x0001), None);
        assert!(describe_print_error(0x0300, 0x4006).unwrap().contains("clogged"));
        assert!(
            describe_print_error(0x0C00, 0x8001)
                .unwrap()
                .starts_with("First layer")
        );
        assert_eq!(describe_print_error(0x0300, 0x0001), None);
        assert_eq!(
            wiki_url("0300_4006"),
            "https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/0300_4006"
        );
    }

    #[test]
    fn ams_lite_ams_ht_plate_card_and_homing_codes_read_in_plain_words() {
        // An A1's AMS lite reports under module 12: runouts name the slot like an AMS.
        assert!(
            describe_hms(0x1200, 0x2100, 0x0002, 0x0001)
                .unwrap()
                .starts_with("AMS A slot 2 ran out")
        );
        assert!(
            describe_hms(0x1200, 0x2000, 0x0002, 0x0006)
                .unwrap()
                .contains("would not extrude")
        );
        assert!(
            describe_hms(0x0300, 0x0300, 0x0001, 0x0001)
                .unwrap()
                .starts_with("The fan that cools the hotend")
        );
        assert!(
            describe_hms(0x0300, 0x0D00, 0x0002, 0x0003)
                .unwrap()
                .contains("build plate")
        );
        assert!(
            describe_print_error(0x12FF, 0x8002)
                .unwrap()
                .contains("cutter is stuck")
        );
        assert!(describe_print_error(0x1800, 0x8011).unwrap().contains("ran out"));
        assert!(
            describe_print_error(0x0500, 0x400C)
                .unwrap()
                .contains("no SD card")
        );
        assert!(
            describe_print_error(0x0500, 0x8051)
                .unwrap()
                .contains("sliced for")
        );
        assert!(
            describe_print_error(0x0300, 0x4000)
                .unwrap()
                .starts_with("Homing the Z axis")
        );
        // A cutter code on a module without a cutter keeps the link.
        assert_eq!(describe_print_error(0x1800, 0x8001), None);
    }
}
