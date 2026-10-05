// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Interpreter for `easy-map.json`. `js/easy.ts` implements the same ops; both pass
//! `fixtures/easy-cases.json`.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::schema::{SettingType, setting_def};
use crate::value::{PrintConfig, Scalar, Value};

/// The stored Speed names. The old names (`silent`, `standard`, `sport`, `ludicrous`) are still read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeedPreset {
    #[serde(alias = "silent", alias = "gentle")]
    Quality,
    #[serde(alias = "standard")]
    Balanced,
    #[serde(alias = "sport")]
    Fast,
    #[serde(alias = "ludicrous", alias = "maximum")]
    Fastest,
}

impl SpeedPreset {
    fn as_str(self) -> &'static str {
        match self {
            Self::Quality => "quality",
            Self::Balanced => "balanced",
            Self::Fast => "fast",
            Self::Fastest => "fastest",
        }
    }
}

/// Supports as the user sees them. The old `everywhere` is still read, as `auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportMode {
    Off,
    #[serde(alias = "everywhere")]
    Auto,
    Painted,
}

impl SupportMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Auto => "auto",
            Self::Painted => "painted",
        }
    }
}

/// sleipnir, the old three-way mode. Read from saved files when `vary_layer_height` is absent; never written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SmartLayer {
    #[default]
    Off,
    Quality,
    Strength,
}

impl SmartLayer {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Quality => "quality",
            Self::Strength => "strength",
        }
    }
}

/// The Easy mode controls from the Prepare workspace.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct EasySettings {
    /// 0 to 100; higher means thinner layers.
    pub detail: f64,
    /// 0 to 100; more walls and denser infill.
    pub strength: f64,
    pub speed: SpeedPreset,
    pub supports: SupportMode,
    pub brim: bool,
    /// The Vary layer height switch: automatic variable layer height, bounded by Detail. Off when absent.
    #[serde(default, rename = "varyLayerHeight", skip_serializing_if = "Option::is_none")]
    pub vary_layer_height: Option<bool>,
    /// Old sleipnir mode, used when `vary_layer_height` is absent.
    #[serde(default, rename = "smartLayer", skip_serializing_if = "Option::is_none")]
    pub smart_layer: Option<SmartLayer>,
}

impl EasySettings {
    /// Whether layer heights vary, from the new switch or a saved sleipnir mode.
    #[must_use]
    pub fn varies(&self) -> bool {
        self.vary_layer_height
            .unwrap_or_else(|| self.smart_layer.is_some_and(|m| m != SmartLayer::Off))
    }
}

