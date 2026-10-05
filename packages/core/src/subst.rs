// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! G-code substitutions (`gcode_substitutions`): find and replace over the finished file.
//! The setting is a flat list of four strings per rule: what to find, what to put in its place,
//! the options and a note. Options: `r` the find text is a regular expression, `i` ignore case,
//! `w` whole words only, `s` single line (`^` and `$` match only at the ends of the file).
//! Replacement text may use `$1` to `$9`, `${n}`, `$&` and the escapes `\n`, `\t`, `\\`, `\$`.
//!
//! The matcher is a small backtracking one over bytes: literals, `.`, classes with ranges and
//! `\d \w \s`, groups with alternation, `* + ? {n,m}` (greedy, or lazy with a trailing `?`), and
//! the anchors `^ $ \b`. It stops after a step budget, so a hostile pattern cannot stall the slicer.

/// One rule of the setting.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools, reason = "one flag per option letter")]
pub struct Rule {
    pub find: String,
    pub replace: String,
    pub regex: bool,
    pub icase: bool,
    pub word: bool,
    pub single_line: bool,
}

/// Rules from the flat list the profile stores (four entries per rule; a short tail is dropped).
pub fn rules(list: &[String]) -> Vec<Rule> {
    list.as_chunks::<4>()
        .0
        .iter()
        .filter_map(|c| {
            let [find, replace, params, _note] = c;
            (!find.is_empty()).then(|| Rule {
                find: find.clone(),
                replace: replace.clone(),
                regex: params.contains('r'),
                icase: params.contains('i'),
                word: params.contains('w'),
                single_line: params.contains('s'),
            })
        })
        .collect()
}

#[derive(Debug, Clone)]
enum Atom {
    Byte(u8),
    Any,
    Class { ranges: Vec<(u8, u8)>, negate: bool },
    Group(Vec<Vec<Item>>, Option<usize>),
    LineStart,
    LineEnd,
    WordEdge,
}

#[derive(Debug, Clone)]
struct Item {
    atom: Atom,
    min: usize,
    max: usize,
    lazy: bool,
}

/// A compiled pattern.
#[derive(Debug, Clone)]
pub struct Regex {
    alts: Vec<Vec<Item>>,
    groups: usize,
    icase: bool,
    single_line: bool,
}

struct Parser<'a> {
    src: &'a [u8],
    pos: usize,
    groups: usize,
}

const UNBOUNDED: usize = usize::MAX;

fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn class_of(kind: u8) -> Vec<(u8, u8)> {
    match kind.to_ascii_lowercase() {
        b'd' => vec![(b'0', b'9')],
        b'w' => vec![(b'a', b'z'), (b'A', b'Z'), (b'0', b'9'), (b'_', b'_')],
        _ => vec![(b' ', b' '), (b'\t', b'\r')],
    }
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn alt(&mut self, depth: u32) -> Result<Vec<Vec<Item>>, String> {
        if depth > 24 {
            return Err("pattern nests too deeply".to_owned());
        }
        let mut alts = vec![Vec::new()];
        while let Some(c) = self.peek() {
            match c {
                b')' => break,
                b'|' => {
                    self.pos += 1;
                    alts.push(Vec::new());
                }
                _ => {
                    let atom = self.atom(depth)?;
                    let (min, max) = self.quantifier()?;
                    let lazy = min != 1 || max != 1;
                    let lazy = lazy && self.peek() == Some(b'?') && {
                        self.pos += 1;
                        true
                    };
                    if let Some(last) = alts.last_mut() {
                        last.push(Item { atom, min, max, lazy });
                    }
                }
            }
        }
        Ok(alts)
    }

    fn quantifier(&mut self) -> Result<(usize, usize), String> {
        let q = match self.peek() {
            Some(b'*') => (0, UNBOUNDED),
            Some(b'+') => (1, UNBOUNDED),
            Some(b'?') => (0, 1),
            Some(b'{') => return self.braces(),
            _ => return Ok((1, 1)),
        };
        self.pos += 1;
        Ok(q)
    }

    fn braces(&mut self) -> Result<(usize, usize), String> {
        let close = self
            .src
            .get(self.pos..)
            .and_then(|s| s.iter().position(|&b| b == b'}'))
            .ok_or("unterminated {n,m}")?;
        let body = String::from_utf8_lossy(self.src.get(self.pos + 1..self.pos + close).unwrap_or_default())
            .into_owned();
        self.pos += close + 1;
        let bad = || format!("bad repeat {{{body}}}");
        let (lo, hi) = match body.split_once(',') {
            None => {
                let n: usize = body.trim().parse().map_err(|_| bad())?;
                (n, n)
            }
            Some((a, b)) => (
                a.trim().parse().map_err(|_| bad())?,
                if b.trim().is_empty() {
                    UNBOUNDED
                } else {
                    b.trim().parse().map_err(|_| bad())?
                },
            ),
        };
        if lo > 1000 || (hi != UNBOUNDED && (hi > 1000 || hi < lo)) {
            return Err(bad());
        }
        Ok((lo, hi))
    }

    fn atom(&mut self, depth: u32) -> Result<Atom, String> {
        let c = self.peek().ok_or("unexpected end of pattern")?;
        self.pos += 1;
        Ok(match c {
            b'.' => Atom::Any,
            b'^' => Atom::LineStart,
            b'$' => Atom::LineEnd,
            b'(' => {
                let mut index = None;
                if self.src.get(self.pos..self.pos + 2) == Some(b"?:") {
                    self.pos += 2;
                } else {
                    self.groups += 1;
                    index = Some(self.groups);
                }
                let alts = self.alt(depth + 1)?;
                if self.peek() != Some(b')') {
                    return Err("missing )".to_owned());
                }
                self.pos += 1;
                Atom::Group(alts, index)
            }
            b'[' => self.class()?,
            b'\\' => {
                let e = self.peek().ok_or("trailing backslash")?;
                self.pos += 1;
                match e {
                    b'd' | b'w' | b's' | b'D' | b'W' | b'S' => Atom::Class {
                        ranges: class_of(e),
                        negate: e.is_ascii_uppercase(),
                    },
                    b'b' => Atom::WordEdge,
                    b'n' => Atom::Byte(b'\n'),
                    b't' => Atom::Byte(b'\t'),
                    b'r' => Atom::Byte(b'\r'),
                    o => Atom::Byte(o),
                }
            }
            b'*' | b'+' | b'?' => return Err(format!("nothing to repeat before {}", char::from(c))),
            o => Atom::Byte(o),
        })
    }

    fn class(&mut self) -> Result<Atom, String> {
        let mut negate = false;
        if self.peek() == Some(b'^') {
            negate = true;
            self.pos += 1;
        }
        let mut ranges = Vec::new();
        let mut first = true;
        loop {
            let c = self.peek().ok_or("missing ]")?;
            self.pos += 1;
            if c == b']' && !first {
                break;
            }
            first = false;
            let lo = if c == b'\\' {
                let e = self.peek().ok_or("trailing backslash")?;
                self.pos += 1;
                if matches!(e, b'd' | b'w' | b's') {
                    ranges.extend(class_of(e));
                    continue;
                }
                match e {
                    b'n' => b'\n',
                    b't' => b'\t',
                    o => o,
                }
            } else {
                c
            };
            if self.peek() == Some(b'-') && self.src.get(self.pos + 1).is_some_and(|&n| n != b']') {
                let hi = self.src.get(self.pos + 1).copied().unwrap_or(lo);
                self.pos += 2;
                if hi < lo {
                    return Err("reversed range".to_owned());
                }
                ranges.push((lo, hi));
            } else {
                ranges.push((lo, lo));
            }
        }
        Ok(Atom::Class { ranges, negate })
    }
}

const STEP_LIMIT: u32 = 2_000_000;

type Caps = Vec<Option<(usize, usize)>>;

struct Matcher<'a> {
    re: &'a Regex,
    text: &'a [u8],
    caps: Caps,
    steps: u32,
}

