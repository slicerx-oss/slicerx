// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The placeholder language of custom G-code (start, end, layer change, tool
//! change, pause). It is the language slicer profiles are written in:
//!
//! - `{expression}` inserts a value. Expressions have numbers, strings,
//!   `true` and `false`, variables and indexed variables (`temperature[0]`),
//!   `+ - * / %`, comparisons, `and or not` (also `&& || !`), `cond ? a : b`,
//!   regular-expression tests (`text =~ /.*PLA.*/`) and the functions `min`,
//!   `max`, `abs`, `round`, `floor`, `ceil`, `int`, `digits`, `zdigits`,
//!   `interpolate_table`, `is_nil`, `size` and `empty`.
//! - `{if cond}...{elsif cond}...{else}...{endif}` picks text.
//! - `{ local x = 1; x = x + 2; if a then b = 1; endif; x }` runs a small
//!   script; every expression statement inserts its value, in order, and
//!   assignments insert nothing (Orca's and PrusaSlicer's `macros` rule).
//! - `[name]` inserts a variable's value (a list gives its first entry, or the
//!   entry of the current extruder).
//!
//! Variables come from the layer being written (`layer_num`, `layer_z`, ...),
//! then from the print settings by their profile names.

// The matcher and the if nesting keep their helpers next to the code that uses them,
// and the matcher passes continuations, which read as long closure types.
#![allow(
    clippy::items_after_statements,
    clippy::type_complexity,
    clippy::only_used_in_recursion,
    clippy::cast_precision_loss,
    reason = "small self contained parsers"
)]

use crate::par::Init as _;
use serde_json::Value as Json;
use std::collections::HashMap;

/// A value in a template expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Num(f64),
    /// A whole number of Orca's integer type: a literal without a point, an `int` setting, a count or an index.
    /// Integer arithmetic stays integer, so `24/20` is 1 as in Orca.
    Int(i64),
    Str(String),
    Bool(bool),
    List(Vec<Value>),
    Nil,
}

impl Value {
    fn num(&self) -> Result<f64, String> {
        match self {
            Self::Num(n) => Ok(*n),
            #[allow(clippy::cast_precision_loss, reason = "template integers are small")]
            Self::Int(i) => Ok(*i as f64),
            Self::Bool(b) => Ok(f64::from(u8::from(*b))),
            Self::Str(s) => s
                .trim()
                .trim_end_matches('%')
                .parse()
                .map_err(|_| format!("\"{s}\" is not a number")),
            Self::List(l) if l.len() == 1 => l.first().map_or(Ok(0.0), Value::num),
            other => Err(format!("{other:?} is not a number")),
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Self::Bool(b) => *b,
            Self::Num(n) => *n != 0.0,
            Self::Int(i) => *i != 0,
            Self::Str(s) => !(s.is_empty() || s == "0" || s.eq_ignore_ascii_case("false")),
            Self::List(l) => !l.is_empty(),
            Self::Nil => false,
        }
    }

    /// The text a value is inserted as.
    fn text(&self) -> String {
        match self {
            Self::Num(n) => format_number(*n),
            Self::Int(i) => i.to_string(),
            Self::Str(s) => s.clone(),
            Self::Bool(b) => b.to_string(),
            Self::List(l) => l.first().map(Value::text).unwrap_or_default(),
            Self::Nil => String::new(),
        }
    }

    fn from_json(v: &Json) -> Self {
        match v {
            Json::Bool(b) => Self::Bool(*b),
            Json::Number(n) => Self::Num(n.as_f64().unwrap_or(0.0)),
            Json::String(s) => Self::Str(s.clone()),
            Json::Array(a) => Self::List(a.iter().map(Self::from_json).collect()),
            _ => Self::Nil,
        }
    }
}

/// Numbers print as Orca's placeholder parser writes a double (an `ostringstream` at its default
/// precision): six significant digits, no trailing zeros.
pub fn format_number(n: f64) -> String {
    crate::firmware::fmt_g(n)
}

/// Variables for one rendering. Lookup order: locals set by the template,
/// `vars` (the layer and print state), then `config` (the profile's own keys).
#[derive(Debug, Default, Clone)]
pub struct Context<'a> {
    pub vars: HashMap<String, Value>,
    pub config: Option<&'a serde_json::Map<String, Json>>,
    /// Index of the extruder `[name]` reads from a list.
    pub extruder: usize,
}

impl Context<'_> {
    /// Sets a variable to a number.
    pub fn set_num(&mut self, name: &str, v: f64) {
        self.vars.insert(name.to_owned(), Value::Num(v));
    }

    fn get(&self, name: &str) -> Option<Value> {
        let v = self
            .vars
            .get(name)
            .cloned()
            .or_else(|| self.config.and_then(|c| c.get(name)).map(Value::from_json))
            .or_else(|| orca_defaults().get(name).map(Value::from_json))?;
        Some(if is_int_name(name) { whole(v) } else { v })
    }
}

/// Variables Orca's G-code writer sets as integers (`ConfigOptionInt` and `ConfigOptionInts` in `GCode.cpp`).
const INT_VARS: &[&str] = &[
    "bed_mesh_probe_count",
    "bed_temperature",
    "bed_temperature_initial_layer",
    "bed_temperature_initial_layer_single",
    "chamber_minimal_temperature",
    "chamber_temperature",
    "color_change_extruder",
    "curr_physical_extruder_id",
    "current_extruder",
    "current_hotend",
    "current_object_idx",
    "day",
    "during_print_exhaust_fan_speed_num",
    "fan_speed",
    "filament_extruder_id",
    "filament_map",
    "filament_tower_interface_print_temp",
    "first_filaments",
    "first_layer_bed_temperature",
    "first_layer_temperature",
    "first_non_support_filaments",
    "first_non_support_tools",
    "first_tools",
    "flush_temperatures",
    "hour",
    "initial_extruder",
    "initial_no_support_extruder",
    "initial_no_support_tool",
    "initial_tool",
    "layer_num",
    "max_print_height",
    "max_print_z",
    "min_vitrification_temperature",
    "minute",
    "month",
    "most_used_physical_extruder_id",
    "new_filament_e_feedrate",
    "new_filament_temp",
    "next_extruder",
    "next_hotend",
    "num_extruders",
    "num_filaments",
    "old_filament_e_feedrate",
    "old_filament_temp",
    "overall_chamber_temperature",
    "previous_extruder",
    "second",
    "temperature",
    "timelapse_pos_x",
    "timelapse_pos_y",
    "toolchange_count",
    "total_layer_count",
    "total_toolchanges",
    "year",
];