impl Default for EasySettings {
    fn default() -> Self {
        Self {
            detail: 40.0,
            strength: 20.0,
            speed: SpeedPreset::Balanced,
            supports: SupportMode::Auto,
            brim: true,
            vary_layer_height: Some(true),
            smart_layer: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EasyGoal {
    Draft,
    Standard,
    Fine,
    Strong,
}

// ---- easy-map.json ------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Expr {
    Num(f64),
    Bool(bool),
    Str(String),
    Control(String),
    Call(String, Vec<Expr>),
    Table(Box<Expr>, BTreeMap<String, Scalar>),
}

fn parse_expr(j: &Json) -> Option<Expr> {
    Some(match j {
        Json::Number(n) => Expr::Num(n.as_f64()?),
        Json::Bool(b) => Expr::Bool(*b),
        Json::String(s) => s
            .strip_prefix('$')
            .map_or_else(|| Expr::Str(s.clone()), |c| Expr::Control(c.to_owned())),
        Json::Array(a) => {
            let op = a.first()?.as_str()?.to_owned();
            if op == "table" {
                let key = parse_expr(a.get(1)?)?;
                let map = a.get(2)?.as_object()?;
                let mut t = BTreeMap::new();
                for (k, v) in map {
                    t.insert(k.clone(), json_to_scalar(v)?);
                }
                Expr::Table(Box::new(key), t)
            } else {
                Expr::Call(op, a.iter().skip(1).map(parse_expr).collect::<Option<Vec<_>>>()?)
            }
        }
        _ => return None,
    })
}

fn json_to_scalar(j: &Json) -> Option<Scalar> {
    match j {
        Json::Number(n) => n.as_f64().map(Scalar::Num),
        Json::String(s) => Some(Scalar::Str(s.clone())),
        Json::Bool(b) => Some(Scalar::Bool(*b)),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct FlowCap {
    max_flow_key: String,
    height_key: String,
    width_keys: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
enum Rule {
    Set {
        key: String,
        control: String,
        when: Option<(String, Expr, Expr)>,
        expr: Expr,
    },
    Scale {
        control: String,
        keys: Vec<String>,
        factor: Expr,
        min: Option<f64>,
        round: Option<f64>,
        max_key: Option<String>,
        flow_cap: Option<FlowCap>,
    },
}

#[derive(Debug, Clone)]
struct ControlInfo {
    label: String,
}

struct Choice {
    values: BTreeMap<String, BTreeMap<String, Scalar>>,
}

struct EasyMap {
    controls: BTreeMap<String, ControlInfo>,
    derived: Vec<(String, Expr)>,
    choices: BTreeMap<String, Choice>,
    goals: BTreeMap<EasyGoal, EasySettings>,
    rules: Vec<Rule>,
}

fn str_of(j: &Json, k: &str) -> Option<String> {
    j.get(k)?.as_str().map(str::to_owned)
}

fn parse_rule(j: &Json) -> Option<Rule> {
    match j.get("op")?.as_str()? {
        "set" => {
            let when = match j.get("when") {
                Some(Json::Array(w)) => Some((
                    w.first()?.as_str()?.to_owned(),
                    parse_expr(w.get(1)?)?,
                    parse_expr(w.get(2)?)?,
                )),
                _ => None,
            };
            Some(Rule::Set {
                key: str_of(j, "key")?,
                control: str_of(j, "control")?,
                when,
                expr: parse_expr(j.get("expr")?)?,
            })
        }
        "scale" => {
            let flow_cap = match j.get("flow_cap") {
                Some(fc) => Some(FlowCap {
                    max_flow_key: str_of(fc, "max_flow_key")?,
                    height_key: str_of(fc, "height_key")?,
                    width_keys: fc
                        .get("width_keys")?
                        .as_object()?
                        .iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                        .collect(),
                }),
                None => None,
            };
            Some(Rule::Scale {
                control: str_of(j, "control")?,
                keys: j
                    .get("keys")?
                    .as_array()?
                    .iter()
                    .filter_map(|k| k.as_str().map(str::to_owned))
                    .collect(),
                factor: parse_expr(j.get("factor")?)?,
                min: j.get("min").and_then(Json::as_f64),
                round: j.get("round").and_then(Json::as_f64),
                max_key: str_of(j, "max_key"),
                flow_cap,
            })
        }
        _ => None,
    }
}

fn goal_of(name: &str) -> Option<EasyGoal> {
    Some(match name {
        "draft" => EasyGoal::Draft,
        "standard" => EasyGoal::Standard,
        "fine" => EasyGoal::Fine,
        "strong" => EasyGoal::Strong,
        _ => return None,
    })
}

fn parse_easy(j: &Json) -> Option<EasySettings> {
    serde_json::from_value(j.clone()).ok()
}

fn easy_map() -> &'static EasyMap {
    static MAP: OnceLock<EasyMap> = OnceLock::new();
    MAP.get_or_init(|| {
        let j: Json = serde_json::from_str(include_str!("../easy-map.json")).unwrap_or(Json::Null);
        let controls = j
            .get("controls")
            .and_then(Json::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            ControlInfo {
                                label: str_of(v, "label").unwrap_or_else(|| k.clone()),
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let goals = j
            .get("goals")
            .and_then(Json::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| Some((goal_of(k)?, parse_easy(v)?)))
                    .collect()
            })
            .unwrap_or_default();
        let rules = j
            .get("rules")
            .and_then(Json::as_array)
            .map(|a| a.iter().filter_map(parse_rule).collect())
            .unwrap_or_default();
        let derived = j
            .get("derived")
            .and_then(Json::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| Some((k.clone(), parse_expr(v)?)))
                    .collect()
            })
            .unwrap_or_default();
        let choices = j
            .get("choices")
            .and_then(Json::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, v)| {
                        let values = v
                            .get("values")
                            .and_then(Json::as_object)
                            .map(|vals| {
                                vals.iter()
                                    .map(|(name, set)| {
                                        let set = set
                                            .as_object()
                                            .map(|o| {
                                                o.iter()
                                                    .filter_map(|(key, x)| {
                                                        Some((key.clone(), json_to_scalar(x)?))
                                                    })
                                                    .collect()
                                            })
                                            .unwrap_or_default();
                                        (name.clone(), set)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        (k.clone(), Choice { values })
                    })
                    .collect()
            })
            .unwrap_or_default();
        EasyMap {
            controls,
            derived,
            choices,
            goals,
            rules,
        }
    })
}

// ---- evaluation ---------------------------------------------------------------------

/// Snap to 1e-9 so `0.2 * 0.4` is `0.08`, not `0.08000000000000002`. Matches the TS side.
fn snap(v: f64) -> f64 {
    (v * 1e9 + 0.5).floor() / 1e9
}

/// JavaScript `Math.round`.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

struct Ctx<'a> {
    controls: BTreeMap<&'static str, Scalar>,
    base: &'a PrintConfig,
    out: BTreeMap<String, Value>,
}

/// Control names are a handful of fixed strings from `easy-map.json`; interning keeps `Ctx` keyed by `&'static str`.
fn leak_name(name: &str) -> &'static str {
    static NAMES: OnceLock<std::sync::Mutex<BTreeMap<String, &'static str>>> = OnceLock::new();
    let mut m = NAMES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(n) = m.get(name) {
        return n;
    }
    let leaked: &'static str = Box::leak(name.to_owned().into_boxed_str());
    m.insert(name.to_owned(), leaked);
    leaked
}

fn num(s: &Scalar) -> f64 {
    match s {
        Scalar::Num(n) => *n,
        Scalar::Bool(b) => f64::from(u8::from(*b)),
        Scalar::Str(_) => f64::NAN,
    }
}

fn lookup(ctx: &Ctx, key: &str, use_out: bool) -> Option<Scalar> {
    if use_out && let Some(v) = ctx.out.get(key) {
        return v.first_scalar();
    }
    ctx.base.get(key).and_then(Value::first_scalar)
}

fn key_string(s: &Scalar) -> String {
    match s {
        Scalar::Str(s) => s.clone(),
        Scalar::Bool(b) => b.to_string(),
        Scalar::Num(n) => {
            if n.fract() == 0.0 && n.abs() < 9.0e15 {
                #[allow(clippy::cast_possible_truncation)]
                return (*n as i64).to_string();
            }
            n.to_string()
        }
    }
}

fn eval(e: &Expr, ctx: &Ctx) -> Scalar {
    match eval_raw(e, ctx) {
        Scalar::Num(n) if n.is_finite() => Scalar::Num(snap(n)),
        other => other,
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn eval_raw(e: &Expr, ctx: &Ctx) -> Scalar {
    match e {
        Expr::Num(n) => Scalar::Num(*n),
        Expr::Bool(b) => Scalar::Bool(*b),
        Expr::Str(s) => Scalar::Str(s.clone()),
        Expr::Control(c) => ctx
            .controls
            .get(c.as_str())
            .cloned()
            .unwrap_or(Scalar::Num(f64::NAN)),
        Expr::Table(key, map) => map
            .get(&key_string(&eval(key, ctx)))
            .cloned()
            .unwrap_or(Scalar::Num(f64::NAN)),
        Expr::Call(op, args) => eval_call(op, args, ctx),
    }
}

fn eval_call(op: &str, args: &[Expr], ctx: &Ctx) -> Scalar {
    let n = |i: usize| args.get(i).map_or(f64::NAN, |a| num(&eval(a, ctx)));
    let r = match op {
        "linear" => {
            let (x, x0, y0, x1, y1) = (n(0), n(1), n(2), n(3), n(4));
            y0 + (x - x0) * (y1 - y0) / (x1 - x0)
        }
        "round_to" => {
            let q = n(1);
            snap(js_round(n(0) / q) * q)
        }
        "floor" => (n(0) + 1e-9).floor(),
        "ceil" => (n(0) - 1e-9).ceil(),
        "add" => (0..args.len()).fold(0.0, |a, i| a + n(i)),
        "mul" => (0..args.len()).fold(1.0, |a, i| a * n(i)),
        "sub" => n(0) - n(1),
        "div" => n(0) / n(1),
        "min" => (0..args.len()).fold(f64::INFINITY, |a, i| js_min(a, n(i))),
        "max" => (0..args.len()).fold(f64::NEG_INFINITY, |a, i| js_max(a, n(i))),
        "clamp" => js_min(js_max(n(0), n(1)), n(2)),
        "base" | "ref" => {
            let name = match args.first() {
                Some(Expr::Str(s)) => s.as_str(),
                _ => return Scalar::Num(f64::NAN),
            };
            let default = args.get(1);
            return match lookup(ctx, name, op == "ref") {
                None => default.map_or(Scalar::Num(f64::NAN), |d| eval(d, ctx)),
                Some(Scalar::Num(v)) if v == 0.0 && default.is_some() => {
                    default.map_or(Scalar::Num(f64::NAN), |d| eval(d, ctx))
                }
                Some(Scalar::Str(s)) => Scalar::Num(s.trim().parse::<f64>().unwrap_or(f64::NAN)),
                Some(other) => other,
            };
        }
        _ => f64::NAN,
    };
    Scalar::Num(r)
}

fn holds(when: Option<&(String, Expr, Expr)>, ctx: &Ctx) -> bool {
    let Some((op, a, b)) = when else { return true };
    let (l, r) = (eval(a, ctx), eval(b, ctx));
    match op.as_str() {
        "eq" => l == r,
        "ne" => l != r,
        _ => true,
    }
}

fn number_value(key: &str, v: f64) -> Value {
    if setting_def(key).is_some_and(|d| matches!(d.kind, SettingType::Int | SettingType::Ints))
        && v.fract() == 0.0
    {
        #[allow(clippy::cast_possible_truncation)]
        return Value::Int(v as i64);
    }
    Value::Float(v)
}

/// Write a scalar in the shape of the base value: lists stay lists of the same length.
fn shaped(key: &str, base: Option<&Value>, v: &Scalar) -> Value {
    let len = match base {
        Some(Value::Floats(a)) => a.len(),
        Some(Value::Ints(a)) => a.len(),
        Some(Value::Bools(a)) => a.len(),
        Some(Value::Strs(a)) => a.len(),
        _ => 0,
    };
    match (v, base) {
        (Scalar::Num(n), Some(Value::Ints(_))) if len > 0 && n.fract() == 0.0 =>
        {
            #[allow(clippy::cast_possible_truncation)]
            Value::Ints(vec![*n as i64; len])
        }
        (Scalar::Num(n), Some(Value::Floats(_) | Value::Ints(_))) if len > 0 => Value::Floats(vec![*n; len]),
        (Scalar::Num(n), _) => number_value(key, *n),
        (Scalar::Bool(b), Some(Value::Bools(_))) if len > 0 => Value::Bools(vec![*b; len]),
        (Scalar::Bool(b), _) => Value::Bool(*b),
        (Scalar::Str(s), Some(Value::Strs(_))) if len > 0 => Value::Strs(vec![s.clone(); len]),
        (Scalar::Str(s), _) => Value::Str(s.clone()),
    }
}

fn width(cfg: &PrintConfig, out: &BTreeMap<String, Value>, key: &str, nozzle: f64) -> f64 {
    let raw = out
        .get(key)
        .or_else(|| cfg.get(key))
        .and_then(Value::first_scalar);
    match raw {
        Some(Scalar::Num(n)) => {
            if n > 0.0 {
                n
            } else {
                nozzle
            }
        }
        Some(Scalar::Str(s)) => {
            if let Some(p) = s.strip_suffix('%') {
                return p.trim().parse::<f64>().map_or(nozzle, |v| v / 100.0 * nozzle);
            }
            s.trim()
                .parse::<f64>()
                .ok()
                .filter(|v| *v > 0.0)
                .unwrap_or(nozzle)
        }
        _ => nozzle,
    }
}

fn first_number(v: Option<&Value>) -> f64 {
    match v.and_then(Value::first_scalar) {
        Some(Scalar::Num(n)) => n,
        Some(Scalar::Bool(b)) => f64::from(u8::from(b)),
        _ => f64::NAN,
    }
}

fn scale_one(
    x: f64,
    factor: f64,
    key: &str,
    rule: &Rule,
    extra: (&PrintConfig, &BTreeMap<String, Value>, f64, f64, f64, f64),
) -> f64 {
    let Rule::Scale {
        min, round, flow_cap, ..
    } = rule
    else {
        return x;
    };
    let (cfg, out, nozzle, max_flow, height, limit) = extra;
    if x <= 0.0 {
        return x;
    }
    let mut v = x * factor;
    if let Some(fc) = flow_cap
        && let Some(wk) = fc.width_keys.get(key)
        && max_flow > 0.0
        && height > 0.0
    {
        let w = width(cfg, out, wk, nozzle);
        v = js_min(v, js_max(max_flow / (w * height), x));
    }
    if limit > 0.0 {
        v = js_min(v, js_max(limit, x));
    }
    if let Some(m) = min {
        v = js_max(v, *m);
    }
    if let Some(r) = round
        && *r != 0.0
    {
        v = js_round(v / r) * r;
    }
    snap(v)
}

fn easy_controls(easy: &EasySettings) -> BTreeMap<&'static str, Scalar> {
    let mut controls = BTreeMap::new();
    controls.insert("detail", Scalar::Num(easy.detail));
    controls.insert("strength", Scalar::Num(easy.strength));
    controls.insert("speed", Scalar::Str(easy.speed.as_str().to_owned()));
    controls.insert("supports", Scalar::Str(easy.supports.as_str().to_owned()));
    controls.insert("brim", Scalar::Bool(easy.brim));
    controls.insert("varyLayerHeight", Scalar::Bool(easy.varies()));
    controls
}

/// Controls computed from the others (`derived` in `easy-map.json`). A saved smartLayer mode with no
/// varyLayerHeight keeps its exact mode.
fn add_derived_controls(ctx: &mut Ctx, easy: &EasySettings) {
    for (name, expr) in &easy_map().derived {
        let v = eval(expr, ctx);
        ctx.controls.insert(leak_name(name), v);
    }
    if easy.vary_layer_height.is_none()
        && let Some(m) = easy.smart_layer
    {
        ctx.controls
            .insert("smartLayerMode", Scalar::Str(m.as_str().to_owned()));
    }
}

/// Apply the Easy controls to a base config and return a new one. `base` is the unmodified
/// profile: speed scaling multiplies its values, so applying twice to an already scaled config
/// would scale twice.
#[must_use]
pub fn apply_easy(easy: &EasySettings, base: &PrintConfig) -> PrintConfig {
    let mut ctx = Ctx {
        controls: easy_controls(easy),
        base,
        out: BTreeMap::new(),
    };
    add_derived_controls(&mut ctx, easy);
    let nozzle = {
        let n = first_number(base.get("nozzle_diameter"));
        if n.is_nan() || n == 0.0 { 0.4 } else { n }
    };
    for rule in &easy_map().rules {
        match rule {
            Rule::Set { key, when, expr, .. } => {
                if !holds(when.as_ref(), &ctx) {
                    continue;
                }
                let v = eval(expr, &ctx);
                if matches!(v, Scalar::Num(n) if !n.is_finite()) {
                    continue;
                }
                let value = shaped(key, base.get(key), &v);
                ctx.out.insert(key.clone(), value);
            }
            Rule::Scale {
                keys,
                factor,
                flow_cap,
                max_key,
                ..
            } => {
                let f = num(&eval(factor, &ctx));
                if !f.is_finite() {
                    continue;
                }
                let max_flow = flow_cap
                    .as_ref()
                    .map_or(0.0, |fc| first_number(base.get(&fc.max_flow_key)));
                let height = flow_cap.as_ref().map_or(0.0, |fc| {
                    first_number(ctx.out.get(&fc.height_key).or_else(|| base.get(&fc.height_key)))
                });
                let limit = max_key.as_ref().map_or(0.0, |k| first_number(base.get(k)));
                let max_flow = if max_flow.is_nan() { 0.0 } else { max_flow };
                let height = if height.is_nan() { 0.0 } else { height };
                let limit = if limit.is_nan() { 0.0 } else { limit };
                for key in keys {
                    let cur = ctx.out.get(key).or_else(|| base.get(key)).cloned();
                    let extra = (base, &ctx.out, nozzle, max_flow, height, limit);
                    let new = match cur {
                        Some(Value::Float(x)) => Some(number_value(key, scale_one(x, f, key, rule, extra))),
                        #[allow(clippy::cast_precision_loss)]
                        Some(Value::Int(x)) => {
                            Some(number_value(key, scale_one(x as f64, f, key, rule, extra)))
                        }
                        Some(Value::Floats(xs)) => Some(Value::Floats(
                            xs.iter().map(|x| scale_one(*x, f, key, rule, extra)).collect(),
                        )),
                        #[allow(clippy::cast_precision_loss)]
                        Some(Value::Ints(xs)) => Some(Value::Floats(
                            xs.iter()
                                .map(|x| scale_one(*x as f64, f, key, rule, extra))
                                .collect(),
                        )),
                        _ => None,
                    };
                    if let Some(v) = new {
                        ctx.out.insert(key.clone(), v);
                    }
                }
            }
        }
    }
    let mut next = base.clone();
    for (k, v) in ctx.out {
        next.set(k, v);
    }
    next
}

/// The Easy controls for a Goal preset.
#[must_use]
pub fn goal_easy(goal: EasyGoal) -> EasySettings {
    easy_map().goals.get(&goal).copied().unwrap_or_default()
}

/// The Goal whose sliders match `easy` exactly, if any.
#[must_use]
pub fn match_goal(easy: &EasySettings) -> Option<EasyGoal> {
    // The sliders move in whole steps, so an exact match is what "this Goal" means.
    #[allow(clippy::float_cmp)]
    let same = |p: &EasySettings| {
        p.detail == easy.detail
            && p.strength == easy.strength
            && p.speed == easy.speed
            && p.varies() == easy.varies()
    };
    easy_map().goals.iter().find(|(_, p)| same(p)).map(|(g, _)| *g)
}

/// The label and control name of the Easy control that writes `key`, if one does.
#[must_use]
pub fn easy_control_for(key: &str) -> Option<&'static str> {
    easy_map().rules.iter().find_map(|r| match r {
        Rule::Set { key: k, control, .. } if k == key => Some(control.as_str()),
        Rule::Scale { keys, control, .. } if keys.iter().any(|k| k == key) => Some(control.as_str()),
        _ => None,
    })
}

/// The display label of an Easy control (`Detail`, `Strength`, ...).
#[must_use]
pub fn easy_control_label(control: &str) -> Option<&'static str> {
    easy_map().controls.get(control).map(|c| c.label.as_str())
}