impl Matcher<'_> {
    fn eq(&self, a: u8, b: u8) -> bool {
        a == b || (self.re.icase && a.eq_ignore_ascii_case(&b))
    }

    /// True when the single byte atom matches the byte at `pos`.
    fn one(&self, atom: &Atom, pos: usize) -> Option<bool> {
        let &c = self.text.get(pos)?;
        Some(match atom {
            Atom::Byte(b) => self.eq(c, *b),
            Atom::Any => c != b'\n',
            Atom::Class { ranges, negate } => {
                let hit = |x: u8| ranges.iter().any(|&(lo, hi)| (lo..=hi).contains(&x));
                let inside =
                    hit(c) || (self.re.icase && (hit(c.to_ascii_lowercase()) || hit(c.to_ascii_uppercase())));
                inside != *negate
            }
            _ => false,
        })
    }

    fn alt(&mut self, alts: &[Vec<Item>], pos: usize, k: &mut dyn FnMut(&mut Self, usize) -> bool) -> bool {
        for seq in alts {
            if self.seq(seq, pos, k) {
                return true;
            }
        }
        false
    }

    fn seq(&mut self, items: &[Item], pos: usize, k: &mut dyn FnMut(&mut Self, usize) -> bool) -> bool {
        match items.split_first() {
            None => k(self, pos),
            Some((item, rest)) => self.rep(item, rest, pos, k),
        }
    }

    fn rep(
        &mut self,
        item: &Item,
        rest: &[Item],
        pos: usize,
        k: &mut dyn FnMut(&mut Self, usize) -> bool,
    ) -> bool {
        self.steps += 1;
        if self.steps > STEP_LIMIT {
            return false;
        }
        if matches!(item.atom, Atom::Byte(_) | Atom::Any | Atom::Class { .. }) {
            // A single byte atom: count how far it runs and try the lengths in order, without recursion per byte.
            let mut n = 0;
            while n < item.max && self.one(&item.atom, pos + n) == Some(true) {
                n += 1;
            }
            if n < item.min {
                return false;
            }
            let order: Box<dyn Iterator<Item = usize>> = if item.lazy {
                Box::new(item.min..=n)
            } else {
                Box::new((item.min..=n).rev())
            };
            for len in order {
                if self.seq(rest, pos + len, k) {
                    return true;
                }
            }
            return false;
        }
        self.rep_general(item, rest, 0, pos, k)
    }

    #[allow(
        clippy::if_same_then_else,
        reason = "the two orders differ: lazy stops first, greedy repeats first"
    )]
    fn rep_general(
        &mut self,
        item: &Item,
        rest: &[Item],
        count: usize,
        pos: usize,
        k: &mut dyn FnMut(&mut Self, usize) -> bool,
    ) -> bool {
        self.steps += 1;
        if self.steps > STEP_LIMIT {
            return false;
        }
        let try_more = |me: &mut Self, k: &mut dyn FnMut(&mut Self, usize) -> bool| -> bool {
            if count >= item.max {
                return false;
            }
            me.atom_once(item, pos, &mut |m, p| {
                if p == pos && count >= item.min {
                    return false;
                }
                m.rep_general(item, rest, count + 1, p, k)
            })
        };
        let try_stop = |me: &mut Self, k: &mut dyn FnMut(&mut Self, usize) -> bool| -> bool {
            count >= item.min && me.seq(rest, pos, k)
        };
        if item.lazy {
            try_stop(self, k) || try_more(self, k)
        } else {
            try_more(self, k) || try_stop(self, k)
        }
    }

    fn atom_once(&mut self, item: &Item, pos: usize, k: &mut dyn FnMut(&mut Self, usize) -> bool) -> bool {
        match &item.atom {
            Atom::Group(alts, index) => {
                let index = *index;
                let old = index.and_then(|i| self.caps.get(i).copied());
                let hit = self.alt(alts, pos, &mut |m, end| {
                    let saved = index.and_then(|i| m.caps.get(i).copied());
                    if let Some(slot) = index.and_then(|i| m.caps.get_mut(i)) {
                        *slot = Some((pos, end));
                    }
                    if k(m, end) {
                        return true;
                    }
                    if let Some(slot) = index.and_then(|i| m.caps.get_mut(i)) {
                        *slot = saved.flatten();
                    }
                    false
                });
                if !hit && let Some(slot) = index.and_then(|i| self.caps.get_mut(i)) {
                    *slot = old.flatten();
                }
                hit
            }
            Atom::LineStart => {
                let ok = pos == 0 || (!self.re.single_line && self.text.get(pos - 1) == Some(&b'\n'));
                ok && k(self, pos)
            }
            Atom::LineEnd => {
                let ok =
                    pos == self.text.len() || (!self.re.single_line && self.text.get(pos) == Some(&b'\n'));
                ok && k(self, pos)
            }
            Atom::WordEdge => {
                let before = pos > 0 && self.text.get(pos - 1).is_some_and(|&b| word(b));
                let after = self.text.get(pos).is_some_and(|&b| word(b));
                before != after && k(self, pos)
            }
            atom => self.one(atom, pos) == Some(true) && k(self, pos + 1),
        }
    }
}