/// Whether Orca reads `name` as an integer: an `int` setting or one of [`INT_VARS`].
fn is_int_name(name: &str) -> bool {
    static INTS: std::sync::OnceLock<std::collections::HashSet<&'static str>> = std::sync::OnceLock::new();
    INTS.once(|| {
        include_str!(concat!(env!("OUT_DIR"), "/int_keys.txt"))
            .lines()
            .chain(INT_VARS.iter().copied())
            .collect()
    })
    .contains(name)
}

/// A number (or list of numbers) as integers, as C++ converts a double to an int.
fn whole(v: Value) -> Value {
    match v {
        #[allow(clippy::cast_possible_truncation, reason = "template integers are small")]
        Value::Num(n) => Value::Int(n.trunc() as i64),
        Value::Str(s) => match s.trim().parse::<f64>() {
            #[allow(clippy::cast_possible_truncation, reason = "template integers are small")]
            Ok(n) => Value::Int(n.trunc() as i64),
            Err(_) => Value::Str(s),
        },
        Value::List(l) => Value::List(l.into_iter().map(whole).collect()),
        other => other,
    }
}

/// Orca 2.4.2's default of every setting (`packages/settings/defaults.json`: key to `[group, value]`), read
/// when neither the print nor the profile has the key, as Orca's placeholder parser reads the full config.
fn orca_defaults() -> &'static HashMap<String, Json> {
    static DEFAULTS: std::sync::OnceLock<HashMap<String, Json>> = std::sync::OnceLock::new();
    DEFAULTS.once(|| {
        let parsed: HashMap<String, (String, Json)> =
            serde_json::from_str(crate::config::SCHEMA_DEFAULTS).unwrap_or_default();
        parsed.into_iter().map(|(k, (_, v))| (k, v)).collect()
    })
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Int(i64),
    Str(String),
    Re(String),
    Id(String),
    Op(&'static str),
}

const OPS: &[&str] = &[
    "=~", "!~", "==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "(", ")", "[", "]",
    ",", "?", ":", ";", "=", "!",
];

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let cs: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut out: Vec<Tok> = Vec::new();
    while let Some(&c) = cs.get(i) {
        if c.is_whitespace() {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && cs.get(i + 1).is_some_and(char::is_ascii_digit)) {
            let start = i;
            while cs.get(i).is_some_and(|c| c.is_ascii_digit() || *c == '.') {
                i += 1;
            }
            let t: String = cs.get(start..i).unwrap_or(&[]).iter().collect();
            // a literal without a point is an integer (orca's `int_` before `strict_double`)
            match t.parse::<i64>() {
                Ok(i) if !t.contains('.') => out.push(Tok::Int(i)),
                _ => out.push(Tok::Num(t.parse().map_err(|_| format!("bad number {t}"))?)),
            }
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while cs.get(i).is_some_and(|c| c.is_alphanumeric() || *c == '_') {
                i += 1;
            }
            out.push(Tok::Id(cs.get(start..i).unwrap_or(&[]).iter().collect()));
        } else if c == '"' {
            i += 1;
            let mut s = String::new();
            while let Some(&d) = cs.get(i) {
                i += 1;
                match d {
                    '"' => break,
                    '\\' => {
                        if let Some(&e) = cs.get(i) {
                            s.push(match e {
                                'n' => '\n',
                                't' => '\t',
                                other => other,
                            });
                            i += 1;
                        }
                    }
                    other => s.push(other),
                }
            }
            out.push(Tok::Str(s));
        } else if c == '/' && matches!(out.last(), Some(Tok::Op("=~" | "!~"))) {
            i += 1;
            let mut s = String::new();
            while let Some(&d) = cs.get(i) {
                i += 1;
                if d == '/' {
                    break;
                }
                if d == '\\'
                    && let Some(&e) = cs.get(i)
                {
                    s.push(d);
                    s.push(e);
                    i += 1;
                    continue;
                }
                s.push(d);
            }
            out.push(Tok::Re(s));
        } else {
            let rest: String = cs.get(i..(i + 2).min(cs.len())).unwrap_or(&[]).iter().collect();
            let op = OPS
                .iter()
                .find(|o| rest.starts_with(**o))
                .ok_or_else(|| format!("unexpected character {c}"))?;
            out.push(Tok::Op(op));
            i += op.len();
        }
    }
    Ok(out)
}