/// Every key an Easy rule can write.
#[must_use]
pub fn easy_keys() -> Vec<&'static str> {
    let mut out = Vec::new();
    for r in &easy_map().rules {
        match r {
            Rule::Set { key, .. } => out.push(key.as_str()),
            Rule::Scale { keys, .. } => out.extend(keys.iter().map(String::as_str)),
        }
    }
    out
}

/// The display value of the control named `control` for `easy`, as JavaScript's `String()` would print it.
#[must_use]
pub fn easy_control_value(easy: &EasySettings, control: &str) -> String {
    match control {
        "detail" => key_string(&Scalar::Num(easy.detail)),
        "strength" => key_string(&Scalar::Num(easy.strength)),
        "speed" => easy.speed.as_str().to_owned(),
        "supports" => easy.supports.as_str().to_owned(),
        "brim" => easy.brim.to_string(),
        "varyLayerHeight" | "smartLayer" => easy.varies().to_string(),
        _ => String::new(),
    }
}

/// The Advanced choices by name (`overhangSlowdown`, `unsupportedOverhangs`) with their value names.
#[must_use]
pub fn easy_choices() -> Vec<(&'static str, Vec<&'static str>)> {
    easy_map()
        .choices
        .iter()
        .map(|(k, c)| (k.as_str(), c.values.keys().map(String::as_str).collect()))
        .collect()
}

