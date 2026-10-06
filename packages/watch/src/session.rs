// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Hub events in, hub calls out, as JSON. The network client feeds [`Session::on_event`] every
//! event the hub sends and makes the calls it returns ([`Out`]).
use std::collections::{BTreeMap, HashMap};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

use crate::change::{PLATE_H, PLATE_W, Thumb};
use crate::decode::{DecodeError, Rgb, decode};
use crate::detector::Detector;
use crate::mask::Mask;
use crate::policy::{Config, Policy, Seen, Verdict};
use crate::protocol::{Dismissed, Frame, Kind, Picture, PlateCheck, PlateResult, Report};
use crate::quality::{Quality, assess};
use crate::resize::crop;

/// Counts of what happened to frames, for logs and the status page.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Counts {
    /// Frames received.
    pub frames: u64,
    /// Scored by the detector.
    pub scored: u64,
    /// Skipped as too dark, too bright or blurred.
    pub poor: u64,
    /// In a format there is no decoder for, or corrupt.
    pub undecodable: u64,
    /// Not looked at: first layers or just after a resume.
    pub quiet: u64,
    /// Findings reported.
    pub reports: u64,
}

/// A call the session asks the client to make.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// `watch.report`.
    Report(Report),
    /// `watch.grab {printerId}`: one more frame of this printer now, fed back in as a frame.
    Grab(String),
    /// `watch.plateResult`.
    Plate(PlateResult),
}

impl Out {
    /// The report, when this is one.
    pub fn report(self) -> Option<Report> {
        match self {
            Out::Report(r) => Some(r),
            Out::Grab(_) | Out::Plate(_) => None,
        }
    }
}

/// The plate check finds a spot at least this many pixels of the 256 by 192 plate thumbnail.
const SPOT_PIXELS: usize = 4;
/// Without an empty-plate picture, the model alone blocks only when it is this sure. A clean
/// plate scored 0.70 and plates with a part or scraps 0.83 to 0.94 on public pictures, so the
/// model is a fallback; the person's own empty-plate picture is what the check relies on.
const DEBRIS_ALONE: f64 = 0.9;
/// A second look at a possible hand at most this often per printer, ms.
const LOOK_AGAIN_MS: u64 = 1500;

/// The watch for one hub connection.
pub struct Session<D: Detector> {
    detector: D,
    policy: Policy,
    masks: HashMap<String, Mask>,
    counts: Counts,
    /// Per printer: the bed area's thumbnail of the last scored frame and when it was taken.
    thumbs: HashMap<String, (u64, Thumb)>,
    /// Per printer: the last scored frame as received (type and bytes), for a confirmation.
    /// Kept in memory only, replaced by the next frame.
    latest: HashMap<String, (String, Vec<u8>)>,
    /// Per printer: when the last second look was asked for.
    looked: HashMap<String, u64>,
}

/// Milliseconds since the epoch from an ISO 8601 UTC time (`2026-10-01T20:00:00.000Z`).
fn iso_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(bytes.get(range)?).ok()?.parse().ok()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = if bytes.get(19) == Some(&b'.') {
        num(20..23).unwrap_or(0)
    } else {
        0
    };
    // Days from civil (Howard Hinnant's algorithm).
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let yoe = shifted - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis).ok()
}

impl<D: Detector> Session<D> {
    /// A session with this detector and policy.
    pub fn new(detector: D, config: Config) -> Self {
        Self {
            detector,
            policy: Policy::new(config),
            masks: HashMap::new(),
            counts: Counts::default(),
            thumbs: HashMap::new(),
            latest: HashMap::new(),
            looked: HashMap::new(),
        }
    }

    /// The last scored frame of a printer (content type and bytes), the one a confirmation
    /// looks at.
    pub fn latest_frame(&self, printer: &str) -> Option<(&str, &[u8])> {
        self.latest.get(printer).map(|(t, b)| (t.as_str(), b.as_slice()))
    }

    /// Sets a printer's bed mask (hub setting `watchMask`).
    pub fn set_mask(&mut self, printer: &str, mask: Mask) {
        self.masks.insert(printer.to_owned(), mask);
    }