#[derive(Debug, Clone)]
enum Expr {
    Lit(Value),
    Var(String),
    Index(Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
    Tuple(Vec<Expr>),
    Neg(Box<Expr>),
    Not(Box<Expr>),
    Bin(&'static str, Box<Expr>, Box<Expr>),
    Regex(Box<Expr>, String, bool),
    Cond(Box<Expr>, Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone)]
enum Stmt {
    Local(String, Expr),
    Assign(String, Option<Expr>, Expr),
    If(Vec<(Expr, Vec<Stmt>)>, Vec<Stmt>),
    Expr(Expr),
}

struct Parser {
    t: Vec<Tok>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }

    fn op(&mut self, o: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Op(x)) if *x == o) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn word(&mut self, w: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Id(x)) if x == w) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn at_word(&self, w: &str) -> bool {
        matches!(self.peek(), Some(Tok::Id(x)) if x == w)
    }

    fn expect(&mut self, o: &str) -> Result<(), String> {
        if self.op(o) {
            Ok(())
        } else {
            Err(format!("expected {o}"))
        }
    }

    fn ternary(&mut self) -> Result<Expr, String> {
        let c = self.or()?;
        if self.op("?") {
            let a = self.ternary()?;
            self.expect(":")?;
            let b = self.ternary()?;
            return Ok(Expr::Cond(Box::new(c), Box::new(a), Box::new(b)));
        }
        Ok(c)
    }

    fn or(&mut self) -> Result<Expr, String> {
        let mut l = self.and()?;
        while self.op("||") || self.word("or") {
            l = Expr::Bin("or", Box::new(l), Box::new(self.and()?));
        }
        Ok(l)
    }

    fn and(&mut self) -> Result<Expr, String> {
        let mut l = self.eq()?;
        while self.op("&&") || self.word("and") {
            l = Expr::Bin("and", Box::new(l), Box::new(self.eq()?));
        }
        Ok(l)
    }

    fn eq(&mut self) -> Result<Expr, String> {
        let mut l = self.cmp()?;
        loop {
            if self.op("==") {
                l = Expr::Bin("==", Box::new(l), Box::new(self.cmp()?));
            } else if self.op("!=") {
                l = Expr::Bin("!=", Box::new(l), Box::new(self.cmp()?));
            } else if matches!(self.peek(), Some(Tok::Op("=~" | "!~"))) {
                let negate = matches!(self.peek(), Some(Tok::Op("!~")));
                self.i += 1;
                let Some(Tok::Re(p)) = self.t.get(self.i).cloned() else {
                    return Err("expected /pattern/ after =~".to_owned());
                };
                self.i += 1;
                l = Expr::Regex(Box::new(l), p, negate);
            } else {
                return Ok(l);
            }
        }
    }

    fn cmp(&mut self) -> Result<Expr, String> {
        let mut l = self.add()?;
        loop {
            let o = ["<=", ">=", "<", ">"].into_iter().find(|o| self.op(o));
            let Some(o) = o else { return Ok(l) };
            l = Expr::Bin(o, Box::new(l), Box::new(self.add()?));
        }
    }

    fn add(&mut self) -> Result<Expr, String> {
        let mut l = self.mul()?;
        loop {
            let o = ["+", "-"].into_iter().find(|o| self.op(o));
            let Some(o) = o else { return Ok(l) };
            l = Expr::Bin(o, Box::new(l), Box::new(self.mul()?));
        }
    }

    fn mul(&mut self) -> Result<Expr, String> {
        let mut l = self.unary()?;
        loop {
            let o = ["*", "/", "%"].into_iter().find(|o| self.op(o));
            let Some(o) = o else { return Ok(l) };
            l = Expr::Bin(o, Box::new(l), Box::new(self.unary()?));
        }
    }

    fn unary(&mut self) -> Result<Expr, String> {
        if self.op("-") {
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.op("!") || self.word("not") {
            return Ok(Expr::Not(Box::new(self.unary()?)));
        }
        if self.op("+") {
            return self.unary();
        }
        self.postfix()
    }

    fn postfix(&mut self) -> Result<Expr, String> {
        let mut e = self.primary()?;
        while self.op("[") {
            let idx = self.ternary()?;
            self.expect("]")?;
            e = Expr::Index(Box::new(e), Box::new(idx));
        }
        Ok(e)
    }

    fn primary(&mut self) -> Result<Expr, String> {
        match self.t.get(self.i).cloned() {
            Some(Tok::Num(n)) => {
                self.i += 1;
                Ok(Expr::Lit(Value::Num(n)))
            }
            Some(Tok::Int(i)) => {
                self.i += 1;
                Ok(Expr::Lit(Value::Int(i)))
            }
            Some(Tok::Str(s)) => {
                self.i += 1;
                Ok(Expr::Lit(Value::Str(s)))
            }
            Some(Tok::Id(name)) => {
                self.i += 1;
                match name.as_str() {
                    "true" => return Ok(Expr::Lit(Value::Bool(true))),
                    "false" => return Ok(Expr::Lit(Value::Bool(false))),
                    "nil" => return Ok(Expr::Lit(Value::Nil)),
                    _ => {}
                }
                if self.op("(") {
                    let args = self.args()?;
                    return Ok(Expr::Call(name, args));
                }
                Ok(Expr::Var(name))
            }
            Some(Tok::Op("(")) => {
                self.i += 1;
                let mut items = self.args()?;
                if items.len() == 1 {
                    return Ok(items.remove(0));
                }
                Ok(Expr::Tuple(items))
            }
            other => Err(format!("unexpected {other:?}")),
        }
    }

    /// Arguments up to the closing parenthesis.
    fn args(&mut self) -> Result<Vec<Expr>, String> {
        let mut v = Vec::new();
        if self.op(")") {
            return Ok(v);
        }
        loop {
            v.push(self.ternary()?);
            if self.op(")") {
                return Ok(v);
            }
            self.expect(",")?;
        }
    }

    fn block(&mut self, stops: &[&str]) -> Result<Vec<Stmt>, String> {
        let mut out = Vec::new();
        while self.peek().is_some() && !stops.iter().any(|s| self.at_word(s)) {
            if self.op(";") {
                continue;
            }
            out.push(self.stmt()?);
        }
        Ok(out)
    }

    fn stmt(&mut self) -> Result<Stmt, String> {
        if self.word("local") {
            let Some(Tok::Id(name)) = self.t.get(self.i).cloned() else {
                return Err("expected a name after local".to_owned());
            };
            self.i += 1;
            self.expect("=")?;
            return Ok(Stmt::Local(name, self.ternary()?));
        }
        if self.word("if") {
            let mut branches = Vec::new();
            let mut other = Vec::new();
            let c = self.ternary()?;
            if !self.word("then") {
                return Err("expected then".to_owned());
            }
            branches.push((c, self.block(&["elsif", "else", "endif"])?));
            loop {
                if self.word("elsif") {
                    let c = self.ternary()?;
                    if !self.word("then") {
                        return Err("expected then".to_owned());
                    }
                    branches.push((c, self.block(&["elsif", "else", "endif"])?));
                } else if self.word("else") {
                    other = self.block(&["endif"])?;
                } else if self.word("endif") {
                    return Ok(Stmt::If(branches, other));
                } else {
                    return Err("if without endif".to_owned());
                }
            }
        }
        // name = expr, name[i] = expr, or an expression.
        let save = self.i;
        if let Some(Tok::Id(name)) = self.t.get(self.i).cloned() {
            self.i += 1;
            let mut idx = None;
            if self.op("[") {
                idx = Some(self.ternary()?);
                if !self.op("]") {
                    self.i = save;
                    return Ok(Stmt::Expr(self.ternary()?));
                }
            }
            if matches!(self.peek(), Some(Tok::Op("="))) {
                self.i += 1;
                return Ok(Stmt::Assign(name, idx, self.ternary()?));
            }
            self.i = save;
        }
        Ok(Stmt::Expr(self.ternary()?))
    }
}

struct Run<'c, 'a> {
    ctx: &'c Context<'a>,
    locals: HashMap<String, Value>,
}

impl Run<'_, '_> {
    fn var(&self, name: &str) -> Result<Value, String> {
        self.locals
            .get(name)
            .cloned()
            .or_else(|| self.ctx.get(name))
            .ok_or_else(|| format!("variable {name} does not exist"))
    }

