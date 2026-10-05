// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Merges intent goals (`knowledge/intents`) into one set of value changes, following
//! `knowledge/intents/tradeoffs.yaml`: core beats supporting, stated beats inferred, the pair rules say
//! who keeps which key, and every goal that loses a key is reported. `js/intent.ts` does the same.

// The comparisons mirror the TypeScript implementation, which compares plain numbers exactly.
#![allow(clippy::float_cmp)]

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value as Json;

use crate::knowledge::{GoalKnowledge, KChange, MaterialKnowledge, knowledge};
use crate::plan::{CalibrationResult, PlanAdvice, PlanCaveat, PlanIntent, SetupRef};
use crate::value::Scalar;

/// One value the goals ask for.
#[derive(Debug, Clone)]
pub struct IntentValue {
    pub value: Scalar,
    pub reason: String,
    pub src: Vec<String>,
    pub goal: String,
    pub priority: String,
}

pub struct IntentContext<'a> {
    pub to: &'a SetupRef,
    pub material: Option<&'a MaterialKnowledge>,
    /// The value a key has right now (pending plan value, base config or schema default), first entry of a list.
    pub scalar: &'a dyn Fn(&str) -> Option<Scalar>,
    pub calibrations: &'a [CalibrationResult],
}

#[derive(Debug, Default)]
pub struct IntentResult {
    pub values: BTreeMap<String, IntentValue>,
    pub tell_user: Vec<String>,
    pub advice: Vec<PlanAdvice>,
    pub caveats: Vec<PlanCaveat>,
    pub questions: Vec<String>,
    pub warnings: Vec<String>,
}

struct ActiveGoal {
    id: String,
    level: String,
    stated: bool,
    order: usize,
    k: &'static GoalKnowledge,
}

#[derive(Clone)]
struct Cand {
    uid: usize,
    goal: usize,
    change: KChange,
    value: Option<Scalar>,
}

const VASE_SKIP: [&str; 13] = [
    "seam_slope_type",
    "seam_position",
    "wall_sequence",
    "top_surface_pattern",
    "only_one_wall_top",
    "ironing_type",
    "ironing_flow",
    "ironing_spacing",
    "ironing_speed",
    "sparse_infill_pattern",
    "infill_combination",
    "alternate_extra_wall",
    "ensure_vertical_shell_thickness",
];

/// `Carbon fiber nylon (PA6-CF)` reads as `Carbon fiber nylon` in sentences.
#[must_use]
pub fn short_name(name: &str) -> &str {
    name.split(" (").next().unwrap_or(name)
}

pub(crate) fn snap(v: f64) -> f64 {
    (v * 1e9 + 0.5).floor() / 1e9
}

fn round_to(v: f64, r: Option<f64>) -> f64 {
    match r {
        Some(r) if r != 0.0 => snap((v / r + 0.5).floor() * r),
        _ => snap(v),
    }
}

fn json_scalar(j: &Json) -> Option<Scalar> {
    match j {
        Json::Number(n) => n.as_f64().map(Scalar::Num),
        Json::String(s) => Some(Scalar::Str(s.clone())),
        Json::Bool(b) => Some(Scalar::Bool(*b)),
        _ => None,
    }
}

fn level_changes(k: &GoalKnowledge, level: &str, depth: usize) -> Vec<KChange> {
    let Some(lv) = k.levels.get(level) else {
        return Vec::new();
    };
    if depth > 8 {
        return Vec::new();
    }
    let parent = lv
        .extends
        .as_deref()
        .map(|e| level_changes(k, e, depth + 1))
        .unwrap_or_default();
    let own: BTreeSet<&str> = lv.changes.iter().map(|c| c.key.as_str()).collect();
    let mut out: Vec<KChange> = parent
        .into_iter()
        .filter(|c| !own.contains(c.key.as_str()))
        .collect();
    out.extend(lv.changes.iter().cloned());
    out
}

