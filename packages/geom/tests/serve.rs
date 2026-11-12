// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The engine served over a pipe (`sx_geom::serve`): calls and answers as frames, raw buffers both ways, failures and
//! panics as answers, and a process that ends when its host goes and takes nothing else down when it crashes.

use serde_json::{Value, json};
use std::io::{BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use sx_geom::json::OutFile;
use sx_geom::serve::{HELLO, read_frame, serve, serve_with, write_frame};

/// A closed cube of 8 vertices and 12 triangles in the raw form (`TriMesh::from_raw`).
fn cube_raw() -> Vec<u8> {
    let positions: [[f32; 3]; 8] = [
        [0.0, 0.0, 0.0],
        [10.0, 0.0, 0.0],
        [10.0, 10.0, 0.0],
        [0.0, 10.0, 0.0],
        [0.0, 0.0, 10.0],
        [10.0, 0.0, 10.0],
        [10.0, 10.0, 10.0],
        [0.0, 10.0, 10.0],
    ];
    let triangles: [[u32; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7],
    ];
    raw(&positions, &triangles)
}

fn raw(positions: &[[f32; 3]], triangles: &[[u32; 3]]) -> Vec<u8> {
    let mut b = Vec::with_capacity(8 + 12 * (positions.len() + triangles.len()));
    b.extend(u32::try_from(positions.len()).unwrap().to_le_bytes());
    b.extend(u32::try_from(triangles.len()).unwrap().to_le_bytes());
    b.extend(positions.iter().flatten().flat_map(|c| c.to_le_bytes()));
    b.extend(triangles.iter().flatten().flat_map(|i| i.to_le_bytes()));
    b
}

/// A call as a frame: `{id, op, request}` and its buffers.
fn frame(id: u32, op: &str, request: &Value, files: Vec<Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    let text = json!({ "id": id, "op": op, "request": request }).to_string();
    let files: Vec<OutFile> = files.into_iter().map(OutFile::Bytes).collect();
    write_frame(&mut out, text.as_bytes(), &files).unwrap();
    out
}

/// Every answer `serve_with` writes for `input`, after its HELLO.
fn answers(output: &[u8]) -> Vec<(Value, Vec<Vec<u8>>)> {
    assert_eq!(output.get(..8), Some(&HELLO[..]), "the output starts with HELLO");
    let mut r = &output[8..];
    let mut out = Vec::new();
    while !r.is_empty() {
        let (text, files) = read_frame(&mut r).unwrap();
        out.push((serde_json::from_slice(&text).unwrap(), files));
    }
    out
}

fn run(input: &[u8]) -> Vec<(Value, Vec<Vec<u8>>)> {
    let mut output = Vec::new();
    serve(input, &mut output).unwrap();
    answers(&output)
}

#[test]
fn answers_a_call_with_raw_buffers_both_ways() {
    let request = json!({ "mesh": { "rawPath": "mem:0" }, "meshOutput": "raw" });
    let mut output = Vec::new();
    serve(
        frame(7, "repair", &request, vec![cube_raw()]).as_slice(),
        &mut output,
    )
    .unwrap();
    let replies = answers(&output);
    let [(reply, files)] = replies.as_slice() else {
        panic!("one answer, got {}", replies.len())
    };
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["result"]["mesh"]["rawOut"], 0, "{reply}");
    let mesh = sx_geom::TriMesh::from_raw(&files[0], "out").unwrap();
    assert_eq!(mesh.triangles.len(), 12);
    // the same call in process gives the same answer and the same bytes
    let files_in = std::cell::RefCell::new(vec![cube_raw()]);
    let load = |_: &str| Ok(files_in.borrow_mut().remove(0));
    let direct = sx_geom::json::call_value("repair", &request, &load).unwrap();
    // compared as text: a JSON parse here may round a number's last digit, which the page's parse does not
    let (text, _) = read_frame(&mut &output[HELLO.len()..]).unwrap();
    assert_eq!(
        String::from_utf8(text).unwrap(),
        json!({ "id": 7, "result": direct }).to_string()
    );
    let OutFile::Bytes(bytes) = sx_geom::json::take_out_files().remove(0) else {
        panic!("a raw mesh")
    };
    assert_eq!(files[0], bytes);
}

