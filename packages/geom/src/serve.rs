// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The engine as a process of its own for a host app: calls come in as frames on a reader and answers go out as frames
//! on a writer, one at a time and in order, until the reader closes. The host can end the process whenever it wants (a
//! call past its time limit, or one nobody waits for) and start another, as the browser ends a worker; a crash in the
//! engine ends only this process.
//!
//! A frame is a JSON text and its buffers, all little-endian: the text's length as u32 and the text, the number of
//! buffers as u32, then each buffer as its length (u32) and its bytes. A call is `{"id", "op", "request"}` and its
//! buffers are the request's `mem:N` files (N counts from 0, each read once), as the browser build has them. The answer
//! is `{"id", "result"}` with the call's output buffers (`rawOut: N` and the like, numbered as `json::take_out_files`
//! gives them), `{"id", "error"}` when the call failed, or `{"id", "panic"}` with the panic's message and place. There
//! is no other file access, so a path that is not a `mem:N` buffer fails, as in the browser.
//!
//! The process writes `HELLO` before its first answer, so a host can pass over anything written ahead of it.

use crate::json::{self, FileLoader, OutFile};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::io::{self, Read, Write};
use std::panic::AssertUnwindSafe;

/// What the process writes once, before any answer.
pub const HELLO: &[u8; 8] = b"SXGEOM1\n";

/// More buffers than any call has; a frame that says more is not one of ours.
const MAX_BUFFERS: u32 = 1 << 16;

thread_local! {
    /// The message and place of the panic that ended the current call, kept by the panic hook.
    static PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Keeps each panic's message and place for the answer, since what `catch_unwind` hands back has no place.
fn keep_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let before = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            PANIC.with(|p| {
                if let Ok(mut p) = p.try_borrow_mut() {
                    *p = Some(info.to_string());
                }
            });
            before(info);
        }));
    });
}

/// Serves the engine's operations (`json::call_value`) until `input` closes.
pub fn serve(input: impl Read, output: impl Write) -> io::Result<()> {
    serve_with(input, output, json::call_value)
}

/// Serves calls with `call` in place of the engine's operations (a test's own), until `input` closes. A write that
/// fails (the host went) ends it with that error.
pub fn serve_with(
    mut input: impl Read,
    mut output: impl Write,
    mut call: impl FnMut(&str, &Value, FileLoader<'_>) -> crate::Result<Value>,
) -> io::Result<()> {
    keep_panics();
    output.write_all(HELLO)?;
    output.flush()?;
    loop {
        let (text, files) = match read_frame(&mut input) {
            Ok(frame) => frame,
            // the host closed its end, between calls or part way into one
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        };
        let (reply, out) = answer(&text, files, &mut call);
        write_frame(&mut output, reply.to_string().as_bytes(), &out)?;
        output.flush()?;
    }
}

/// One call's answer and its output buffers.
fn answer(
    text: &[u8],
    files: Vec<Vec<u8>>,
    call: &mut impl FnMut(&str, &Value, FileLoader<'_>) -> crate::Result<Value>,
) -> (Value, Vec<OutFile>) {
    let frame: Value = match serde_json::from_slice(text) {
        Ok(v) => v,
        Err(e) => return (json!({ "id": null, "error": format!("frame: {e}") }), Vec::new()),
    };
    let id = frame.get("id").cloned().unwrap_or(Value::Null);
    let Some(op) = frame.get("op").and_then(Value::as_str) else {
        return (json!({ "id": id, "error": "frame: no op" }), Vec::new());
    };
    let request = frame.get("request").unwrap_or(&Value::Null);
    // each buffer is handed over once, without a copy
    let files = RefCell::new(files);
    let load = |path: &str| -> crate::Result<Vec<u8>> {
        path.strip_prefix("mem:")
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|n| files.borrow_mut().get_mut(n).map(std::mem::take))
            .ok_or_else(|| crate::Error::Invalid {
                what: "rawPath",
                why: format!("{path}: no such buffer"),
            })
    };
    json::take_out_files();
    PANIC.with(|p| p.borrow_mut().take());
    let ran = std::panic::catch_unwind(AssertUnwindSafe(|| call(op, request, &load)));
    let out = json::take_out_files();
    match ran {
        Ok(Ok(result)) => (json!({ "id": id, "result": result }), out),
        Ok(Err(e)) => (json!({ "id": id, "error": e.to_string() }), Vec::new()),
        Err(payload) => {
            let kept = PANIC.with(|p| p.borrow_mut().take());
            let message = kept.unwrap_or_else(|| {
                payload
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_owned())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "a panic with no message".to_owned())
            });
            (json!({ "id": id, "panic": message }), Vec::new())
        }
    }
}

fn read_u32(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_bytes(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let len = read_u32(r)? as usize;
    let mut v = vec![0u8; len];
    r.read_exact(&mut v)?;
    Ok(v)
}

/// A frame's text and buffers.
pub fn read_frame(r: &mut impl Read) -> io::Result<(Vec<u8>, Vec<Vec<u8>>)> {
    let text = read_bytes(r)?;
    let n = read_u32(r)?;
    if n > MAX_BUFFERS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame: {n} buffers"),
        ));
    }
    let mut files = Vec::with_capacity(n as usize);
    for _ in 0..n {
        files.push(read_bytes(r)?);
    }
    Ok((text, files))
}

fn len_u32(n: usize) -> io::Result<[u8; 4]> {
    u32::try_from(n)
        .map(u32::to_le_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("frame: {n} bytes do not fit")))
}

/// Writes a frame: `text` and the buffers, each output buffer in its little-endian bytes.
pub fn write_frame(w: &mut impl Write, text: &[u8], files: &[OutFile]) -> io::Result<()> {
    w.write_all(&len_u32(text.len())?)?;
    w.write_all(text)?;
    w.write_all(&len_u32(files.len())?)?;
    let mut buf = Vec::with_capacity(1 << 16);
    for f in files {
        w.write_all(&len_u32(f.ptr_len().1)?)?;
        match f {
            OutFile::Bytes(b) => w.write_all(b)?,
            OutFile::Positions(p) => {
                for chunk in p.chunks(4096) {
                    buf.clear();
                    buf.extend(chunk.iter().flatten().flat_map(|c| c.to_le_bytes()));
                    w.write_all(&buf)?;
                }
            }
            OutFile::Triangles(t) => {
                for chunk in t.chunks(4096) {
                    buf.clear();
                    buf.extend(chunk.iter().flatten().flat_map(|i| i.to_le_bytes()));
                    w.write_all(&buf)?;
                }
            }
        }
    }
    Ok(())
}