    fn eval(&self, e: &Expr) -> Result<Value, String> {
        Ok(match e {
            Expr::Lit(v) => v.clone(),
            Expr::Var(n) => self.var(n)?,
            Expr::Index(v, i) => {
                let idx = self.eval(i)?.num()?;
                let list = self.eval(v)?;
                match list {
                    Value::List(l) => {
                        #[allow(
                            clippy::cast_possible_truncation,
                            clippy::cast_sign_loss,
                            reason = "a list index"
                        )]
                        let i = idx.max(0.0) as usize;
                        // Lists repeat their last entry, as per-extruder settings do.
                        l.get(i).or_else(|| l.last()).cloned().unwrap_or(Value::Nil)
                    }
                    scalar => scalar,
                }
            }
            Expr::Tuple(items) => Value::List(items.iter().map(|x| self.eval(x)).collect::<Result<_, _>>()?),
            Expr::Neg(x) => match self.eval(x)? {
                Value::Int(i) => Value::Int(-i),
                v => Value::Num(-v.num()?),
            },
            Expr::Not(x) => Value::Bool(!self.eval(x)?.truthy()),
            Expr::Cond(c, a, b) => {
                if self.eval(c)?.truthy() {
                    self.eval(a)?
                } else {
                    self.eval(b)?
                }
            }
            Expr::Regex(x, pat, negate) => {
                let text = self.eval(x)?.text();
                Value::Bool(regex_match(pat, &text)? != *negate)
            }
            Expr::Bin(op, a, b) => self.binary(op, a, b)?,
            Expr::Call(name, args) => self.call(name, args)?,
        })
    }

    fn binary(&self, op: &str, a: &Expr, b: &Expr) -> Result<Value, String> {
        if op == "and" {
            return Ok(Value::Bool(self.eval(a)?.truthy() && self.eval(b)?.truthy()));
        }
        if op == "or" {
            return Ok(Value::Bool(self.eval(a)?.truthy() || self.eval(b)?.truthy()));
        }
        let (x, y) = (self.eval(a)?, self.eval(b)?);
        match op {
            "==" | "!=" => {
                let same = loose_eq(&x, &y);
                Ok(Value::Bool(same == (op == "==")))
            }
            "+" if is_text(&x) || is_text(&y) => Ok(Value::Str(format!("{}{}", x.text(), y.text()))),
            // two integers stay integer, division and remainder truncating as in c++
            "+" | "-" | "*" | "/" | "%" if matches!((&x, &y), (Value::Int(_), Value::Int(_))) => {
                let (Value::Int(p), Value::Int(q)) = (x, y) else {
                    return Err("not integers".to_owned());
                };
                Ok(Value::Int(match op {
                    "+" => p.wrapping_add(q),
                    "-" => p.wrapping_sub(q),
                    "*" => p.wrapping_mul(q),
                    _ if q == 0 => {
                        return Err(format!(
                            "{} by zero",
                            if op == "/" { "division" } else { "modulo" }
                        ));
                    }
                    "/" => p.wrapping_div(q),
                    _ => p.wrapping_rem(q),
                }))
            }
            _ => {
                let (p, q) = (x.num()?, y.num()?);
                Ok(match op {
                    "+" => Value::Num(p + q),
                    "-" => Value::Num(p - q),
                    "*" => Value::Num(p * q),
                    "/" => {
                        if q == 0.0 {
                            return Err("division by zero".to_owned());
                        }
                        Value::Num(p / q)
                    }
                    "%" => {
                        if q == 0.0 {
                            return Err("modulo by zero".to_owned());
                        }
                        Value::Num(p % q)
                    }
                    "<" => Value::Bool(p < q),
                    ">" => Value::Bool(p > q),
                    "<=" => Value::Bool(p <= q),
                    ">=" => Value::Bool(p >= q),
                    other => return Err(format!("unknown operator {other}")),
                })
            }
        }
    }

    fn call(&self, name: &str, args: &[Expr]) -> Result<Value, String> {
        let vals: Vec<Value> = args.iter().map(|a| self.eval(a)).collect::<Result<_, _>>()?;
        let n = |i: usize| -> Result<f64, String> {
            vals.get(i)
                .ok_or_else(|| format!("{name} needs more arguments"))?
                .num()
        };
        Ok(match name {
            "min" | "max" if vals.iter().all(|v| matches!(v, Value::Int(_))) && !vals.is_empty() => {
                let ints = vals
                    .iter()
                    .filter_map(|v| if let Value::Int(i) = v { Some(*i) } else { None });
                Value::Int(if name == "min" { ints.min() } else { ints.max() }.unwrap_or(0))
            }
            "min" | "max" => {
                let mut it = vals.iter().map(Value::num);
                let first = it.next().ok_or_else(|| format!("{name} needs arguments"))??;
                let mut acc = first;
                for v in it {
                    let v = v?;
                    acc = if name == "min" { acc.min(v) } else { acc.max(v) };
                }
                Value::Num(acc)
            }
            "abs" => match vals.first() {
                Some(Value::Int(i)) => Value::Int(i.wrapping_abs()),
                _ => Value::Num(n(0)?.abs()),
            },
            // orca's int, round, floor and ceil give integers
            #[allow(clippy::cast_possible_truncation, reason = "template integers are small")]
            "round" => Value::Int(n(0)?.round() as i64),
            #[allow(clippy::cast_possible_truncation, reason = "template integers are small")]
            "floor" => Value::Int(n(0)?.floor() as i64),
            #[allow(clippy::cast_possible_truncation, reason = "template integers are small")]
            "ceil" => Value::Int(n(0)?.ceil() as i64),
            #[allow(clippy::cast_possible_truncation, reason = "template integers are small")]
            "int" => Value::Int(n(0)?.trunc() as i64),
            "digits" | "zdigits" => {
                let (v, width) = (n(0)?, n(1)?.max(0.0));
                let decimals = if vals.len() > 2 { n(2)?.max(0.0) } else { 0.0 };
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "small formatting widths"
                )]
                let (w, d) = (width as usize, decimals as usize);
                let s = format!("{v:.d$}");
                Value::Str(if name == "zdigits" {
                    format!("{s:0>w$}")
                } else {
                    format!("{s:>w$}")
                })
            }
            "is_nil" => Value::Bool(matches!(vals.first(), Some(Value::Nil) | None)),
            // Orca's `one_of(value, "a", "b", ...)`: whether the text equals any of the patterns (`~"re"` patterns,
            // regular expressions, are not supported here and never match).
            "one_of" => {
                let v = vals.first().ok_or("one_of needs a value")?.text();
                Value::Bool(vals.iter().skip(1).any(|p| p.text() == v))
            }
            #[allow(clippy::cast_possible_wrap, reason = "a list length")]
            "size" => Value::Int(match vals.first() {
                Some(Value::List(l)) => l.len() as i64,
                Some(Value::Str(s)) => s.chars().count() as i64,
                _ => 0,
            }),
            "empty" => Value::Bool(match vals.first() {
                Some(Value::List(l)) => l.is_empty(),
                Some(Value::Str(s)) => s.is_empty(),
                _ => true,
            }),
            "interpolate_table" => {
                let x = n(0)?;
                let pts: Vec<(f64, f64)> = vals
                    .iter()
                    .skip(1)
                    .map(|p| match p {
                        Value::List(l) => Ok((
                            l.first().map_or(Ok(0.0), Value::num)?,
                            l.get(1).map_or(Ok(0.0), Value::num)?,
                        )),
                        _ => Err("interpolate_table takes (x, y) pairs".to_owned()),
                    })
                    .collect::<Result<_, _>>()?;
                let (Some(first), Some(last)) = (pts.first(), pts.last()) else {
                    return Err("interpolate_table needs points".to_owned());
                };
                if x <= first.0 {
                    return Ok(Value::Num(first.1));
                }
                if x >= last.0 {
                    return Ok(Value::Num(last.1));
                }
                let seg = pts
                    .windows(2)
                    .find(|w| matches!(w, [a, b] if x >= a.0 && x <= b.0));
                match seg {
                    Some([a, b]) if b.0 > a.0 => Value::Num(a.1 + (b.1 - a.1) * (x - a.0) / (b.0 - a.0)),
                    _ => Value::Num(last.1),
                }
            }
            other => return Err(format!("unknown function {other}")),
        })
    }

    fn run(&mut self, block: &[Stmt], out: &mut String) -> Result<(), String> {
        for s in block {
            match s {
                Stmt::Local(n, e) => {
                    let v = self.eval(e)?;
                    self.locals.insert(n.clone(), v);
                }
                Stmt::Assign(n, idx, e) => {
                    let v = self.eval(e)?;
                    match idx {
                        None => {
                            self.locals.insert(n.clone(), v);
                        }
                        Some(ix) => {
                            let k = self.eval(ix)?.num()?;
                            let mut list = match self.var(n) {
                                Ok(Value::List(l)) => l,
                                _ => Vec::new(),
                            };
                            #[allow(
                                clippy::cast_possible_truncation,
                                clippy::cast_sign_loss,
                                reason = "a list index"
                            )]
                            let k = k.max(0.0) as usize;
                            if list.len() <= k {
                                list.resize(k + 1, Value::Num(0.0));
                            }
                            if let Some(slot) = list.get_mut(k) {
                                *slot = v;
                            }
                            self.locals.insert(n.clone(), Value::List(list));
                        }
                    }
                }
                Stmt::If(branches, other) => {
                    let mut taken = false;
                    for (c, body) in branches {
                        if self.eval(c)?.truthy() {
                            self.run(body, out)?;
                            taken = true;
                            break;
                        }
                    }
                    if !taken {
                        self.run(other, out)?;
                    }
                }
                // Each expression statement is inserted where it stands, as Orca's placeholder parser
                // appends every statement of a block (a Snapmaker U1 tool change writes its `T` that way).
                Stmt::Expr(e) => {
                    let v = self.eval(e)?;
                    out.push_str(&v.text());
                }
            }
        }
        Ok(())
    }
}