/// What a search found: the whole match and each group, as byte ranges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub caps: Vec<Option<(usize, usize)>>,
}

impl Regex {
    pub fn new(pattern: &str, icase: bool, single_line: bool) -> Result<Self, String> {
        let mut p = Parser {
            src: pattern.as_bytes(),
            pos: 0,
            groups: 0,
        };
        let alts = p.alt(0)?;
        if p.pos < pattern.len() {
            return Err("unbalanced )".to_owned());
        }
        Ok(Self {
            alts,
            groups: p.groups,
            icase,
            single_line,
        })
    }

    /// The first match starting at or after `from`.
    pub fn find(&self, text: &[u8], from: usize) -> Option<Found> {
        let mut m = Matcher {
            re: self,
            text,
            caps: vec![None; self.groups + 1],
            steps: 0,
        };
        for start in from..=text.len() {
            m.caps.fill(None);
            let mut end = None;
            if m.alt(&self.alts, start, &mut |_, p| {
                end = Some(p);
                true
            }) {
                let mut caps = m.caps.clone();
                if let (Some(slot), Some(e)) = (caps.first_mut(), end) {
                    *slot = Some((start, e));
                }
                return Some(Found { caps });
            }
            if m.steps > STEP_LIMIT {
                return None;
            }
        }
        None
    }
}

fn expand(replace: &str, text: &[u8], caps: &[Option<(usize, usize)>], out: &mut Vec<u8>) {
    let r = replace.as_bytes();
    let mut i = 0;
    while let Some(&c) = r.get(i) {
        i += 1;
        match c {
            b'\\' => match r.get(i) {
                Some(b'n') => {
                    out.push(b'\n');
                    i += 1;
                }
                Some(b't') => {
                    out.push(b'\t');
                    i += 1;
                }
                Some(&o) => {
                    out.push(o);
                    i += 1;
                }
                None => out.push(b'\\'),
            },
            b'$' => {
                let (idx, adv) = match r.get(i) {
                    Some(b'&') => (Some(0), 1),
                    Some(b'{') => {
                        let close = r.get(i..).and_then(|s| s.iter().position(|&b| b == b'}'));
                        match close.and_then(|c| {
                            std::str::from_utf8(r.get(i + 1..i + c)?)
                                .ok()?
                                .parse::<usize>()
                                .ok()
                                .map(|n| (n, c + 1))
                        }) {
                            Some((n, a)) => (Some(n), a),
                            None => (None, 0),
                        }
                    }
                    Some(d) if d.is_ascii_digit() => (Some(usize::from(d - b'0')), 1),
                    _ => (None, 0),
                };
                match idx {
                    Some(n) => {
                        i += adv;
                        if let Some(&Some((a, b))) = caps.get(n) {
                            out.extend_from_slice(text.get(a..b).unwrap_or_default());
                        }
                    }
                    None => out.push(b'$'),
                }
            }
            o => out.push(o),
        }
    }
}