    /// What happened so far.
    pub fn counts(&self) -> &Counts {
        &self.counts
    }

    /// One hub event (`{event, data}`). Returns the calls to make.
    pub fn on_event(&mut self, msg: &Value) -> Vec<Out> {
        let data = msg.get("data").cloned().unwrap_or(Value::Null);
        match msg.get("event").and_then(Value::as_str) {
            Some("watch.frame") => serde_json::from_value::<Frame>(data)
                .map(|f| self.on_frame(&f))
                .unwrap_or_default(),
            Some("watch.plate") => serde_json::from_value::<PlateCheck>(data)
                .map(|c| vec![Out::Plate(self.plate(&c))])
                .unwrap_or_default(),
            Some("watch.dismissed") => {
                if let Ok(d) = serde_json::from_value::<Dismissed>(data) {
                    self.policy.dismiss(&d.printer_id, d.kind);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// The plate before a print against the person's empty-plate picture: the largest patch
    /// that differs, outside the spots they said are fine. Without a picture to compare with,
    /// only the model's debris question, and only when it is very sure.
    pub fn plate(&self, c: &PlateCheck) -> PlateResult {
        let picture = |p: &Picture| -> Option<Rgb> {
            let bytes = B64.decode(&p.data_base64).ok()?;
            decode(&p.content_type, &bytes).ok()
        };
        let mut out = PlateResult {
            check_id: c.check_id.clone(),
            printer_id: c.printer_id.clone(),
            clear: None,
            bbox: None,
            debris: None,
            note: String::new(),
        };
        let Some(now) =
            picture(&c.frame).filter(|rgb| assess(&rgb.gray(), rgb.width, rgb.height) == Quality::Usable)
        else {
            out.note = "the camera picture was too dark, too bright or blurred to judge".into();
            return out;
        };
        let mask = self.masks.get(&c.printer_id).cloned().unwrap_or_else(Mask::whole);
        out.debris = self.detector.debris(&crop(&now, mask.bounds()));
        match c.reference.as_ref().and_then(picture) {
            Some(empty) if (empty.width, empty.height) == (now.width, now.height) => {
                let a = Thumb::sized(&now, &mask, PLATE_W, PLATE_H);
                let b = Thumb::sized(&empty, &mask, PLATE_W, PLATE_H);
                let spot = a.spot(&b, &c.ignore, SPOT_PIXELS);
                out.clear = Some(spot.is_none());
                out.note = match &spot {
                    Some(s) => format!(
                        "differs from the empty plate in one spot ({:.1} % of the plate)",
                        s.share * 100.0
                    ),
                    None => "matches the empty plate".into(),
                };
                out.bbox = spot.map(|s| s.bbox);
            }
            reference => {
                let found = out.debris.is_some_and(|d| d >= DEBRIS_ALONE);
                out.clear = Some(!found);
                out.note = match (reference.is_some(), found) {
                    (true, _) => {
                        "the empty-plate picture is a different size, so only the model looked".into()
                    }
                    (false, true) => {
                        "no empty-plate picture yet; the model sees something on the plate".into()
                    }
                    (false, false) => {
                        "no empty-plate picture yet; the model sees nothing on the plate".into()
                    }
                };
            }
        }
        out
    }

    fn on_frame(&mut self, f: &Frame) -> Vec<Out> {
        self.counts.frames += 1;
        if f.state.as_deref().is_some_and(|s| s != "printing") {
            return Vec::new();
        }
        let Some(now) = iso_ms(&f.captured_at) else {
            return Vec::new();
        };
        let bytes = B64.decode(&f.data_base64).map_err(|_| DecodeError::Corrupt);
        let mut hand_box = None;
        let seen = match bytes
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|b| decode(&f.content_type, b))
        {
            Err(_) => {
                self.counts.undecodable += 1;
                Seen::Skipped
            }
            Ok(rgb) if assess(&rgb.gray(), rgb.width, rgb.height) == Quality::Usable => {
                self.counts.scored += 1;
                let mask = self.masks.get(&f.printer_id).cloned().unwrap_or_else(Mask::whole);
                if let Ok(b) = bytes {
                    self.latest
                        .insert(f.printer_id.clone(), (f.content_type.clone(), b));
                }
                if self.detector.whole_image() {
                    let thumb = Thumb::of(&rgb, &mask);
                    let before = self
                        .thumbs
                        .get(&f.printer_id)
                        .filter(|(t, _)| now.saturating_sub(*t) <= self.policy.gap_ms())
                        .map(|(_, before)| before);
                    let change = before.map(|b| thumb.change(b));
                    // Where a hand would be: the patch that changed since the frame before.
                    hand_box = before.and_then(|b| thumb.spot(b, &[], 6)).map(|s| s.bbox);
                    self.thumbs.insert(f.printer_id.clone(), (now, thumb));
                    let area = crop(&rgb, mask.bounds());
                    let mut scores = BTreeMap::new();
                    for d in self.detector.detect(&area) {
                        let s = scores.entry(d.kind).or_insert(0.0_f64);
                        *s = s.max(d.score);
                    }
                    Seen::Relative { scores, change }
                } else {
                    let mut best = BTreeMap::new();
                    for d in self.detector.detect(&rgb) {
                        let (x, y) = d.center();
                        if mask.contains(x, y) {
                            let s = best.entry(d.kind).or_insert(0.0_f64);
                            *s = s.max(d.score);
                        }
                    }
                    Seen::Scored(best)
                }
            }
            Ok(_) => {
                self.counts.poor += 1;
                Seen::Skipped
            }
        };
        match self
            .policy
            .observe(&f.printer_id, now, f.layer, f.layer_count, seen)
        {
            Verdict::Finding {
                kind,
                confidence,
                agreed,
                of,
            } => {
                self.counts.reports += 1;
                vec![Out::Report(Report {
                    printer_id: f.printer_id.clone(),
                    kind,
                    confidence,
                    note: format!("{agreed} of the last {of} frames, {}", self.detector.name()),
                    confirmed: None,
                    bbox: if kind == Kind::Hand { hand_box } else { None },
                })]
            }
            Verdict::Quiet => {
                self.counts.quiet += 1;
                Vec::new()
            }
            Verdict::LookAgain => {
                let last = self.looked.get(&f.printer_id).copied();
                if last.is_some_and(|t| now.saturating_sub(t) < LOOK_AGAIN_MS) {
                    return Vec::new();
                }
                self.looked.insert(f.printer_id.clone(), now);
                vec![Out::Grab(f.printer_id.clone())]
            }
            Verdict::Skipped | Verdict::Watching => Vec::new(),
        }
    }
}

/// The `watch.report` call for a report.
pub fn report_call(r: &Report) -> Value {
    json!({ "method": "watch.report", "params": r })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::Rgb;
    use crate::detector::{Detection, Stub};
    use crate::protocol::Kind;

    /// Sees spaghetti at a fixed spot in every frame.
    struct Always(f64, [f64; 4]);
    impl Detector for Always {
        fn name(&self) -> &'static str {
            "always"
        }
        fn detect(&self, _: &Rgb) -> Vec<Detection> {
            vec![Detection {
                kind: Kind::Spaghetti,
                score: self.0,
                bbox: self.1,
            }]
        }
    }

    fn png(level_a: u8, level_b: u8) -> String {
        let (w, h) = (64u32, 48u32);
        let mut raw = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let v = if (x / 8 + y / 8) % 2 == 0 {
                    level_a
                } else {
                    level_b
                };
                raw.extend_from_slice(&[v, v, v]);
            }
        }
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, w, h);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            let mut wr = e.write_header().unwrap();
            wr.write_image_data(&raw).unwrap();
        }
        B64.encode(out)
    }

    fn frame(sec: u64, layer: u32, data: &str, kind: &str) -> Value {
        let (m, s) = (sec / 60, sec % 60);
        json!({ "event": "watch.frame", "data": {
            "subscription": 1, "printerId": "bay-1", "contentType": kind, "dataBase64": data,
            "capturedAt": format!("2026-10-01T20:{m:02}:{s:02}.000Z"), "source": "snapshot",
            "state": "printing", "layer": layer, "layerCount": 200
        } })
    }

    #[test]
    fn reads_iso_times() {
        assert_eq!(iso_ms("1970-01-01T00:00:01.250Z"), Some(1250));
        assert_eq!(
            iso_ms("2026-10-01T20:00:00.000Z").map(|t| t % 86_400_000),
            Some(72_000_000)
        );
    }

    #[test]
    fn reports_after_agreement_inside_the_mask() {
        let mut s = Session::new(Always(0.9, [0.4, 0.6, 0.5, 0.7]), Config::default());
        s.set_mask(
            "bay-1",
            Mask::new(vec![[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]),
        );
        let img = png(60, 200);
        let mut reports = Vec::new();
        // 0 s starts the print's quiet time; scoring begins at 30 s.
        for i in 0..7 {
            reports.extend(
                s.on_event(&frame(i * 10, 20, &img, "image/png"))
                    .into_iter()
                    .filter_map(Out::report),
            );
        }
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].kind, Kind::Spaghetti);
        assert!(reports[0].note.starts_with("3 of the last 5 frames, always"));
        let call = report_call(&reports[0]);
        assert_eq!(call["params"]["kind"], "spaghetti");
        assert_eq!(call["params"]["printerId"], "bay-1");
    }

    #[test]
    fn findings_outside_the_mask_never_count() {
        // The box sits in the purge chute at the top of the frame.
        let mut s = Session::new(Always(0.99, [0.0, 0.0, 0.1, 0.1]), Config::default());
        s.set_mask(
            "bay-1",
            Mask::new(vec![[0.0, 0.5], [1.0, 0.5], [1.0, 1.0], [0.0, 1.0]]),
        );
        let img = png(60, 200);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &img, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
    }

    #[test]
    fn dark_and_undecodable_frames_are_skipped_and_counted() {
        let mut s = Session::new(Always(0.99, [0.4, 0.6, 0.5, 0.7]), Config::default());
        let dark = png(3, 15);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &dark, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
        s.on_event(&frame(130, 20, "/9j/4AAQ", "image/jpeg"));
        assert_eq!(s.counts().undecodable, 1);
        assert!(s.counts().poor >= 8);
    }

    #[test]
    fn a_dismissal_from_the_hub_raises_the_bar() {
        let mut s = Session::new(Always(0.6, [0.4, 0.6, 0.5, 0.7]), Config::default());
        s.on_event(&json!({ "event": "watch.dismissed", "data": { "printerId": "bay-1", "kind": "spaghetti", "at": "2026-10-01T20:00:00.000Z" } }));
        let img = png(60, 200);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &img, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
    }

    /// Sees a hand in every frame at a fixed score, the way the SigLIP2 detector reports it.
    struct Hands(f64);
    impl Detector for Hands {
        fn name(&self) -> &'static str {
            "hands"
        }
        fn detect(&self, _: &Rgb) -> Vec<Detection> {
            vec![Detection {
                kind: Kind::Hand,
                score: self.0,
                bbox: [0.0, 0.0, 1.0, 1.0],
            }]
        }
        fn whole_image(&self) -> bool {
            true
        }
        fn debris(&self, _: &Rgb) -> Option<f64> {
            Some(self.0)
        }
    }

    #[test]
    fn a_hand_asks_for_a_second_look_then_reports_at_once() {
        let mut s = Session::new(Hands(0.9), Config::default());
        let img = png(60, 200);
        // The print's very first frame: no quiet time for a hand.
        let first = s.on_event(&frame(0, 1, &img, "image/png"));
        assert_eq!(first, vec![Out::Grab("bay-1".into())]);
        // The frame the grab brought back, 2 s later.
        let second = s.on_event(&frame(2, 1, &img, "image/png"));
        let r = second.into_iter().find_map(Out::report).expect("a hand report");
        assert_eq!(r.kind, Kind::Hand);
        assert!(r.note.starts_with("2 of the last 3 frames"), "{}", r.note);
        assert_eq!(report_call(&r)["params"]["kind"], "hand");
    }

    /// A PNG of a 320 by 240 frame drawn by `f`.
    fn picture(f: impl Fn(u32, u32) -> u8) -> String {
        let (w, h) = (320u32, 240u32);
        let mut raw = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let v = f(x, y);
                raw.extend_from_slice(&[v, v, v]);
            }
        }
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, w, h);
            e.set_color(png::ColorType::Rgb);
            e.set_depth(png::BitDepth::Eight);
            e.write_header().unwrap().write_image_data(&raw).unwrap();
        }
        B64.encode(out)
    }

    /// An empty plate with texture, so the quality check passes.
    fn plate(x: u32, y: u32) -> u8 {
        if (x / 16 + y / 16).is_multiple_of(2) {
            110
        } else {
            150
        }
    }

    fn plate_check(frame: &str, reference: Option<&str>, ignore: &Value) -> Value {
        let pic = |d: &str| json!({ "contentType": "image/png", "dataBase64": d });
        json!({ "event": "watch.plate", "data": {
            "checkId": "c1", "printerId": "bay-1", "frame": pic(frame),
            "reference": reference.map(pic), "ignore": ignore.clone(),
        } })
    }

    fn plate_result(s: &mut Session<impl Detector>, ev: &Value) -> PlateResult {
        match s.on_event(ev).pop() {
            Some(Out::Plate(r)) => r,
            o => panic!("expected a plate result, got {o:?}"),
        }
    }

    #[test]
    fn the_plate_check_finds_a_spot_against_the_empty_plate() {
        let mut session = Session::new(Stub, Config::default());
        let empty = picture(plate);
        let dirty = picture(|x, y| {
            if (200..206).contains(&x) && (170..176).contains(&y) {
                10
            } else {
                plate(x, y)
            }
        });
        let res = plate_result(&mut session, &plate_check(&empty, Some(&empty), &json!([])));
        assert_eq!(res.clear, Some(true), "{res:?}");
        let res = plate_result(&mut session, &plate_check(&dirty, Some(&empty), &json!([])));
        assert_eq!((res.clear, res.check_id.as_str()), (Some(false), "c1"), "{res:?}");
        let [left, top, right, bottom] = res.bbox.unwrap();
        assert!(
            left <= 200.0 / 320.0
                && right >= 206.0 / 320.0
                && top <= 170.0 / 240.0
                && bottom >= 176.0 / 240.0,
            "{res:?}"
        );
        // The person said that spot is a plate mark.
        let res = plate_result(
            &mut session,
            &plate_check(&dirty, Some(&empty), &json!([[0.6, 0.68, 0.67, 0.75]])),
        );
        assert_eq!(res.clear, Some(true), "{res:?}");
        // A picture too dark to judge never blocks.
        let dark = picture(|_, _| 4);
        assert_eq!(
            plate_result(&mut session, &plate_check(&dark, Some(&empty), &json!([]))).clear,
            None
        );
    }

    #[test]
    fn without_an_empty_plate_only_a_sure_model_blocks() {
        let empty = picture(plate);
        let r = plate_result(
            &mut Session::new(Hands(0.95), Config::default()),
            &plate_check(&empty, None, &json!([])),
        );
        assert_eq!((r.clear, r.debris), (Some(false), Some(0.95)), "{r:?}");
        let r = plate_result(
            &mut Session::new(Hands(0.8), Config::default()),
            &plate_check(&empty, None, &json!([])),
        );
        assert_eq!(r.clear, Some(true), "{r:?}");
        assert!(r.note.contains("no empty-plate picture"), "{r:?}");
    }

    #[test]
    fn the_stub_reports_nothing() {
        let mut s = Session::new(Stub, Config::default());
        let img = png(60, 200);
        let n: usize = (0..12)
            .map(|i| s.on_event(&frame(i * 10, 20, &img, "image/png")).len())
            .sum();
        assert_eq!(n, 0);
        assert!(s.counts().scored > 0);
    }
}