/// A string that is not a number: `+` joins it with the other side.
fn is_text(v: &Value) -> bool {
    matches!(v, Value::Str(s) if s.trim().trim_end_matches('%').parse::<f64>().is_err())
}

fn loose_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Bool(x), Value::Str(y)) | (Value::Str(y), Value::Bool(x)) => x.to_string() == *y,
        (Value::Nil, Value::Nil) => true,
        (Value::Nil, _) | (_, Value::Nil) => false,
        _ => match (a.num(), b.num()) {
            (Ok(x), Ok(y)) => (x - y).abs() < 1e-9,
            _ => a.text() == b.text(),
        },
    }
}

// A regular expression small enough for profile conditions: literals, `.`,
// classes `[a-z]`, groups, `|`, and the repeats `* + ?`.
#[derive(Debug)]
enum Node {
    Char(char),
    Any,
    Class(Vec<(char, char)>, bool),
    Group(Vec<Vec<(Node, u8)>>),
}

fn parse_re(p: &[char], i: &mut usize) -> Result<Vec<Vec<(Node, u8)>>, String> {
    let mut alts: Vec<Vec<(Node, u8)>> = vec![Vec::new()];
    while let Some(&c) = p.get(*i) {
        *i += 1;
        let node = match c {
            ')' => {
                *i -= 1;
                break;
            }
            '|' => {
                alts.push(Vec::new());
                continue;
            }
            '(' => {
                let inner = parse_re(p, i)?;
                if p.get(*i) != Some(&')') {
                    return Err("unclosed ( in pattern".to_owned());
                }
                *i += 1;
                Node::Group(inner)
            }
            '.' => Node::Any,
            '[' => {
                let mut neg = false;
                if p.get(*i) == Some(&'^') {
                    neg = true;
                    *i += 1;
                }
                let mut ranges = Vec::new();
                while let Some(&d) = p.get(*i) {
                    *i += 1;
                    if d == ']' {
                        break;
                    }
                    if p.get(*i) == Some(&'-') && p.get(*i + 1).is_some_and(|e| *e != ']') {
                        let hi = p.get(*i + 1).copied().unwrap_or(d);
                        ranges.push((d, hi));
                        *i += 2;
                    } else {
                        ranges.push((d, d));
                    }
                }
                Node::Class(ranges, neg)
            }
            '\\' => {
                let e = p.get(*i).copied().ok_or("pattern ends with \\")?;
                *i += 1;
                match e {
                    'd' => Node::Class(vec![('0', '9')], false),
                    's' => Node::Class(vec![(' ', ' '), ('\t', '\t'), ('\n', '\n')], false),
                    'w' => Node::Class(vec![('a', 'z'), ('A', 'Z'), ('0', '9'), ('_', '_')], false),
                    other => Node::Char(other),
                }
            }
            other => Node::Char(other),
        };
        // 0 once, 1 zero or more, 2 one or more, 3 zero or one.
        let rep = match p.get(*i) {
            Some('*') => 1,
            Some('+') => 2,
            Some('?') => 3,
            _ => 0,
        };
        if rep != 0 {
            *i += 1;
        }
        if let Some(last) = alts.last_mut() {
            last.push((node, rep));
        }
    }
    Ok(alts)
}

