// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Plain words for the printer problems Bambu Lab printers report most: filament runout, AMS feed
//! problems, a clogged nozzle, heater faults, an open door, and what first layer inspection and
//! the AI monitor find. The codes are the printer's own (as the Bambu Lab wiki lists them); the
//! wording is ours. Anything not here keeps the generic text and a link to the wiki page.
//!
//! An HMS code reads `AAAA_BBBB_CCCC_DDDD`: `AAAA` the module and its number (`07uu` is AMS unit
//! `uu`), `BBBB` the part (`2s00` and `7s00` are slot `s` of that unit), `CCCC` the severity and
//! `DDDD` the error. A print error reads `AAAA_EEEE` with the same module.

/// The wiki page for an HMS code (`0300_0100_0001_0001`) or a print error (`0300_4006`).
pub(crate) fn wiki_url(code: &str) -> String {
    format!("https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/{code}")
}

/// AMS unit letter and slot number from `07uu` and `?s00`.
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
        (0x0700..=0x0703, 0x20..=0x23, 0x0002 | 0x0003, 0x0001) => {
            let (unit, slot) = ams_slot(module, part)?;
            format!("AMS {unit} slot {slot} ran out of filament. Load a new spool in that slot (or one with the same filament), then resume.")
        }
        (0x0700..=0x0703, 0x20..=0x23, 0x0002, 0x0009) => {
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
        (0x0700..=0x0703, 0x8003 | 0x8004) => {
            "The AMS could not pull the filament back. The spool may be stuck or tangled, or the filament broke in the toolhead; free it, then retry."
        }
        (0x0700..=0x0703, 0x8007) => {
            "The filament would not extrude. The nozzle may be clogged; check it, then retry."
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
}