/// Set a choice: every key of the named value is written in the shape of its current value (or its schema default).
/// An unknown choice or value returns the config unchanged.
#[must_use]
pub fn apply_choice(config: &PrintConfig, choice: &str, value: &str) -> PrintConfig {
    let mut next = config.clone();
    let Some(set) = easy_map().choices.get(choice).and_then(|c| c.values.get(value)) else {
        return next;
    };
    for (k, v) in set {
        let default = setting_def(k).and_then(|d| Value::from_json(&d.default));
        let base = config.get(k).cloned().or(default);
        next.set(k.clone(), shaped(k, base.as_ref(), v));
    }
    next
}

/// The value of a choice that the config's keys spell out, or `None` when they match none.
#[must_use]
pub fn choice_value(config: &PrintConfig, choice: &str) -> Option<&'static str> {
    let c = easy_map().choices.get(choice)?;
    c.values.iter().find_map(|(name, set)| {
        set.iter()
            .all(|(k, v)| {
                let cur = config
                    .get(k)
                    .cloned()
                    .or_else(|| setting_def(k).and_then(|d| Value::from_json(&d.default)))
                    .and_then(|x| x.first_scalar());
                cur.as_ref() == Some(v)
            })
            .then_some(name.as_str())
    })
}

/// Top and bottom shell layers from the shell thickness in mm and the layer height: `ceil(thickness / layer height)`.
#[must_use]
pub fn derive_shell_layers(config: &PrintConfig) -> PrintConfig {
    let mut next = config.clone();
    let lh = first_number(config.get("layer_height"));
    if lh.is_nan() || lh <= 0.0 {
        return next;
    }
    for side in ["top", "bottom"] {
        let t = first_number(config.get(&format!("{side}_shell_thickness")));
        if !t.is_nan() && t > 0.0 {
            #[allow(clippy::cast_possible_truncation)]
            next.set(
                format!("{side}_shell_layers"),
                Value::Int((snap(t / lh) - 1e-9).ceil() as i64),
            );
        }
    }
    next
}