fn resolve_value(c: &KChange, ctx: &IntentContext) -> Option<Scalar> {
    match c.op.as_str() {
        "enable" => return Some(Scalar::Bool(true)),
        "disable" => return Some(Scalar::Bool(false)),
        _ => {}
    }
    let Some(vf) = &c.value_from else {
        return c.value.as_ref().and_then(json_scalar);
    };
    if let Some(f) = vf.nozzle_factor {
        return Some(Scalar::Num(round_to(ctx.to.nozzle_diameter * f, vf.round_to)));
    }
    let paths = ctx.material.map(|m| &m.paths);
    if let Some(range) = &vf.filament_range {
        let lo = paths?.get(&format!("{range}.min"))?;
        let hi = paths?.get(&format!("{range}.max"))?;
        return Some(Scalar::Num(round_to(
            lo + vf.position.unwrap_or(0.5) * (hi - lo),
            vf.round_to,
        )));
    }
    if let Some(path) = &vf.filament {
        let v = paths?.get(path)?;
        return Some(Scalar::Num(snap(v * vf.factor.unwrap_or(1.0))));
    }
    if let Some(cal) = &vf.calibration {
        let found = ctx.calibrations.iter().find(|x| &x.id == cal)?;
        let v = found.values.get(vf.field.as_deref()?)?;
        return Some(Scalar::Num(snap(v * vf.factor.unwrap_or(1.0))));
    }
    None
}

fn rank_of(c: &Cand, goals: &[ActiveGoal]) -> f64 {
    let g = goals.get(c.goal);
    let core = if c.change.priority == "core" { 0.0 } else { 1.0 };
    let stated = if g.is_some_and(|g| g.stated) { 0.0 } else { 5.0 };
    #[allow(clippy::cast_precision_loss)]
    let order = g.map_or(0.0, |g| g.order as f64) / 100.0;
    core * 10.0 + stated + order
}

fn show(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation)]
        return (v as i64).to_string();
    }
    v.to_string()
}

fn scalar_text(s: Option<&Scalar>) -> String {
    match s {
        Some(Scalar::Num(n)) => show(*n),
        Some(Scalar::Str(s)) => s.clone(),
        Some(Scalar::Bool(b)) => b.to_string(),
        None => "undefined".to_owned(),
    }
}

fn describe(c: &Cand) -> String {
    let v = scalar_text(c.value.as_ref());
    match c.change.op.as_str() {
        "at_least" => format!("at least {v}"),
        "at_most" => format!("at most {v}"),
        "enable" => "on".to_owned(),
        "disable" => "off".to_owned(),
        "multiply" => format!("times {v}"),
        "increase_by" => format!("up by {v}"),
        "decrease_by" => format!("down by {v}"),
        _ => v,
    }
}

fn active_goals(intent: &PlanIntent, warnings: &mut Vec<String>) -> Vec<ActiveGoal> {
    let kb = knowledge();
    let mut out: Vec<ActiveGoal> = Vec::new();
    let mut add = |id: &str, level: Option<&str>, stated: bool, out: &mut Vec<ActiveGoal>| {
        if out.iter().any(|g| g.id == id) {
            return;
        }
        let Some(k) = kb.goals.get(id) else {
            warnings.push(format!("Unknown goal \"{id}\"."));
            return;
        };
        let first_level = k.levels.keys().next().map_or("standard", String::as_str);
        let mut lv = level
            .or(k.default_level.as_deref())
            .unwrap_or(first_level)
            .to_owned();
        if !k.levels.contains_key(&lv) {
            let fallback = k.default_level.as_deref().unwrap_or("standard").to_owned();
            warnings.push(format!(
                "{} has no level \"{}\"; using {}.",
                k.label, lv, fallback
            ));
            lv = fallback;
        }
        let order = out.len();
        out.push(ActiveGoal {
            id: id.to_owned(),
            level: lv,
            stated,
            order,
            k,
        });
    };
    for g in &intent.goals {
        add(&g.id, g.level.as_deref(), g.stated != Some(false), &mut out);
    }
    let implied: Vec<String> = out.iter().flat_map(|g| g.k.implies.clone()).collect();
    for imp in implied {
        add(&imp, None, false, &mut out);
    }
    out
}

