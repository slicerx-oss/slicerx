// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Typed setting values and their conversion from and to Orca's string typed JSON.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value as Json;

use crate::schema::{SettingDef, SettingType};

/// A setting value. Percent values are plain numbers (15 means 15 percent). A float-or-percent
/// value is kept as Orca's string (`0.42` or `110%`).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Point([f64; 2]),
    Bools(Vec<bool>),
    Ints(Vec<i64>),
    Floats(Vec<f64>),
    Strs(Vec<String>),
    Points(Vec<[f64; 2]>),
    PointGroups(Vec<Vec<[f64; 2]>>),
}

fn num_json(v: f64) -> Json {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.0e15 {
        // Whole numbers print without a fraction, as JavaScript would.
        #[allow(clippy::cast_possible_truncation)]
        return Json::from(v as i64);
    }
    serde_json::Number::from_f64(v).map_or(Json::Null, Json::Number)
}

impl Value {
    /// The natural JSON form: numbers, booleans, strings, arrays.
    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            Self::Bool(b) => Json::Bool(*b),
            Self::Int(i) => Json::from(*i),
            Self::Float(f) => num_json(*f),
            Self::Str(s) => Json::String(s.clone()),
            Self::Point(p) => Json::Array(p.iter().map(|x| num_json(*x)).collect()),
            Self::Bools(v) => Json::Array(v.iter().map(|b| Json::Bool(*b)).collect()),
            Self::Ints(v) => Json::Array(v.iter().map(|i| Json::from(*i)).collect()),
            Self::Floats(v) => Json::Array(v.iter().map(|f| num_json(*f)).collect()),
            Self::Strs(v) => Json::Array(v.iter().map(|s| Json::String(s.clone())).collect()),
            Self::Points(v) => Json::Array(v.iter().map(|p| Value::Point(*p).to_json()).collect()),
            Self::PointGroups(v) => {
                Json::Array(v.iter().map(|g| Value::Points(g.clone()).to_json()).collect())
            }
        }
    }

    /// Read the natural JSON form back. Numbers that are whole become `Int`, others `Float`.
    #[must_use]
    pub fn from_json(j: &Json) -> Option<Self> {
        match j {
            Json::Bool(b) => Some(Self::Bool(*b)),
            Json::Number(n) => n.as_i64().map(Self::Int).or_else(|| n.as_f64().map(Self::Float)),
            Json::String(s) => Some(Self::Str(s.clone())),
            Json::Array(a) => Self::list_from_json(a),
            _ => None,
        }
    }

    fn list_from_json(a: &[Json]) -> Option<Self> {
        let Some(first) = a.first() else {
            return Some(Self::Floats(Vec::new()));
        };
        match first {
            Json::Bool(_) => a
                .iter()
                .map(Json::as_bool)
                .collect::<Option<Vec<_>>>()
                .map(Self::Bools),
            Json::String(_) => a
                .iter()
                .map(|x| x.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .map(Self::Strs),
            Json::Number(_) => {
                if a.iter().all(|x| x.as_i64().is_some()) {
                    a.iter()
                        .map(Json::as_i64)
                        .collect::<Option<Vec<_>>>()
                        .map(Self::Ints)
                } else {
                    a.iter()
                        .map(Json::as_f64)
                        .collect::<Option<Vec<_>>>()
                        .map(Self::Floats)
                }
            }
            Json::Array(inner) if inner.first().is_some_and(Json::is_number) => a
                .iter()
                .map(point_from_json)
                .collect::<Option<Vec<_>>>()
                .map(Self::Points),
            Json::Array(_) => a
                .iter()
                .map(|g| {
                    g.as_array()
                        .and_then(|pts| pts.iter().map(point_from_json).collect::<Option<Vec<_>>>())
                })
                .collect::<Option<Vec<_>>>()
                .map(Self::PointGroups),
            _ => None,
        }
    }

    /// First entry of a per-extruder list, or the scalar itself, as a number. Booleans are 0 or 1.
    #[must_use]
    pub fn first_f64(&self) -> Option<f64> {
        match self {
            Self::Bool(b) => Some(f64::from(u8::from(*b))),
            #[allow(clippy::cast_precision_loss)]
            Self::Int(i) => Some(*i as f64),
            Self::Float(f) => Some(*f),
            Self::Str(s) => parse_percent_or_number(s),
            Self::Bools(v) => v.first().map(|b| f64::from(u8::from(*b))),
            #[allow(clippy::cast_precision_loss)]
            Self::Ints(v) => v.first().map(|i| *i as f64),
            Self::Floats(v) => v.first().copied(),
            Self::Strs(v) => v.first().and_then(|s| parse_percent_or_number(s)),
            _ => None,
        }
    }

    /// The scalar view used by dependency checks and conflict rules.
    #[must_use]
    pub fn first_scalar(&self) -> Option<Scalar> {
        match self {
            Self::Bool(b) => Some(Scalar::Bool(*b)),
            Self::Str(s) => Some(Scalar::Str(s.clone())),
            Self::Bools(v) => v.first().map(|b| Scalar::Bool(*b)),
            Self::Strs(v) => v.first().map(|s| Scalar::Str(s.clone())),
            Self::Int(_) | Self::Float(_) | Self::Ints(_) | Self::Floats(_) => {
                self.first_f64().map(Scalar::Num)
            }
            _ => None,
        }
    }

    /// True for the list variants.
    #[must_use]
    pub fn is_list(&self) -> bool {
        matches!(
            self,
            Self::Bools(_)
                | Self::Ints(_)
                | Self::Floats(_)
                | Self::Strs(_)
                | Self::Points(_)
                | Self::PointGroups(_)
        )
    }
}

