// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The Model engine (sx-geom with the exact kernel) in a process of its own, for the page's native geometry provider
//! (packages/app/src/geom/native-provider.ts), which the page uses in place of its geometry worker when asked
//! (apps/desktop/src/host/geom-native.ts). The process is this app's own binary started with `ENGINE_ARG` and nothing
//! else: it serves calls over its stdin and stdout (`sx_geom::serve`) and does nothing more, no window, no plugins and
//! no app data. One call runs at a time. The page ends the process when a call runs past its limit or is canceled while
//! it runs (`geom_end`), and the next call starts another, as the browser ends and starts its worker; a crash in the
//! engine ends only that process. It exits when the app's end of its pipe closes, when the app goes, and on the app's
//! exit.

use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

/// The one argument that starts this binary as the engine process. A file the system opens with the app arrives as its
/// full path and a link as `scheme://...`, so neither can be this.
pub const ENGINE_ARG: &str = "--sx-geom-engine";
/// The app's process id, for the engine process to watch.
const PARENT_ENV: &str = "SX_GEOM_ENGINE_PARENT";
/// What the engine writes before its first answer (`sx_geom::serve::HELLO`).
const HELLO: &[u8] = sx_geom::serve::HELLO;

/// Whether this launch is the engine process: exactly one argument, and it is `ENGINE_ARG`.
pub fn is_engine_launch() -> bool {
    let mut args = std::env::args_os().skip(1);
    args.next().is_some_and(|a| a == ENGINE_ARG) && args.next().is_none()
}

/// The engine process: serves calls until the app's end of the pipe closes or the app goes, then exits.
pub fn engine_main() -> ! {
    watch_parent();
    let output = std::io::BufWriter::with_capacity(1 << 20, std::io::stdout().lock());
    let served = sx_geom::serve::serve(std::io::stdin().lock(), output);
    std::process::exit(i32::from(served.is_err()))
}

/// Exits when the app that started this process is gone, even while a call runs (a closed pipe is only seen between
/// calls).
fn watch_parent() {
    let Some(pid) = std::env::var(PARENT_ENV).ok().and_then(|p| p.parse::<u32>().ok()) else {
        return;
    };
    std::thread::spawn(move || {
        wait_for(pid);
        std::process::exit(0);
    });
}