fn match_alts(alts: &[Vec<(Node, u8)>], s: &[char], pos: usize, k: &dyn Fn(usize) -> bool) -> bool {
    alts.iter().any(|seq| match_seq(seq, s, pos, k))
}

fn match_seq(seq: &[(Node, u8)], s: &[char], pos: usize, k: &dyn Fn(usize) -> bool) -> bool {
    let Some(((node, rep), rest)) = seq.split_first() else {
        return k(pos);
    };
    let one = |at: usize, next: &dyn Fn(usize) -> bool| -> bool {
        match node {
            Node::Group(inner) => match_alts(inner, s, at, next),
            _ => s.get(at).is_some_and(|c| single(node, *c)) && next(at + 1),
        }
    };
    match rep {
        0 => one(pos, &|p| match_seq(rest, s, p, k)),
        3 => one(pos, &|p| match_seq(rest, s, p, k)) || match_seq(rest, s, pos, k),
        _ => {
            fn star(
                node: &Node,
                rest: &[(Node, u8)],
                s: &[char],
                pos: usize,
                min: usize,
                k: &dyn Fn(usize) -> bool,
                one: &dyn Fn(usize, &dyn Fn(usize) -> bool) -> bool,
            ) -> bool {
                // Greedy: take another repeat first, then try to finish.
                let more = one(pos, &|p| {
                    p > pos && star(node, rest, s, p, min.saturating_sub(1), k, one)
                });
                more || (min == 0 && match_seq(rest, s, pos, k))
            }
            star(node, rest, s, pos, usize::from(*rep == 2), k, &one)
        }
    }
}

fn single(n: &Node, c: char) -> bool {
    match n {
        Node::Char(x) => *x == c,
        Node::Any => c != '\n',
        Node::Class(r, neg) => r.iter().any(|(a, b)| c >= *a && c <= *b) != *neg,
        Node::Group(_) => false,
    }
}

/// Whether the whole of `text` matches `pattern`.
pub fn regex_match(pattern: &str, text: &str) -> Result<bool, String> {
    let p: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    let alts = parse_re(&p, &mut i)?;
    if i < p.len() {
        return Err("unbalanced ) in pattern".to_owned());
    }
    let t: Vec<char> = text.chars().collect();
    let n = t.len();
    Ok(match_alts(&alts, &t, 0, &|end| end == n))
}

#[derive(Debug)]
enum Node2 {
    Text(String),
    Script(Vec<Stmt>),
    Var(String),
    /// Orca's legacy `[name[index]]`: entry `index` (a variable) of the list `name`, the first past the end.
    VarAt(String, String),
    If(Vec<(Expr, Vec<Node2>)>, Vec<Node2>),
}

/// Renders `template` with the variables of `ctx`.
pub fn render(template: &str, ctx: &Context<'_>) -> Result<String, String> {
    let nodes = parse_text(template)?;
    let mut run = Run {
        ctx,
        locals: HashMap::new(),
    };
    let mut out = String::with_capacity(template.len());
    exec(&nodes, &mut run, &mut out)?;
    Ok(out)
}

fn exec(nodes: &[Node2], run: &mut Run<'_, '_>, out: &mut String) -> Result<(), String> {
    for n in nodes {
        match n {
            Node2::Text(t) => out.push_str(t),
            Node2::Script(block) => run.run(block, out)?,
            Node2::Var(name) => {
                // Orca's legacy vector indexing: `[name_2]` is entry 2 of the list `name`.
                let legacy = name.rsplit_once('_').and_then(|(base, n)| {
                    let i: usize = n.parse().ok()?;
                    match (run.var(name).is_err(), run.var(base)) {
                        (true, Ok(Value::List(l))) => Some(l.get(i).or_else(|| l.first()).cloned()),
                        _ => None,
                    }
                });
                let v = match legacy {
                    Some(Some(v)) => v,
                    _ => run.var(name)?,
                };
                let text = match &v {
                    Value::List(l) => l
                        .get(run.ctx.extruder)
                        .or_else(|| l.first())
                        .map(Value::text)
                        .unwrap_or_default(),
                    other => other.text(),
                };
                out.push_str(&text);
            }
            Node2::VarAt(name, index) => {
                let Value::List(l) = run.var(name)? else {
                    return Err(format!("{name} is not a list"));
                };
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "an index, checked below"
                )]
                let i = run.var(index)?.num()?.max(0.0) as usize;
                out.push_str(
                    &l.get(i)
                        .or_else(|| l.first())
                        .map(Value::text)
                        .unwrap_or_default(),
                );
            }
            Node2::If(branches, other) => {
                let mut taken = false;
                for (c, body) in branches {
                    if run.eval(c)?.truthy() {
                        exec(body, run, out)?;
                        taken = true;
                        break;
                    }
                }
                if !taken {
                    exec(other, run, out)?;
                }
            }
        }
    }
    Ok(())
}

fn parse_expr_src(src: &str) -> Result<Expr, String> {
    let mut p = Parser { t: lex(src)?, i: 0 };
    let e = p.ternary()?;
    if p.peek().is_some() {
        return Err(format!("unexpected input after the expression in {{{src}}}"));
    }
    Ok(e)
}