impl Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(s)
    }
}

fn point_from_json(j: &Json) -> Option<[f64; 2]> {
    let a = j.as_array()?;
    Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
}

/// A number, string or boolean: what conditions and expressions compare.
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    Num(f64),
    Str(String),
    Bool(bool),
}

/// `110%` and `0.4` both parse; the percent sign is dropped.
#[must_use]
pub fn parse_percent_or_number(s: &str) -> Option<f64> {
    let t = s.trim();
    let body = t.strip_suffix('%').unwrap_or(t);
    parse_number(body)
}

/// Strict decimal parse matching what Orca profiles contain: no hex, no `inf`, no empty string.
#[must_use]
pub fn parse_number(s: &str) -> Option<f64> {
    let t = s.trim();
    let mut chars = t.chars().peekable();
    if matches!(chars.peek(), Some('+' | '-')) {
        chars.next();
    }
    let rest: String = chars.collect();
    let mut digits = 0;
    let mut seen_e = false;
    let mut prev = ' ';
    for (i, c) in rest.chars().enumerate() {
        match c {
            '0'..='9' => digits += 1,
            '.' if !seen_e => {}
            'e' | 'E' if !seen_e && digits > 0 => seen_e = true,
            '+' | '-' if seen_e && (prev == 'e' || prev == 'E') && i > 0 => {}
            _ => return None,
        }
        prev = c;
    }
    if digits == 0 {
        return None;
    }
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// A whole config: setting key to value. Serializes as a plain JSON object.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PrintConfig {
    values: BTreeMap<String, Value>,
}

impl PrintConfig {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    pub fn set(&mut self, key: impl Into<String>, value: Value) {
        self.values.insert(key.into(), value);
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.values.remove(key)
    }

    #[must_use]
    pub fn contains(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.values.iter()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.values.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    #[must_use]
    pub fn to_json(&self) -> Json {
        Json::Object(
            self.values
                .iter()
                .map(|(k, v)| (k.clone(), v.to_json()))
                .collect(),
        )
    }

    /// Read a JSON object of natural values. Entries that are not values are skipped.
    #[must_use]
    pub fn from_json(j: &Json) -> Self {
        let mut out = Self::new();
        if let Json::Object(m) = j {
            for (k, v) in m {
                if let Some(val) = Value::from_json(v) {
                    out.values.insert(k.clone(), val);
                }
            }
        }
        out
    }

    /// Layer configs left to right. Later ones win.
    #[must_use]
    pub fn merged(parts: &[&PrintConfig]) -> Self {
        let mut out = Self::new();
        for p in parts {
            for (k, v) in &p.values {
                out.values.insert(k.clone(), v.clone());
            }
        }
        out
    }
}

impl Serialize for PrintConfig {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(s)
    }
}

impl<'de> Deserialize<'de> for PrintConfig {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Json::deserialize(d).map(|j| Self::from_json(&j))
    }
}

/// Result of reading one Orca JSON value as a schema type.
#[derive(Debug, Clone, PartialEq)]
pub enum Coerced {
    Ok(Value),
    /// `nil`: take the value from another profile. The key is left out.
    Nil,
    Invalid,
}