/// Applies the rules, in order, to the whole file. A rule whose pattern does not compile is
/// skipped and named in the returned errors.
pub fn apply(text: &[u8], rules: &[Rule]) -> (Vec<u8>, Vec<String>) {
    let mut cur = text.to_vec();
    let mut errors = Vec::new();
    for rule in rules {
        let mut pattern = if rule.regex {
            rule.find.clone()
        } else {
            escape(&rule.find)
        };
        if rule.word {
            pattern = format!("\\b(?:{pattern})\\b");
        }
        let re = match Regex::new(&pattern, rule.icase, rule.single_line) {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("{}: {e}", rule.find));
                continue;
            }
        };
        let mut out = Vec::with_capacity(cur.len());
        let mut at = 0;
        let mut copied = 0;
        while at <= cur.len() {
            let Some(f) = re.find(&cur, at) else { break };
            let Some(Some((s, e))) = f.caps.first().copied() else {
                break;
            };
            out.extend_from_slice(cur.get(copied..s).unwrap_or_default());
            expand(&rule.replace, &cur, &f.caps, &mut out);
            copied = e;
            at = if e == s { e + 1 } else { e };
            if e == s
                && let Some(&b) = cur.get(s)
            {
                out.push(b);
                copied = s + 1;
            }
        }
        out.extend_from_slice(cur.get(copied..).unwrap_or_default());
        cur = out;
    }
    (cur, errors)
}

fn escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if "\\.^$|?*+()[]{}".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, find: &str, replace: &str, params: &str) -> String {
        let list = vec![
            find.to_owned(),
            replace.to_owned(),
            params.to_owned(),
            String::new(),
        ];
        String::from_utf8(apply(text.as_bytes(), &rules(&list)).0).unwrap()
    }

    #[test]
    fn plain_text_replaces_every_occurrence() {
        assert_eq!(
            run("M104 S200\nM104 S210\n", "M104", "M109", ""),
            "M109 S200\nM109 S210\n"
        );
        assert_eq!(run("a.b a.b", "a.b", "X", ""), "X X");
    }

    #[test]
    fn options_ignore_case_and_whole_words() {
        assert_eq!(run("G1 g1 G10", "g1", "T", "iw"), "T T G10");
        assert_eq!(run("G1 G10", "G1", "T", "w"), "T G10");
    }

    #[test]
    fn regex_with_groups_and_replacement_references() {
        assert_eq!(
            run("G1 X10 Y20\nG1 X5 Y6\n", r"X(\d+) Y(\d+)", "Y$2 X${1}", "r"),
            "G1 Y20 X10\nG1 Y6 X5\n"
        );
        assert_eq!(
            run("M106 S255\n", r"^M106 S(\d+)$", "M106 S128 ; was $&", "r"),
            "M106 S128 ; was M106 S255\n"
        );
        assert_eq!(run("E1.5 E2.25", r"E(\d+)\.(\d+)", "E$1,$2", "r"), "E1,5 E2,25");
    }

    #[test]
    fn anchors_lazy_quantifiers_alternation_and_classes() {
        assert_eq!(run("a\nb\n", "^", "> ", "r"), "> a\n> b\n> ");
        assert_eq!(run("a\nb\n", "^", "> ", "rs"), "> a\nb\n");
        assert_eq!(run("<a><b>", "<.+?>", "T", "r"), "TT");
        assert_eq!(run("<a><b>", "<.+>", "T", "r"), "T");
        assert_eq!(run("cat dog bird", "cat|bird", "X", "r"), "X dog X");
        assert_eq!(run("a1b22c333", "[0-9]{2,3}", "#", "r"), "a1b#c#");
        assert_eq!(run("x   y", r"\s+", " ", "r"), "x y");
    }

    #[test]
    fn bad_patterns_are_reported_and_skipped() {
        let list: Vec<String> = ["(a", "X", "r", "", "a", "b", "", ""]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let (out, errors) = apply(b"aaa", &rules(&list));
        assert_eq!(out, b"bbb");
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn a_hostile_pattern_ends() {
        let text = "a".repeat(3000);
        let _ = run(&text, "(a*)*b", "x", "r");
    }

    #[test]
    fn the_rules_come_four_to_a_rule() {
        let list: Vec<String> = ["a", "b", "r", "note", "c"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let r = rules(&list);
        assert_eq!(r.len(), 1);
        assert!(r[0].regex && !r[0].icase);
    }
}