/// Splits text into literals, `{...}` blocks and `[name]` substitutions,
/// and nests the `{if}` blocks.
fn parse_text(src: &str) -> Result<Vec<Node2>, String> {
    #[derive(Debug)]
    enum Piece {
        Node(Node2),
        If(String),
        Elsif(String),
        Else,
        Endif,
    }
    let cs: Vec<char> = src.chars().collect();
    let mut pieces: Vec<Piece> = Vec::new();
    let mut lit = String::new();
    let mut i = 0;
    let flush = |lit: &mut String, pieces: &mut Vec<Piece>| {
        if !lit.is_empty() {
            pieces.push(Piece::Node(Node2::Text(std::mem::take(lit))));
        }
    };
    while let Some(&c) = cs.get(i) {
        if c == '{' {
            let mut depth = 1;
            let mut j = i + 1;
            while let Some(&d) = cs.get(j) {
                match d {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            if depth != 0 {
                return Err("unclosed { in template".to_owned());
            }
            let body: String = cs.get(i + 1..j).unwrap_or(&[]).iter().collect();
            flush(&mut lit, &mut pieces);
            let t = body.trim();
            let starts = |w: &str| {
                t.strip_prefix(w)
                    .filter(|r| r.starts_with(char::is_whitespace) || r.starts_with('('))
                    .map(str::to_owned)
            };
            let piece = if t == "endif" {
                Piece::Endif
            } else if t == "else" {
                Piece::Else
            } else if let Some(c) = starts("elsif") {
                Piece::Elsif(c)
            } else if let Some(c) = starts("if").filter(|c| !has_then(c)) {
                Piece::If(c)
            } else {
                let mut p = Parser { t: lex(&body)?, i: 0 };
                let block = p.block(&[])?;
                Piece::Node(Node2::Script(block))
            };
            pieces.push(piece);
            i = j + 1;
        } else if c == '[' {
            let mut j = i + 1;
            while cs.get(j).is_some_and(|d| d.is_alphanumeric() || *d == '_') {
                j += 1;
            }
            let word = |from: usize| {
                let mut k = from;
                while cs.get(k).is_some_and(|d| d.is_alphanumeric() || *d == '_') {
                    k += 1;
                }
                k
            };
            let k = word(j + 1);
            let first_ok = j > i + 1 && !cs.get(i + 1).is_some_and(char::is_ascii_digit);
            if first_ok
                && cs.get(j) == Some(&'[')
                && k > j + 1
                && !cs.get(j + 1).is_some_and(char::is_ascii_digit)
                && cs.get(k) == Some(&']')
                && cs.get(k + 1) == Some(&']')
            {
                flush(&mut lit, &mut pieces);
                pieces.push(Piece::Node(Node2::VarAt(
                    cs.get(i + 1..j).unwrap_or(&[]).iter().collect(),
                    cs.get(j + 1..k).unwrap_or(&[]).iter().collect(),
                )));
                i = k + 2;
            } else if first_ok && cs.get(j) == Some(&']') {
                flush(&mut lit, &mut pieces);
                pieces.push(Piece::Node(Node2::Var(
                    cs.get(i + 1..j).unwrap_or(&[]).iter().collect(),
                )));
                i = j + 1;
            } else {
                lit.push(c);
                i += 1;
            }
        } else {
            lit.push(c);
            i += 1;
        }
    }
    flush(&mut lit, &mut pieces);

    // Nest the if blocks.
    fn build(it: &mut std::vec::IntoIter<Piece>, top: bool) -> Result<(Vec<Node2>, Option<Piece>), String> {
        let mut nodes = Vec::new();
        while let Some(p) = it.next() {
            match p {
                Piece::Node(n) => nodes.push(n),
                Piece::If(cond) => {
                    let mut branches = Vec::new();
                    let mut other = Vec::new();
                    let mut cur = parse_expr_src(&cond)?;
                    loop {
                        let (body, end) = build(it, false)?;
                        match end {
                            Some(Piece::Elsif(c)) => {
                                branches.push((cur, body));
                                cur = parse_expr_src(&c)?;
                            }
                            Some(Piece::Else) => {
                                branches.push((cur, body));
                                let (b2, e2) = build(it, false)?;
                                if !matches!(e2, Some(Piece::Endif)) {
                                    return Err("{else} must be followed by {endif}".to_owned());
                                }
                                other = b2;
                                break;
                            }
                            Some(Piece::Endif) => {
                                branches.push((cur, body));
                                break;
                            }
                            _ => return Err("{if} without {endif}".to_owned()),
                        }
                    }
                    nodes.push(Node2::If(branches, other));
                }
                end @ (Piece::Elsif(_) | Piece::Else | Piece::Endif) => {
                    if top {
                        return Err("{elsif}, {else} or {endif} without {if}".to_owned());
                    }
                    return Ok((nodes, Some(end)));
                }
            }
        }
        if top {
            Ok((nodes, None))
        } else {
            Err("{if} without {endif}".to_owned())
        }
    }
    let mut it = pieces.into_iter();
    Ok(build(&mut it, true)?.0)
}

/// Checks that `template` parses (no variables are read).
pub fn check(template: &str) -> Result<(), String> {
    parse_text(template).map(|_| ())
}

/// A `then` outside quotes marks `{if ... then ...}` as a script, not a text block.
fn has_then(cond: &str) -> bool {
    let mut in_str = false;
    let words = cond.split(|c: char| {
        if c == '"' {
            in_str = !in_str;
        }
        !in_str && !c.is_alphanumeric() && c != '_'
    });
    words.into_iter().any(|w| w == "then")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context<'static> {
        let mut c = Context::default();
        c.set_num("layer_num", 3.0);
        c.set_num("layer_z", 0.8);
        c.vars.insert(
            "first_layer_temperature".into(),
            Value::List(vec![Value::Num(215.0), Value::Num(220.0)]),
        );
        c.vars.insert(
            "filament_type".into(),
            Value::List(vec![Value::Str("PLA".into())]),
        );
        c.vars.insert(
            "print_bed_max".into(),
            Value::List(vec![Value::Num(256.0), Value::Num(250.0)]),
        );
        c
    }

    fn r(t: &str) -> String {
        render(t, &ctx()).unwrap()
    }

    #[test]
    fn values_math_and_lists() {
        assert_eq!(r("M104 S{first_layer_temperature[0] + 5}"), "M104 S220");
        assert_eq!(r("G1 Z{layer_z + 0.2}"), "G1 Z1");
        assert_eq!(
            r("{print_bed_max[0]*0.5+10} {print_bed_max[1] - 1.5 * 2}"),
            "138 247"
        );
        assert_eq!(
            r("{max(1, min(5, layer_num))} {round(2.5)} {floor(2.9)} {ceil(2.1)} {abs(-3)}"),
            "3 3 2 3 3"
        );
        assert_eq!(r("{(layer_num % 2 == 0 ? 137.0 : 187.0)}"), "187");
        assert_eq!(r("{ -1.5 * 0.8 }"), "-1.2");
        assert_eq!(r("[layer_num] and [first_layer_temperature]"), "3 and 215");
        assert_eq!(r("{digits(layer_z, 5, 2)}|{zdigits(7, 3)}"), " 0.80|007");
        // A bracket that is not a name stays as it is.
        assert_eq!(r("G1 X[1] {1}"), "G1 X[1] 1");
        // Orca's legacy `[list[index_variable]]` (the A1's flush temperature); past the end it is entry 0.
        let mut c = ctx();
        c.set_num("next_extruder", 1.0);
        assert_eq!(
            render("M109 S[first_layer_temperature[next_extruder]]", &c).unwrap(),
            "M109 S220"
        );
        c.set_num("next_extruder", 4.0);
        assert_eq!(
            render("M109 S[first_layer_temperature[next_extruder]]", &c).unwrap(),
            "M109 S215"
        );
    }

    #[test]
    fn conditionals_and_logic() {
        let t = "{if layer_num == 0}first{elsif layer_num < 4 and layer_z > 0.5}early{else}late{endif}!";
        assert_eq!(r(t), "early!");
        assert_eq!(r("{if filament_type[0] == \"PLA\" or false}pla{endif}"), "pla");
        assert_eq!(r("{if not (layer_num == 3)}x{else}y{endif}"), "y");
        assert_eq!(
            r("{if layer_num == 3 && layer_z < 1}a\n{if layer_num > 5}b{endif}c{endif}"),
            "a\nc"
        );
    }

    #[test]
    fn scripts_and_locals() {
        let t = "{local move_z = 10; if layer_z < 1 then move_z = move_z + 5; endif; move_z}";
        assert_eq!(r(t), "15");
        // A list element can be set, and lists repeat their last entry past the end.
        let mut c = ctx();
        c.vars.insert(
            "e_retracted".into(),
            Value::List(vec![Value::Num(0.0), Value::Num(0.0)]),
        );
        assert_eq!(
            render("{e_retracted[1] = 4; e_retracted[1] * 2 + e_retracted[0]}", &c).unwrap(),
            "8"
        );
        assert_eq!(r("{local a = 2; local b = a * 3;\nb}"), "6");
    }

    #[test]
    fn every_expression_statement_of_a_block_is_written() {
        // The Snapmaker U1's tool change: strings joined statement by statement, the `T` among them.
        let t = "{\nlocal z = 1.5;\n\"G91\nG1 Z\" + z + \" F600\nG90\n\";\nif layer_z < 1 then\n\"M400\n\";\nendif\n\"T\" + 2 + \"\n\";\n\"G90\n\";\n}";
        assert_eq!(r(t), "G91\nG1 Z1.5 F600\nG90\nM400\nT2\nG90\n");
        // Assignments write nothing.
        assert_eq!(r("{local a = 2; a = a + 1; a; \"x\"}"), "3x");
    }

    #[test]
    fn regex_and_tables() {
        assert!(regex_match(".*HT_MBL10.*", "x HT_MBL10 y").unwrap());
        assert!(!regex_match(".*HT_MBL10.*", "nothing").unwrap());
        assert!(regex_match("a(b|c)+d?", "abcbc").unwrap());
        assert!(regex_match("[a-c]+\\d", "abc7").unwrap());
        assert!(!regex_match("ab", "abc").unwrap());
        assert_eq!(r("{if filament_type[0] =~ /.*L.*/}L{endif}"), "L");
        assert_eq!(
            r("{interpolate_table(layer_z, (0,7000), (1,3000), (2,1000))}"),
            "3800"
        );
        assert_eq!(
            r("{interpolate_table(5, (0,1), (2,3))} {is_nil(nil)} {size(print_bed_max)}"),
            "3 true 2"
        );
    }

    #[test]
    fn errors_name_the_problem() {
        assert!(
            render("{missing_var}", &ctx())
                .unwrap_err()
                .contains("missing_var")
        );
        assert!(render("{if 1}x", &ctx()).is_err());
        assert!(render("{endif}", &ctx()).is_err());
        assert!(render("{1 +}", &ctx()).is_err());
        assert!(render("{1 / 0}", &ctx()).unwrap_err().contains("zero"));
        assert!(render("{", &ctx()).is_err());
    }

    #[test]
    fn whole_numbers_divide_as_integers() {
        // the a1's purge line: 24/20 is 1, so the feed rate is the volumetric speed times 60
        let mut c = ctx();
        c.set_num("outer_wall_volumetric_speed", 15.083);
        assert_eq!(
            render("F{outer_wall_volumetric_speed/(24/20)    * 60}", &c).unwrap(),
            "F904.98"
        );
        assert_eq!(
            r("{7/2} {7/2.0} {-7/2} {7%3} {layer_num/2} {layer_z/2}"),
            "3 3.5 -3 1 1 0.4"
        );
        // integer settings and the functions that give integers
        let cfg: serde_json::Map<String, Json> =
            serde_json::from_str(r#"{"nozzle_temperature":[215,230],"retraction_length":[1]}"#).unwrap();
        let c = Context {
            config: Some(&cfg),
            ..Context::default()
        };
        assert_eq!(
            render("{nozzle_temperature[1]/4} {retraction_length[0]/2} {round(7.6)/2} {size(nozzle_temperature)/4}", &c)
                .unwrap(),
            "57 0.5 4 0"
        );
    }

    #[test]
    fn numbers_print_with_six_significant_digits() {
        // the a1's flush and extrusion feed rates, as orca writes them
        assert_eq!(
            r("F{1508.318531} F{6.284661} F{523.84318} {0.00001} {-0.02}"),
            "F1508.32 F6.28466 F523.843 1e-05 -0.02"
        );
    }

    #[test]
    fn config_keys_are_variables() {
        let cfg: serde_json::Map<String, Json> =
            serde_json::from_str(r#"{"retract_length":["0.8","1.2"],"filament_notes":["HF_NOZZLE"],"enable_pressure_advance":["true"]}"#)
                .unwrap();
        let c = Context {
            config: Some(&cfg),
            ..Context::default()
        };
        assert_eq!(render("{retract_length[1] * 2}", &c).unwrap(), "2.4");
        assert_eq!(
            render("{filament_notes[0] =~ /.*HF_NOZZLE.*/ ? 1 : 0}", &c).unwrap(),
            "1"
        );
        assert_eq!(
            render("{if enable_pressure_advance[0] == \"true\"}pa{endif}", &c).unwrap(),
            "pa"
        );
    }
}