fn json_number(j: &Json) -> Option<f64> {
    match j {
        Json::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Json::String(s) => parse_number(s),
        Json::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

fn parse_point(j: &Json) -> Option<[f64; 2]> {
    match j {
        Json::Array(a) if a.len() == 2 => Some([json_number(a.first()?)?, json_number(a.get(1)?)?]),
        Json::String(s) => {
            let mut it = s.split(['x', 'X', ',']);
            let a = parse_number(it.next()?)?;
            let b = parse_number(it.next()?)?;
            if it.next().is_some() {
                return None;
            }
            Some([a, b])
        }
        _ => None,
    }
}

fn scalar_of_kind(kind: SettingType, j: &Json) -> Option<Value> {
    match kind {
        SettingType::Float => json_number(j).map(Value::Float),
        SettingType::Int =>
        {
            #[allow(clippy::cast_possible_truncation)]
            json_number(j).map(|v| Value::Int(v.trunc() as i64))
        }
        SettingType::Bool => match j {
            Json::Bool(b) => Some(Value::Bool(*b)),
            Json::Number(n) if n.as_i64() == Some(1) => Some(Value::Bool(true)),
            Json::Number(n) if n.as_i64() == Some(0) => Some(Value::Bool(false)),
            Json::String(s) if s == "1" || s == "true" => Some(Value::Bool(true)),
            Json::String(s) if s == "0" || s == "false" => Some(Value::Bool(false)),
            _ => None,
        },
        SettingType::Percent => match j {
            Json::String(s) => parse_percent_or_number(s).map(Value::Float),
            _ => json_number(j).map(Value::Float),
        },
        SettingType::FloatOrPercent => match j {
            Json::Number(n) => n
                .as_f64()
                .filter(|v| v.is_finite())
                .map(|v| Value::Str(num_string(v))),
            Json::String(s) => {
                let t = s.trim();
                parse_percent_or_number(t).map(|_| Value::Str(t.to_owned()))
            }
            _ => None,
        },
        SettingType::Enum | SettingType::String | SettingType::Gcode => match j {
            Json::String(s) => Some(Value::Str(s.clone())),
            Json::Number(n) => Some(Value::Str(n.to_string())),
            Json::Bool(b) => Some(Value::Str(b.to_string())),
            _ => None,
        },
        SettingType::Point => parse_point(j).map(Value::Point),
        _ => None,
    }
}

/// A number as JavaScript's `String(n)` prints it.
fn num_string(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation)]
        return (v as i64).to_string();
    }
    v.to_string()
}

fn element_kind(kind: SettingType) -> Option<SettingType> {
    Some(match kind {
        SettingType::Floats => SettingType::Float,
        SettingType::Ints => SettingType::Int,
        SettingType::Bools => SettingType::Bool,
        SettingType::Percents => SettingType::Percent,
        SettingType::FloatsOrPercents => SettingType::FloatOrPercent,
        SettingType::Enums => SettingType::Enum,
        SettingType::Strings => SettingType::String,
        SettingType::Points => SettingType::Point,
        _ => return None,
    })
}

/// Read one Orca JSON value as the schema type of `def`.
#[must_use]
pub fn coerce(def: &SettingDef, raw: &Json) -> Coerced {
    let is_nil = |j: &Json| j.as_str() == Some("nil");
    if is_nil(raw) || raw.as_array().is_some_and(|a| a.iter().any(is_nil)) {
        return Coerced::Nil;
    }
    let Some(elem) = element_kind(def.kind) else {
        if def.kind == SettingType::PointsGroups {
            return coerce_groups(raw);
        }
        // A scalar key that newer profiles store as a one entry list: take the first entry.
        let src = match raw {
            Json::Array(a) => a.first().unwrap_or(&Json::Null),
            other => other,
        };
        return scalar_of_kind(def.kind, src).map_or(Coerced::Invalid, Coerced::Ok);
    };
    let items: Vec<Json> = match raw {
        Json::Array(a) => a.clone(),
        // A polygon may be one string of points, such as "0x0,220x0,220x220,0x220".
        Json::String(s) if def.kind == SettingType::Points && s.contains(['x', 'X']) => {
            s.split(',').map(|x| Json::String(x.trim().to_owned())).collect()
        }
        // Older files store lists as one comma separated string such as "0,0".
        Json::String(s)
            if s.contains(',')
                && !matches!(elem, SettingType::Point | SettingType::String | SettingType::Enum) =>
        {
            s.split(',').map(|x| Json::String(x.trim().to_owned())).collect()
        }
        other => vec![other.clone()],
    };
    let mut out = Vec::with_capacity(items.len());
    for item in &items {
        match scalar_of_kind(elem, item) {
            Some(v) => out.push(v),
            None => return Coerced::Invalid,
        }
    }
    collect_list(elem, out).map_or(Coerced::Invalid, Coerced::Ok)
}