#[test]
fn answers_calls_in_order_each_with_its_own_buffers() {
    let mut input = frame(
        1,
        "info",
        &json!({ "mesh": { "rawPath": "mem:0" } }),
        vec![cube_raw()],
    );
    input.extend(frame(
        2,
        "info",
        &json!({ "mesh": { "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "indices": [0, 1, 2] } }),
        vec![],
    ));
    let replies = run(&input);
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0].0["id"], 1);
    assert_eq!(replies[1].0["id"], 2);
    assert!(replies[0].0.get("result").is_some(), "{}", replies[0].0);
    assert!(replies[1].0.get("result").is_some(), "{}", replies[1].0);
    assert!(replies.iter().all(|(_, files)| files.is_empty()));
}

#[test]
fn fails_as_the_browser_build_does() {
    let unknown = json!({});
    let mut input = frame(1, "no.such.op", &unknown, vec![]);
    // a buffer is read once; a second read of it, and any path that is not a buffer, fail
    input.extend(frame(
        2,
        "info",
        &json!({ "mesh": { "rawPath": "mem:1" } }),
        vec![cube_raw()],
    ));
    input.extend(frame(
        3,
        "info",
        &json!({ "mesh": { "stlPath": "part.stl" } }),
        vec![],
    ));
    let replies = run(&input);
    let in_process = sx_geom::json::call("no.such.op", "{}").unwrap_err().to_string();
    assert_eq!(replies[0].0["error"], in_process);
    assert!(
        replies[1].0["error"]
            .as_str()
            .unwrap()
            .contains("mem:1: no such buffer"),
        "{}",
        replies[1].0
    );
    assert!(
        replies[2].0["error"].as_str().unwrap().contains("no such buffer"),
        "{}",
        replies[2].0
    );
    assert!(replies.iter().all(|(r, _)| r.get("result").is_none()));
}

#[test]
fn a_panic_becomes_an_answer_and_the_next_call_runs() {
    let mut input = frame(1, "boom", &json!({}), vec![]);
    input.extend(frame(
        2,
        "info",
        &json!({ "mesh": { "rawPath": "mem:0" } }),
        vec![cube_raw()],
    ));
    let mut output = Vec::new();
    serve_with(input.as_slice(), &mut output, |op, req, files| {
        assert!(op != "boom", "a test panic");
        sx_geom::json::call_value(op, req, files)
    })
    .unwrap();
    let replies = answers(&output);
    let panic = replies[0].0["panic"].as_str().unwrap();
    assert!(panic.contains("a test panic"), "{panic}");
    assert!(panic.contains("serve.rs"), "the place is kept: {panic}");
    assert!(replies[1].0.get("result").is_some(), "{}", replies[1].0);
}

#[test]
fn ends_when_the_input_closes() {
    assert!(run(&[]).is_empty());
    // part way into a frame
    let whole = frame(
        1,
        "info",
        &json!({ "mesh": { "rawPath": "mem:0" } }),
        vec![cube_raw()],
    );
    assert!(run(&whole[..whole.len() - 5]).is_empty());
    // a frame that is not one of ours answers nothing it can name
    let mut bad = Vec::new();
    write_frame(&mut bad, b"not json", &[]).unwrap();
    let replies = run(&bad);
    assert!(replies[0].0["error"].as_str().unwrap().starts_with("frame:"));
}

/// The child side of the process tests: this test binary run again with `SX_GEOM_SERVE_CHILD` set serves on its stdin
/// and stdout, `abort` ending it the way a crash in the kernel would. Without the variable it does nothing.
#[test]
fn serve_child() {
    let Ok(mode) = std::env::var("SX_GEOM_SERVE_CHILD") else {
        return;
    };
    let ran = serve_with(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |op, req, files| {
            if op == "abort" && mode == "abort" {
                std::process::abort();
            }
            sx_geom::json::call_value(op, req, files)
        },
    );
    std::process::exit(i32::from(ran.is_err()));
}

fn child(mode: &str) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["serve_child", "--exact", "--nocapture", "--test-threads=1"])
        .env("SX_GEOM_SERVE_CHILD", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// Reads up to and including HELLO, passing over what the test harness wrote before it.
fn skip_to_hello(r: &mut impl Read) {
    let mut last = Vec::new();
    let mut b = [0u8; 1];
    while last.as_slice() != HELLO {
        r.read_exact(&mut b).expect("HELLO before the output ends");
        last.push(b[0]);
        if last.len() > HELLO.len() {
            last.remove(0);
        }
    }
}

fn wait(child: &mut Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

#[test]
fn the_process_exits_when_its_host_goes() {
    let mut c = child("plain");
    let mut out = BufReader::new(c.stdout.take().unwrap());
    skip_to_hello(&mut out);
    let mut input = c.stdin.take().unwrap();
    input
        .write_all(&frame(
            1,
            "info",
            &json!({ "mesh": { "rawPath": "mem:0" } }),
            vec![cube_raw()],
        ))
        .unwrap();
    input.flush().unwrap();
    let (text, _) = read_frame(&mut out).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&text).unwrap()["id"], 1);
    // the host's end of the pipe closes, as when the app quits or crashes
    drop(input);
    let status = wait(&mut c, Duration::from_secs(10));
    if status.is_none() {
        let _ = c.kill();
    }
    assert!(status.is_some_and(|s| s.success()), "{status:?}");
}