/// Turn the goals into values. Keys the goals do not touch are absent from the result.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn merge_intent(intent: &PlanIntent, ctx: &IntentContext) -> IntentResult {
    let kb = knowledge();
    let mut res = IntentResult::default();
    let goals = active_goals(intent, &mut res.warnings);
    if goals.is_empty() {
        return res;
    }
    let ids: BTreeSet<&str> = goals.iter().map(|g| g.id.as_str()).collect();
    let mut cands: Vec<Cand> = Vec::new();
    let mut uid = 0;
    for (gi, g) in goals.iter().enumerate() {
        for change in level_changes(g.k, &g.level, 0) {
            let value = resolve_value(&change, ctx);
            cands.push(Cand {
                uid,
                goal: gi,
                change,
                value,
            });
            uid += 1;
        }
        if let Some(rule) = &g.k.cooling_rule
            && rule.applies_to.iter().any(|f| f == &ctx.to.filament)
        {
            let value = resolve_value(&rule.change, ctx);
            cands.push(Cand {
                uid,
                goal: gi,
                change: rule.change.clone(),
                value,
            });
            uid += 1;
        }
    }
    let mut live: Vec<Cand> = cands
        .into_iter()
        .filter(|c| c.value.is_some() || matches!(c.change.op.as_str(), "enable" | "disable"))
        .collect();

    for pair in &kb.pairs {
        let (Some(a), Some(b)) = (pair.goals.first(), pair.goals.get(1)) else {
            continue;
        };
        if !ids.contains(a.as_str()) || !ids.contains(b.as_str()) {
            continue;
        }
        if let Some(ask) = &pair.ask {
            res.questions.push(ask.clone());
        }
        if let Some(t) = &pair.tell_user {
            res.tell_user.push(t.clone());
        }
        for (key, keeper) in pair.keep.iter().flatten() {
            let mine: BTreeSet<usize> = live
                .iter()
                .filter(|c| {
                    c.change.key == *key && goals.get(c.goal).is_some_and(|g| g.id == *a || g.id == *b)
                })
                .map(|c| c.uid)
                .collect();
            if mine.is_empty() {
                continue;
            }
            if let Some(rest) = keeper.strip_prefix("compromise_") {
                let v: f64 = rest.replace('_', ".").parse().unwrap_or(f64::NAN);
                let first = live.iter().find(|c| mine.contains(&c.uid)).cloned();
                live.retain(|c| !mine.contains(&c.uid));
                if let Some(first) = first {
                    let mut change = first.change.clone();
                    "set".clone_into(&mut change.op);
                    "core".clone_into(&mut change.priority);
                    pair.resolution
                        .as_deref()
                        .unwrap_or("Middle ground between the goals.")
                        .trim()
                        .clone_into(&mut change.why);
                    change.value = serde_json::Number::from_f64(v).map(Json::Number);
                    change.value_from = None;
                    live.push(Cand {
                        uid,
                        goal: first.goal,
                        change,
                        value: Some(Scalar::Num(v)),
                    });
                    uid += 1;
                }
            } else {
                live.retain(|c| !mine.contains(&c.uid) || goals.get(c.goal).is_some_and(|g| g.id == *keeper));
            }
        }
    }
    if ids.contains("strength")
        && live.iter().any(|c| {
            c.change.key == "sparse_infill_pattern" && c.value == Some(Scalar::Str("lightning".to_owned()))
        })
    {
        live.retain(|c| {
            !(c.change.key == "sparse_infill_pattern" && c.value == Some(Scalar::Str("lightning".to_owned())))
        });
        res.tell_user
            .push("Lightning infill was dropped: it has no strength, and this part carries load.".to_owned());
    }

    let mut by_key: Vec<(String, Vec<Cand>)> = Vec::new();
    for c in live {
        match by_key.iter_mut().find(|(k, _)| *k == c.change.key) {
            Some((_, list)) => list.push(c),
            None => by_key.push((c.change.key.clone(), vec![c])),
        }
    }
    for (key, list) in &by_key {
        let mut ranked: Vec<&Cand> = list.iter().collect();
        ranked.sort_by(|x, y| {
            rank_of(x, &goals)
                .partial_cmp(&rank_of(y, &goals))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let cur = (ctx.scalar)(key);
        let mut value: Option<Scalar> = cur.clone();
        let mut lo = f64::NEG_INFINITY;
        let mut hi = f64::INFINITY;
        let mut set_done = false;
        let mut credit: Option<&Cand> = None;
        let lose = |c: &Cand, winner: Option<&Cand>, tell: &mut Vec<String>| {
            if let Some(w) = winner
                && let (Some(cg), Some(wg)) = (goals.get(c.goal), goals.get(w.goal))
                && cg.id != wg.id
            {
                tell.push(format!(
                    "{} wanted {} {}; {} takes priority.",
                    cg.k.label,
                    key,
                    describe(c),
                    wg.k.label
                ));
            }
        };
        for c in &ranked {
            let v = c.value.clone();
            let num = match (&value, &cur) {
                (Some(Scalar::Num(n)), _) | (_, Some(Scalar::Num(n))) => *n,
                _ => 0.0,
            };
            let vnum = if let Some(Scalar::Num(n)) = &v {
                Some(*n)
            } else {
                None
            };
            match c.change.op.as_str() {
                "set" | "enable" | "disable" => {
                    if vnum.is_some_and(|n| n < lo || n > hi) {
                        lose(c, credit, &mut res.tell_user);
                    } else if !set_done {
                        value = v;
                        set_done = true;
                        credit = Some(c);
                    } else if v != value {
                        lose(c, credit, &mut res.tell_user);
                    }
                }
                "at_least" => {
                    if let Some(n) = vnum {
                        let cur_value_lower = set_done && matches!(&value, Some(Scalar::Num(x)) if *x < n);
                        if n > hi || cur_value_lower {
                            lose(c, credit, &mut res.tell_user);
                        } else {
                            lo = lo.max(n);
                            credit = credit.or(Some(c));
                        }
                    }
                }
                "at_most" => {
                    if let Some(n) = vnum {
                        let cur_value_higher = set_done && matches!(&value, Some(Scalar::Num(x)) if *x > n);
                        if n < lo || cur_value_higher {
                            lose(c, credit, &mut res.tell_user);
                        } else {
                            hi = hi.min(n);
                            credit = credit.or(Some(c));
                        }
                    }
                }
                "increase_by" => {
                    if let Some(n) = vnum {
                        value = Some(Scalar::Num(snap(num + n)));
                        credit = Some(c);
                    }
                }
                "decrease_by" => {
                    if let Some(n) = vnum {
                        value = Some(Scalar::Num(snap(num - n)));
                        credit = Some(c);
                    }
                }
                "multiply" => {
                    if let Some(n) = vnum {
                        value = Some(Scalar::Num(snap(num * n)));
                        credit = Some(c);
                    }
                }
                _ => {}
            }
        }
        let bounded = lo > f64::NEG_INFINITY || hi < f64::INFINITY;
        if !matches!(value, Some(Scalar::Num(_))) && bounded && !matches!(cur, Some(Scalar::Num(_))) {
            value = Some(Scalar::Num(if lo > f64::NEG_INFINITY { lo } else { hi }));
        }
        if let Some(Scalar::Num(n)) = value
            && lo <= hi
        {
            let clamped = n.max(lo).min(hi);
            if clamped != n {
                value = Some(Scalar::Num(clamped));
                credit = ranked
                    .iter()
                    .find(|c| {
                        let v = if let Some(Scalar::Num(x)) = &c.value {
                            Some(*x)
                        } else {
                            None
                        };
                        (c.change.op == "at_least" && v == Some(lo))
                            || (c.change.op == "at_most" && v == Some(hi))
                    })
                    .copied()
                    .or(credit);
            }
        }
        let (Some(value), Some(credit)) = (value, credit) else {
            continue;
        };
        let goal = goals.get(credit.goal).map(|g| g.id.clone()).unwrap_or_default();
        res.values.insert(
            key.clone(),
            IntentValue {
                value,
                reason: credit.change.why.clone(),
                src: credit.change.src.clone(),
                goal,
                priority: credit.change.priority.clone(),
            },
        );
    }

    if res
        .values
        .get("sparse_infill_pattern")
        .is_some_and(|v| v.value == Scalar::Str("lightning".to_owned()))
    {
        res.tell_user
            .push("Lightning infill has no strength; it only holds up the top skin.".to_owned());
    }

    let spiral = res
        .values
        .get("spiral_mode")
        .map(|v| v.value.clone())
        .or_else(|| (ctx.scalar)("spiral_mode"));
    if spiral == Some(Scalar::Bool(true)) && goals.iter().any(|g| g.id == "vase") {
        let mut dropped: Vec<&str> = Vec::new();
        for key in VASE_SKIP {
            if res.values.get(key).is_some_and(|v| v.goal != "vase") {
                res.values.remove(key);
                dropped.push(key);
            }
        }
        if res.values.get("wall_loops").is_some_and(|v| v.goal != "vase") {
            res.values.remove("wall_loops");
        }
        if !dropped.is_empty() {
            res.tell_user.push(format!(
                "Skipped {}: they do not apply in vase mode.",
                dropped.join(", ")
            ));
        }
    }

    for g in &goals {
        let k = g.k;
        if k.always_show_caveats || !k.caveats.is_empty() {
            for c in &k.caveats {
                res.caveats.push(PlanCaveat {
                    text: c.text.clone(),
                    sources: c.src.clone(),
                });
            }
        }
        for a in &k.advice {
            res.advice.push(PlanAdvice {
                text: a.text.clone(),
                kind: a.kind.clone(),
                sources: a.src.clone(),
            });
        }
        for c in &k.constraints {
            res.advice.push(PlanAdvice {
                text: c.text.clone(),
                kind: "workflow".to_owned(),
                sources: c.src.clone(),
            });
        }
        for t in &k.checks {
            res.advice.push(PlanAdvice {
                text: t.clone(),
                kind: "workflow".to_owned(),
                sources: Vec::new(),
            });
        }
        if let Some(note) = k.material_notes.as_ref().and_then(|n| n.get(&ctx.to.filament)) {
            res.advice.push(PlanAdvice {
                text: note.clone(),
                kind: "material".to_owned(),
                sources: k.src.clone(),
            });
        }
        let h = &k.material_hints;
        let mat = short_name(ctx.material.map_or(ctx.to.filament.as_str(), |m| m.name.as_str())).to_owned();
        let has = |l: &Option<Vec<String>>| l.as_ref().is_some_and(|v| v.contains(&ctx.to.filament));
        let note = h.note.clone().unwrap_or_default();
        if has(&h.avoid) {
            res.warnings.push(
                format!("{} is a poor fit for {}. {}", mat, k.label.to_lowercase(), note)
                    .trim()
                    .to_owned(),
            );
        } else if let Some(prefer) = h.prefer.as_ref().filter(|p| !p.is_empty())
            && !prefer.contains(&ctx.to.filament)
            && !has(&h.acceptable)
        {
            let names: Vec<String> = prefer
                .iter()
                .map(|id| {
                    short_name(kb.materials.get(id).map_or(id.as_str(), |m| m.name.as_str())).to_owned()
                })
                .collect();
            res.advice.push(PlanAdvice {
                text: format!(
                    "For {} consider {} instead of {}. {}",
                    k.label.to_lowercase(),
                    names.join(", "),
                    mat,
                    note
                )
                .trim()
                .to_owned(),
                kind: "material".to_owned(),
                sources: k.src.clone(),
            });
        }
        if g.id == "detail" && ctx.to.nozzle_diameter >= 0.4 {
            res.questions
                .push("Is a 0.2 mm nozzle available? It resolves much finer detail than 0.4 mm.".to_owned());
        }
    }
    res
}