fn collect_list(elem: SettingType, items: Vec<Value>) -> Option<Value> {
    match elem {
        SettingType::Float | SettingType::Percent => items
            .iter()
            .map(|v| if let Value::Float(f) = v { Some(*f) } else { None })
            .collect::<Option<Vec<_>>>()
            .map(Value::Floats),
        SettingType::Int => items
            .iter()
            .map(|v| if let Value::Int(i) = v { Some(*i) } else { None })
            .collect::<Option<Vec<_>>>()
            .map(Value::Ints),
        SettingType::Bool => items
            .iter()
            .map(|v| if let Value::Bool(b) = v { Some(*b) } else { None })
            .collect::<Option<Vec<_>>>()
            .map(Value::Bools),
        SettingType::Point => items
            .iter()
            .map(|v| if let Value::Point(p) = v { Some(*p) } else { None })
            .collect::<Option<Vec<_>>>()
            .map(Value::Points),
        _ => items
            .into_iter()
            .map(|v| if let Value::Str(s) = v { Some(s) } else { None })
            .collect::<Option<Vec<_>>>()
            .map(Value::Strs),
    }
}

fn coerce_groups(raw: &Json) -> Coerced {
    let Some(groups) = raw.as_array() else {
        return Coerced::Invalid;
    };
    let mut out = Vec::new();
    for g in groups {
        // Orca stores each polygon as one comma separated string, such as "0x0,325x0,325x320,0x320".
        let items: Vec<Json> = match g {
            Json::Array(a) => a.clone(),
            Json::String(s) => s.split(',').map(|x| Json::String(x.trim().to_owned())).collect(),
            _ => return Coerced::Invalid,
        };
        let mut group = Vec::new();
        for p in &items {
            match parse_point(p) {
                Some(pt) => group.push(pt),
                None => return Coerced::Invalid,
            }
        }
        out.push(group);
    }
    Coerced::Ok(Value::PointGroups(out))
}

fn orca_scalar(kind: SettingType, v: &Value) -> Option<String> {
    Some(match (kind, v) {
        (SettingType::Bool, Value::Bool(b)) => if *b { "1" } else { "0" }.to_owned(),
        (SettingType::Percent, Value::Float(f)) => format!("{}%", num_string(*f)),
        (SettingType::Float, Value::Float(f)) => num_string(*f),
        (SettingType::Int, Value::Int(i)) => i.to_string(),
        (SettingType::Point, Value::Point(p)) => {
            format!("{}x{}", num_string(p[0]), num_string(p[1]))
        }
        (_, Value::Str(s)) => s.clone(),
        _ => return None,
    })
}