#[test]
fn an_abort_ends_only_the_engine_process() {
    let mut c = child("abort");
    let mut out = BufReader::new(c.stdout.take().unwrap());
    skip_to_hello(&mut out);
    let mut input = c.stdin.take().unwrap();
    input.write_all(&frame(1, "abort", &json!({}), vec![])).unwrap();
    input.flush().unwrap();
    // no answer: the output just ends, which is how the host learns the engine went
    let mut rest = Vec::new();
    out.read_to_end(&mut rest).unwrap();
    assert!(rest.is_empty(), "{} bytes after the abort", rest.len());
    let status = wait(&mut c, Duration::from_secs(10));
    if status.is_none() {
        let _ = c.kill();
    }
    assert!(status.is_some_and(|s| !s.success()), "{status:?}");
    // and this process, the host, is still here to start another
    let mut again = child("plain");
    let mut out = BufReader::new(again.stdout.take().unwrap());
    skip_to_hello(&mut out);
    drop(again.stdin.take());
    assert!(wait(&mut again, Duration::from_secs(10)).is_some_and(|s| s.success()));
}

/// A flat grid of `n` by `n` squares, two triangles each.
fn grid(n: u32) -> Vec<u8> {
    let mut positions = Vec::with_capacity(((n + 1) * (n + 1)) as usize);
    for y in 0..=n {
        for x in 0..=n {
            positions.push([small(x) * 0.1, small(y) * 0.1, small((x * 7 + y * 13) % 5) * 0.01]);
        }
    }
    let mut triangles = Vec::with_capacity((2 * n * n) as usize);
    for y in 0..n {
        for x in 0..n {
            let a = y * (n + 1) + x;
            triangles.push([a, a + 1, a + n + 2]);
            triangles.push([a, a + n + 2, a + n + 1]);
        }
    }
    raw(&positions, &triangles)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// The time of a call of about a million triangles in process and over a pipe to the served process, for the notes:
/// `cargo test -p sx-geom --release --test serve -- --ignored --nocapture`.
#[test]
#[ignore = "a timing, run by hand"]
fn timing_a_million_triangles() {
    let mesh = grid(708);
    println!("mesh: {} bytes in the raw form", mesh.len());
    for (op, request) in [
        ("info", json!({ "mesh": { "rawPath": "mem:0" } })),
        (
            "repair",
            json!({ "mesh": { "rawPath": "mem:0" }, "meshOutput": "raw" }),
        ),
    ] {
        let mut direct = Vec::new();
        for _ in 0..5 {
            let files = std::cell::RefCell::new(Some(mesh.clone()));
            let load = |_: &str| Ok(files.borrow_mut().take().unwrap_or_default());
            let t = Instant::now();
            sx_geom::json::call_value(op, &request, &load).unwrap();
            let out: usize = sx_geom::json::take_out_files()
                .iter()
                .map(|f| f.ptr_len().1)
                .sum();
            direct.push(t.elapsed().as_secs_f64() * 1000.0);
            assert!(op == "info" || out > 0);
        }
        let mut c = child("plain");
        let mut out = BufReader::with_capacity(1 << 20, c.stdout.take().unwrap());
        skip_to_hello(&mut out);
        let mut input = c.stdin.take().unwrap();
        let mut piped = Vec::new();
        let mut back = 0usize;
        for id in 0..5 {
            let f = frame(id, op, &request, vec![mesh.clone()]);
            let t = Instant::now();
            input.write_all(&f).unwrap();
            input.flush().unwrap();
            let (text, files) = read_frame(&mut out).unwrap();
            piped.push(t.elapsed().as_secs_f64() * 1000.0);
            back = files.iter().map(Vec::len).sum();
            assert!(
                serde_json::from_slice::<Value>(&text)
                    .unwrap()
                    .get("result")
                    .is_some()
            );
        }
        drop(input);
        let _ = wait(&mut c, Duration::from_secs(30));
        println!(
            "{op}: in process {:.1} ms, over the pipe {:.1} ms (median of 5; {} bytes in, {back} bytes back)",
            median(direct),
            median(piped),
            mesh.len()
        );
    }
}

/// A grid coordinate as f32: they stay far below 2^16.
fn small(v: u32) -> f32 {
    f32::from(u16::try_from(v).unwrap())
}
