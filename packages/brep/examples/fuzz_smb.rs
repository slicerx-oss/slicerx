// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feeds the kernel's text reader damaged saves, sealed again so they get past the hash, to learn how it copes. Nothing
// untrusted reaches it in the product (a saved body is the app's own cache), so this is about robustness, not a
// gate. Each case is written to the case file before it runs, so a crash leaves it behind; run it through
// scripts/fuzz-smb.sh, which caps memory and time.
//
// cargo run -p sx-brep --release --example fuzz_smb -- <cases> <seed> <case file>
use serde_json::{Value, json};

fn call(op: &str, req: &Value) -> Result<Value, String> {
    sx_brep::call(op, &req.to_string()).map(|r| serde_json::from_str(&r).expect("reply is JSON"))
}

fn saved(op: &str, req: &Value) -> String {
    let mut r = req.clone();
    r["save"] = json!(true);
    let out = call(op, &r).expect("a seed body");
    out["bodySmb"].as_str().expect("saved").to_owned()
}

// the same seal sx_brep.cpp writes: FNV-1a 64 of the text, as a last line
fn sealed(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    format!("{text}//sx-brep fnv1a64 {h:016x}\n")
}

fn unsealed(text: &str) -> &str {
    &text[..text.rfind("//sx-brep fnv1a64 ").expect("a seal")]
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.next() % n.max(1) as u64).unwrap_or(0)
    }
}

const NUMBERS: [&str; 9] = [
    "0",
    "-1",
    "1e308",
    "-1e308",
    "nan",
    "inf",
    "4294967295",
    "2147483648",
    "99999999999",
];

fn mutate(text: &str, rng: &mut Rng) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    for _ in 0..=rng.below(4) {
        if lines.is_empty() {
            break;
        }
        let i = rng.below(lines.len());
        match rng.below(6) {
            0 => {
                lines.remove(i);
            }
            1 => {
                let l = lines[i].clone();
                lines.insert(i, l);
            }
            2 => {
                let j = rng.below(lines.len());
                lines.swap(i, j);
            }
            3 => {
                // one number token replaced with an awkward one
                let mut words: Vec<String> = lines[i].split(' ').map(str::to_owned).collect();
                let w = rng.below(words.len());
                NUMBERS[rng.below(NUMBERS.len())].clone_into(&mut words[w]);
                lines[i] = words.join(" ");
            }
            4 => {
                let keep = rng.below(lines.len());
                lines.truncate(keep);
            }
            _ => {
                let mut bytes = lines[i].clone().into_bytes();
                if !bytes.is_empty() {
                    let b = rng.below(bytes.len());
                    bytes[b] = b"0123456789-.e x"[rng.below(15)];
                }
                lines[i] = String::from_utf8_lossy(&bytes).into_owned();
            }
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn main() {
    if !sx_brep::KERNEL {
        eprintln!("this build has no kernel");
        std::process::exit(2);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cases: usize = args.first().and_then(|a| a.parse().ok()).unwrap_or(1000);
    let seed: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(1);
    let case_file = args.get(2).cloned().unwrap_or_else(|| "fuzz-case.smb".to_owned());
    let block = json!({ "min": [0, 0, 0], "max": [20, 20, 20] });
    let hole = json!([{ "type": "cylinder", "origin": [10, 10, 0], "axis": [0, 0, 1], "diameterMm": 8, "heightMm": 20 }]);
    let b = call("box", &block).expect("a box")["body"].clone();
    let seeds = [
        saved("box", &block),
        saved(
            "cylinder",
            &json!({ "origin": [0, 0, 0], "axis": [0, 0, 1], "diameterMm": 10, "heightMm": 5 }),
        ),
        saved("subtract", &json!({ "body": b, "solids": hole })),
        call(
            "cut",
            &json!({ "body": b, "plane": { "point": [0, 0, 8], "normal": [0, 1, 1] }, "save": true }),
        )
        .expect("a cut")["belowSmb"]
            .as_str()
            .expect("saved")
            .to_owned(),
    ];
    let mut rng = Rng(seed.max(1));
    let (mut read, mut refused) = (0, 0);
    for n in 0..cases {
        let text = mutate(unsealed(&seeds[rng.below(seeds.len())]), &mut rng);
        let case = sealed(&text);
        std::fs::write(&case_file, &case).expect("write the case");
        match call("info", &json!({ "body": { "smb": case } })) {
            Ok(_) => read += 1,
            Err(_) => refused += 1,
        }
        if n % 100 == 99 {
            eprintln!("{} cases: {read} read, {refused} refused", n + 1);
        }
    }
    println!("{cases} cases, seed {seed}: {read} read, {refused} refused, no crash");
}