/// The inverse of `coerce`: Orca's string form of a value.
#[must_use]
pub fn to_orca(def: &SettingDef, value: &Value) -> Json {
    // JSON reads whole numbers as integers; the schema type decides which kind of number a key holds.
    #[allow(clippy::cast_precision_loss)]
    let value = &match (def.kind, value) {
        (SettingType::Float | SettingType::Percent, Value::Int(i)) => Value::Float(*i as f64),
        (SettingType::Floats | SettingType::Percents, Value::Ints(x)) => {
            Value::Floats(x.iter().map(|i| *i as f64).collect())
        }
        (SettingType::Ints, Value::Floats(x)) if x.iter().all(|f| f.fract() == 0.0) =>
        {
            #[allow(clippy::cast_possible_truncation)]
            Value::Ints(x.iter().map(|f| *f as i64).collect())
        }
        _ => value.clone(),
    };
    let strs = |xs: Vec<String>| Json::Array(xs.into_iter().map(Json::String).collect());
    match (def.kind, value) {
        (SettingType::Floats | SettingType::Percents, Value::Floats(v)) => {
            let elem = if def.kind == SettingType::Floats {
                SettingType::Float
            } else {
                SettingType::Percent
            };
            strs(
                v.iter()
                    .filter_map(|f| orca_scalar(elem, &Value::Float(*f)))
                    .collect(),
            )
        }
        (SettingType::Ints, Value::Ints(v)) => strs(v.iter().map(ToString::to_string).collect()),
        (SettingType::Bools, Value::Bools(v)) => {
            strs(v.iter().map(|b| if *b { "1" } else { "0" }.to_owned()).collect())
        }
        (SettingType::Points, Value::Points(v)) => strs(
            v.iter()
                .filter_map(|p| orca_scalar(SettingType::Point, &Value::Point(*p)))
                .collect(),
        ),
        (SettingType::PointsGroups, Value::PointGroups(g)) => Json::Array(
            g.iter()
                .map(|pts| {
                    strs(
                        pts.iter()
                            .filter_map(|p| orca_scalar(SettingType::Point, &Value::Point(*p)))
                            .collect(),
                    )
                })
                .collect(),
        ),
        (_, Value::Strs(v)) => strs(v.clone()),
        (kind, v) => orca_scalar(kind, v).map_or_else(|| v.to_json(), Json::String),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::schema::setting_def;

    fn def(key: &str) -> &'static SettingDef {
        setting_def(key).unwrap()
    }

    #[test]
    fn numbers_parse_strictly() {
        assert_eq!(parse_number("0.4"), Some(0.4));
        assert_eq!(parse_number("-3"), Some(-3.0));
        assert_eq!(parse_number("1e3"), Some(1000.0));
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("0x10"), None);
        assert_eq!(parse_number("inf"), None);
        assert_eq!(parse_number("nan"), None);
        assert_eq!(parse_number("."), None);
        assert_eq!(parse_percent_or_number("110%"), Some(110.0));
    }

    #[test]
    fn coerces_scalars_lists_points_and_nil() {
        assert_eq!(
            coerce(def("layer_height"), &json!("0.2")),
            Coerced::Ok(Value::Float(0.2))
        );
        assert_eq!(coerce(def("wall_loops"), &json!("3")), Coerced::Ok(Value::Int(3)));
        assert_eq!(
            coerce(def("enable_support"), &json!("1")),
            Coerced::Ok(Value::Bool(true))
        );
        assert_eq!(
            coerce(def("sparse_infill_density"), &json!("15%")),
            Coerced::Ok(Value::Float(15.0))
        );
        assert_eq!(
            coerce(def("line_width"), &json!("110%")),
            Coerced::Ok(Value::Str("110%".into()))
        );
        assert_eq!(
            coerce(def("outer_wall_speed"), &json!(["200", "350"])),
            Coerced::Ok(Value::Floats(vec![200.0, 350.0]))
        );
        assert_eq!(
            coerce(def("machine_min_travel_rate"), &json!("0,0")),
            Coerced::Ok(Value::Floats(vec![0.0, 0.0]))
        );
        assert_eq!(
            coerce(def("layer_height"), &json!(["0.16"])),
            Coerced::Ok(Value::Float(0.16))
        );
        assert_eq!(
            coerce(
                def("printable_area"),
                &json!(["0x0", "256x0", "256x256", "0x256"])
            ),
            Coerced::Ok(Value::Points(vec![
                [0.0, 0.0],
                [256.0, 0.0],
                [256.0, 256.0],
                [0.0, 256.0]
            ]))
        );
        assert_eq!(
            coerce(def("filament_retraction_length"), &json!(["nil", "0.4"])),
            Coerced::Nil
        );
        assert_eq!(coerce(def("layer_height"), &json!("thick")), Coerced::Invalid);
    }

    #[test]
    fn json_round_trip_keeps_shapes() {
        let mut c = PrintConfig::new();
        c.set("a", Value::Int(2));
        c.set("b", Value::Floats(vec![0.4, 0.6]));
        c.set("c", Value::Points(vec![[0.0, 0.0], [1.5, 2.0]]));
        c.set("d", Value::Str("x".into()));
        let back = PrintConfig::from_json(&c.to_json());
        assert_eq!(back.get("a"), Some(&Value::Int(2)));
        assert_eq!(back.get("b"), Some(&Value::Floats(vec![0.4, 0.6])));
        assert_eq!(back.get("c"), Some(&Value::Points(vec![[0.0, 0.0], [1.5, 2.0]])));
        assert_eq!(
            serde_json::to_string(&c).unwrap(),
            r#"{"a":2,"b":[0.4,0.6],"c":[[0,0],[1.5,2]],"d":"x"}"#
        );
    }

    #[test]
    fn orca_strings_round_trip() {
        for (key, raw) in [
            ("layer_height", json!("0.2")),
            ("sparse_infill_density", json!("15%")),
            ("enable_support", json!("0")),
            ("printable_area", json!(["0x0", "250x0", "250x250", "0x250"])),
            ("outer_wall_speed", json!(["200", "350"])),
        ] {
            let d = def(key);
            let Coerced::Ok(v) = coerce(d, &raw) else {
                panic!("{key}")
            };
            assert_eq!(to_orca(d, &v), raw, "{key}");
        }
    }
}