#[cfg(unix)]
fn wait_for(pid: u32) {
    // an orphan is handed to another parent
    while std::os::unix::process::parent_id() == pid {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

#[cfg(windows)]
fn wait_for(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    // SAFETY: OpenProcess takes plain values; a failure (the app is gone already) returns an error, and we exit.
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
        return;
    };
    // SAFETY: the handle is a valid process handle opened above with SYNCHRONIZE; it is closed once, after the wait.
    unsafe {
        WaitForSingleObject(handle, INFINITE);
        let _ = CloseHandle(handle);
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The pipes of the running engine process and its number.
struct Pipes {
    generation: u32,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

/// The engine process the page's calls go to, started on the first call and again after it ends.
pub struct Engine {
    /// How the process starts: this binary with `ENGINE_ARG`; a test's own stand-in.
    command: fn() -> Command,
    /// The running process's pipes, held by the call that runs.
    pipes: Mutex<Option<Pipes>>,
    /// The running process, to end it by its handle while a call holds the pipes.
    child: Mutex<Option<(u32, Child)>>,
    generation: AtomicU32,
}

impl Engine {
    pub fn new(command: fn() -> Command) -> Self {
        Self {
            command,
            pipes: Mutex::new(None),
            child: Mutex::new(None),
            generation: AtomicU32::new(0),
        }
    }

    /// The engine as the app runs it: this binary started again with `ENGINE_ARG`.
    pub fn app() -> Self {
        Self::new(|| {
            let mut c = Command::new(std::env::current_exe().unwrap_or_else(|_| "slicerx".into()));
            c.arg(ENGINE_ARG);
            c
        })
    }

    fn start(&self) -> Result<Pipes, String> {
        let mut cmd = (self.command)();
        crate::launch::no_window(&mut cmd)
            .env(PARENT_ENV, std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("The geometry engine did not start: {e}"))?;
        let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The geometry engine did not start: no pipes".into());
        };
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        *lock(&self.child) = Some((generation, child));
        let mut output = BufReader::with_capacity(1 << 20, output);
        if let Err(e) = skip_to_hello(&mut output) {
            self.reap(generation);
            return Err(format!("The geometry engine did not start: {e}"));
        }
        Ok(Pipes {
            generation,
            input,
            output,
        })
    }

    /// Waits for the process `generation` once it has ended or been ended, and gives its exit code.
    fn reap(&self, generation: u32) -> Option<i32> {
        let taken = {
            let mut c = lock(&self.child);
            if c.as_ref().is_some_and(|(g, _)| *g == generation) {
                c.take()
            } else {
                None
            }
        };
        taken.and_then(|(_, mut child)| {
            let _ = child.kill();
            child.wait().ok().and_then(|s| s.code())
        })
    }

    /// Whether the process `generation` has exited.
    fn exited(&self, generation: u32) -> bool {
        let mut c = lock(&self.child);
        match c.as_mut() {
            Some((g, child)) if *g == generation => !matches!(child.try_wait(), Ok(None)),
            _ => true,
        }
    }

    /// One call: its frame in, and out the number of the process that answered (u32, little-endian) and the answer's
    /// frame. When the process ends first, the error is `{"ended": true, "code": ...}` as JSON.
    pub fn call(&self, frame: &[u8]) -> Result<Vec<u8>, String> {
        let mut pipes = lock(&self.pipes);
        // a process that went while no call ran (ended from outside, or crashed between calls) never saw this call:
        // it goes to a new one, as a call queued behind an ended worker goes to the next worker
        if let Some(g) = pipes.as_ref().map(|p| p.generation)
            && self.exited(g)
        {
            *pipes = None;
            self.reap(g);
        }
        if pipes.is_none() {
            *pipes = Some(self.start()?);
        }
        let Some(p) = pipes.as_mut() else {
            return Err("The geometry engine did not start".into());
        };
        let generation = p.generation;
        let mut answer = generation.to_le_bytes().to_vec();
        let ran = p
            .input
            .write_all(frame)
            .and_then(|()| p.input.flush())
            .and_then(|()| read_frame(&mut p.output, &mut answer));
        match ran {
            Ok(()) => Ok(answer),
            Err(_) => {
                *pipes = None;
                let code = self.reap(generation);
                Err(serde_json::json!({ "ended": true, "code": code }).to_string())
            }
        }
    }

    /// Ends the running process by its handle; a call it was running fails as ended, and the next call starts another.
    pub fn end(&self) {
        let generation = {
            let mut c = lock(&self.child);
            c.as_mut().map(|(g, child)| {
                let _ = child.kill();
                *g
            })
        };
        // nobody is in a call to see it go: let it go here
        if let Some(g) = generation
            && let Ok(mut pipes) = self.pipes.try_lock()
        {
            *pipes = None;
            self.reap(g);
        }
    }
}

/// Reads up to and including HELLO.
fn skip_to_hello(r: &mut impl Read) -> std::io::Result<()> {
    let mut last = Vec::with_capacity(HELLO.len());
    let mut b = [0u8; 1];
    while last.as_slice() != HELLO {
        r.read_exact(&mut b)?;
        last.push(b[0]);
        if last.len() > HELLO.len() {
            last.remove(0);
        }
    }
    Ok(())
}

/// Reads one frame onto `out` as it came (a u32 length and the text, a u32 count, each buffer as a u32 length and its
/// bytes), so the page gets it without a copy made here to parse it.
fn read_frame(r: &mut impl Read, out: &mut Vec<u8>) -> std::io::Result<()> {
    let text = read_u32(r, out)? as usize;
    read_onto(r, out, text)?;
    let count = read_u32(r, out)?;
    for _ in 0..count {
        let len = read_u32(r, out)? as usize;
        read_onto(r, out, len)?;
    }
    Ok(())
}

/// Reads a u32 length onto `out` and gives it.
fn read_u32(r: &mut impl Read, out: &mut Vec<u8>) -> std::io::Result<u32> {
    let mut n = [0u8; 4];
    r.read_exact(&mut n)?;
    out.extend_from_slice(&n);
    Ok(u32::from_le_bytes(n))
}

fn read_onto(r: &mut impl Read, out: &mut Vec<u8>, len: usize) -> std::io::Result<()> {
    let at = out.len();
    out.resize(at + len, 0);
    r.read_exact(&mut out[at..])
}

/// One engine call from the page: the call's frame as the raw body, the answer as raw bytes.
#[tauri::command]
pub async fn geom_call(request: Request<'_>, engine: State<'_, Arc<Engine>>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("geom_call expects raw bytes".into());
    };
    let frame = bytes.clone();
    let engine = Arc::clone(&engine);
    let answer = tauri::async_runtime::spawn_blocking(move || engine.call(&frame))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(answer))
}

/// Ends the engine process now (a call past its limit, or canceled while it runs).
#[tauri::command]
pub async fn geom_end(engine: State<'_, Arc<Engine>>) -> Result<(), String> {
    let engine = Arc::clone(&engine);
    tauri::async_runtime::spawn_blocking(move || engine.end())
        .await
        .map_err(|e| e.to_string())
}

/// That this build runs the engine natively, and `SLICERX_NATIVE_GEOM` when set: 1 has the page use it, 0 keeps the
/// worker whatever the developer setting says.
#[tauri::command]
pub fn geom_engine() -> serde_json::Value {
    serde_json::json!({ "native": true, "env": std::env::var("SLICERX_NATIVE_GEOM").ok() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::time::{Duration, Instant};

    /// The engine process for these tests: this test binary run again with `SX_GEOM_HOST_CHILD`, serving as the app's
    /// engine mode does, `abort` ending it the way a crash in the kernel would.
    #[test]
    fn engine_child() {
        let Ok(mode) = std::env::var("SX_GEOM_HOST_CHILD") else {
            return;
        };
        watch_parent();
        let served = sx_geom::serve::serve_with(
            std::io::stdin().lock(),
            std::io::stdout().lock(),
            |op, req, files| {
                if op == "abort" && mode == "abort" {
                    std::process::abort();
                }
                if op == "sleep" {
                    std::thread::sleep(Duration::from_secs(60));
                }
                sx_geom::json::call_value(op, req, files)
            },
        );
        std::process::exit(i32::from(served.is_err()));
    }

    fn child(mode: &'static str) -> Command {
        let mut c = Command::new(std::env::current_exe().unwrap());
        // `start` sets this for every engine command; it is set here too, where the shell's check of each
        // `Command::new` looks for it.
        crate::launch::no_window(&mut c);
        c.args([
            "geom_host::tests::engine_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ]);
        c.env("SX_GEOM_HOST_CHILD", mode);
        c
    }

    fn frame(id: u32, op: &str, request: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        sx_geom::serve::write_frame(
            &mut out,
            json!({ "id": id, "op": op, "request": request })
                .to_string()
                .as_bytes(),
            &[],
        )
        .unwrap();
        out
    }

    /// The answer's process number and its JSON.
    fn answer(bytes: &[u8]) -> (u32, Value) {
        let generation = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let (text, _) = sx_geom::serve::read_frame(&mut &bytes[4..]).unwrap();
        (generation, serde_json::from_slice(&text).unwrap())
    }

    const TRIANGLE: &str = r#"{"mesh":{"positions":[0,0,0,1,0,0,0,1,0],"indices":[0,1,2]}}"#;

    #[test]
    fn answers_calls_in_one_process() {
        let engine = Engine::new(|| child("plain"));
        let req: Value = serde_json::from_str(TRIANGLE).unwrap();
        let (g1, a) = answer(&engine.call(&frame(1, "info", &req)).unwrap());
        let (g2, b) = answer(&engine.call(&frame(2, "info", &req)).unwrap());
        assert_eq!((g1, g2), (1, 1));
        assert!(a.get("result").is_some() && b.get("result").is_some(), "{a} {b}");
        engine.end();
    }

    #[test]
    fn a_crash_fails_the_call_and_the_next_call_starts_another_process() {
        let engine = Engine::new(|| child("abort"));
        let err = engine.call(&frame(1, "abort", &json!({}))).unwrap_err();
        let ended: Value = serde_json::from_str(&err).unwrap();
        assert_eq!(ended["ended"], true, "{err}");
        let req: Value = serde_json::from_str(TRIANGLE).unwrap();
        let (generation, a) = answer(&engine.call(&frame(2, "info", &req)).unwrap());
        assert_eq!(generation, 2);
        assert!(a.get("result").is_some(), "{a}");
        engine.end();
    }

    #[test]
    fn ending_a_running_call_frees_the_engine_at_once() {
        let engine = Arc::new(Engine::new(|| child("plain")));
        let req: Value = serde_json::from_str(TRIANGLE).unwrap();
        engine.call(&frame(1, "info", &req)).unwrap();
        let running = Arc::clone(&engine);
        let stuck = std::thread::spawn(move || running.call(&frame(2, "sleep", &json!({}))));
        std::thread::sleep(Duration::from_millis(300));
        let t = Instant::now();
        engine.end();
        assert!(stuck.join().unwrap().is_err());
        assert!(t.elapsed() < Duration::from_secs(10));
        let (generation, _) = answer(&engine.call(&frame(3, "info", &req)).unwrap());
        assert_eq!(generation, 2);
        engine.end();
    }

    #[test]
    fn a_process_that_went_between_calls_is_replaced_before_the_next_call() {
        let engine = Engine::new(|| child("plain"));
        let req: Value = serde_json::from_str(TRIANGLE).unwrap();
        engine.call(&frame(1, "info", &req)).unwrap();
        // ended from outside while no call runs
        if let Some((_, c)) = lock(&engine.child).as_mut() {
            c.kill().unwrap();
            c.wait().unwrap();
        }
        let (generation, a) = answer(&engine.call(&frame(2, "info", &req)).unwrap());
        assert_eq!(generation, 2);
        assert!(a.get("result").is_some(), "{a}");
        engine.end();
    }

    #[test]
    fn the_engine_mode_takes_only_its_own_argument() {
        // the check reads this process's arguments; the test harness's are never the engine's
        assert!(!is_engine_launch());
        assert!(!ENGINE_ARG.contains('/') && !ENGINE_ARG.contains('\\') && !ENGINE_ARG.contains("://"));
    }
}
