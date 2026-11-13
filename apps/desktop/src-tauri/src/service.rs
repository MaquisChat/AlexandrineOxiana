//! Starting and stopping the library service (R155). The shell starts ONE helper, the service, which
//! starts the media worker itself.
//!
//! - Started with an allow-listed environment only (`env_clear`, then `helper_env::service_env`).
//! - The token is written as one line on the service's standard input, which then stays open for
//!   the service's whole life: its end means "shut down cleanly" (rule 3). So if the shell crashes
//!   or is killed, the service stops by itself, and the worker stops when the service's pipe to it
//!   closes.
//! - Ready when it prints `AO_SERVICE_READY port=<n>`, within a time limit; otherwise it is stopped
//!   and the reason is a plain sentence.
//! - After the token, the shell writes on the same pipe only folder grant lines (grant.rs, R207),
//!   through `ServiceInput::send_line`. Writing and closing take the same lock, so a grant is either
//!   written whole before the close or refused after it; once closing has begun every send is
//!   refused at once, and a close that cannot take the lock in time (a write stuck on a service that
//!   no longer reads) gives way to the forced stop, whose kill ends the stuck write.
//! - On POSIX systems it runs in its own process group, which the worker inherits: stopping waits
//!   until no process of that group is left, then forces (SIGKILL to the group) after a time limit.
//!   On Linux the shell is a "child subreaper", so the worker, orphaned when the service exits
//!   first, is reaped by the shell and does not linger as a zombie of the group.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

/// The service's standard input after the token line, shared by the shell's stop and the folder
/// chooser's grant (see the module comment). Cloning shares the same pipe and lock.
#[derive(Clone)]
pub struct ServiceInput {
    pipe: Arc<Mutex<Option<ChildStdin>>>,
    closing: Arc<AtomicBool>,
}

impl ServiceInput {
    fn new(stdin: Option<ChildStdin>) -> Self {
        ServiceInput { pipe: Arc::new(Mutex::new(stdin)), closing: Arc::new(AtomicBool::new(false)) }
    }

    /// Writes `line` whole under the pipe's lock. False when the pipe is closed or closing, or the
    /// write failed (the service has exited); a failed write does not close the pipe.
    pub fn send_line(&self, line: &str) -> bool {
        if self.closing.load(Ordering::SeqCst) {
            return false;
        }
        let mut guard = match self.pipe.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if self.closing.load(Ordering::SeqCst) {
            return false;
        }
        let Some(stdin) = guard.as_mut() else { return false };
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).is_ok()
    }

    /// Closes the pipe (the service then shuts down cleanly). Sends are refused from the first
    /// moment; the close itself waits for a write in progress, until `deadline`. False if the lock
    /// could not be taken by then (the pipe is then still open).
    fn close_by(&self, deadline: Instant) -> bool {
        self.closing.store(true, Ordering::SeqCst);
        loop {
            match self.pipe.try_lock() {
                Ok(mut g) => {
                    drop(g.take());
                    return true;
                }
                Err(TryLockError::Poisoned(p)) => {
                    drop(p.into_inner().take());
                    return true;
                }
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}

/// What to run.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    /// The whole environment (nothing else is inherited).
    pub env: Vec<(OsString, OsString)>,
}

/// The documented start of the built service folder (ADR 0013, START.txt): the 512 MB heap ceiling
/// (R64, R96), which the program cannot set for itself, and no other argument.
pub fn service_args(service_dir: &std::path::Path) -> Vec<OsString> {
    vec!["--max-old-space-size=512".into(), service_dir.join("service.mjs").into_os_string()]
}

pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug)]
pub enum StartError {
    Spawn,
    Timeout(Duration),
    Exited { message: Option<String> },
}

impl StartError {
    /// A plain sentence for the user (no path, no token).
    pub fn user_message(&self) -> String {
        match self {
            StartError::Spawn => "The library service could not be started.".into(),
            StartError::Timeout(d) => format!("The library service did not become ready within {} seconds.", d.as_secs()),
            StartError::Exited { message: Some(m) } => m.clone(),
            StartError::Exited { message: None } => "The library service stopped while it was starting.".into(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Stopped {
    /// Everything exited by itself after standard input closed.
    Clean,
    /// The time limit passed; the rest was killed.
    Forced,
}

pub struct Service {
    child: Child,
    input: ServiceInput,
    pub port: u16,
}

/// The port in a ready line, if `line` is one.
pub fn parse_ready_line(line: &str) -> Option<u16> {
    let rest = line.trim_end().strip_prefix("AO_SERVICE_READY port=")?;
    if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    rest.parse::<u16>().ok().filter(|p| *p != 0)
}

/// A start-up refusal the service printed: its own plain sentence (it never carries the token,
/// R96, R98), with any file-system path in it replaced, since a system error can name one.
fn plain_reason(line: &str) -> Option<String> {
    let l = line.trim();
    (l.starts_with("The library service will not start:") || l.starts_with("The library service could not start:")).then(|| scrub_paths(l))
}

fn looks_like_path(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() > 1 && b[0] == b'/') || s.starts_with("~/") || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || s.starts_with("\\\\")
}

/// Replaces quoted and unquoted paths (POSIX, home-relative, Windows) with "[a folder]".
fn scrub_paths(s: &str) -> String {
    const PATH: &str = "[a folder]";
    // Quoted paths first: they may contain spaces.
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(['\'', '"']) {
        let q = rest[i..].chars().next().unwrap();
        out.push_str(&rest[..=i]);
        let after = &rest[i + 1..];
        match after.find(q) {
            Some(j) if looks_like_path(&after[..j]) => {
                out.push_str(PATH);
                out.push(q);
                rest = &after[j + 1..];
            }
            _ => rest = after,
        }
    }
    out.push_str(rest);
    // Then unquoted ones, word by word.
    out.split(' ').map(|w| if looks_like_path(w) { PATH } else { w }).collect::<Vec<_>>().join(" ")
}

/// Makes this process the reaper of its orphaned descendants (Linux), so a helper whose parent
/// exited first is reaped here and not left as a zombie.
pub fn become_subreaper() {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong);
    }
}

pub fn start(launch: &Launch, token: &str, ready_timeout: Duration, log: LogFn) -> Result<Service, StartError> {
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .current_dir(&launch.cwd)
        .env_clear()
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|_| StartError::Spawn)?;
    let mut stdin = child.stdin.take();
    if let Some(s) = stdin.as_mut() {
        // A write error means the service is already gone; that is reported below as its exit.
        let _ = s.write_all(format!("{token}\n").as_bytes()).and_then(|_| s.flush());
    }

    let (tx, rx) = mpsc::channel::<u16>();
    let reasons: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    {
        let log = log.clone();
        std::thread::spawn(move || {
            let mut sent = false;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if !sent {
                    if let Some(port) = parse_ready_line(&line) {
                        sent = true;
                        let _ = tx.send(port);
                        continue;
                    }
                }
                log(&line);
            }
            // The sender is dropped here: the receiver sees the end of output.
        });
    }
    {
        let reasons = reasons.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if let Some(r) = plain_reason(&line) {
                    *reasons.lock().unwrap() = Some(r);
                }
                log(&line);
            }
        });
    }

    let mut service = Service { child, input: ServiceInput::new(stdin), port: 0 };
    match rx.recv_timeout(ready_timeout) {
        Ok(port) => {
            service.port = port;
            Ok(service)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            service.kill_all();
            Err(StartError::Timeout(ready_timeout))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            // Its output ended: it exited. Give its last error line a moment to arrive.
            let _ = service.wait_gone(Duration::from_secs(5));
            service.kill_all();
            std::thread::sleep(Duration::from_millis(100));
            let message = reasons.lock().unwrap().clone();
            Err(StartError::Exited { message })
        }
    }
}

impl Service {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Whether the service has exited (it is then reaped).
    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    /// The service's standard input, for a grant line (grant.rs); it shares the lock `stop` closes under.
    pub fn input(&self) -> ServiceInput {
        self.input.clone()
    }

    /// Closes the service's standard input (it then shuts down cleanly, and stops the worker), waits
    /// up to `grace` for every process of its group to be gone, and otherwise kills them.
    pub fn stop(&mut self, grace: Duration) -> Stopped {
        let deadline = Instant::now() + grace;
        if self.input.close_by(deadline) && self.wait_gone(deadline.saturating_duration_since(Instant::now())) {
            return Stopped::Clean;
        }
        self.kill_all();
        Stopped::Forced
    }

    /// Kills the service's process group, then closes its standard input: killing first ends any
    /// write blocked on a service that no longer reads, so the close never waits on it.
    fn kill_all(&mut self) {
        self.input.closing.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.input.close_by(Instant::now() + Duration::from_secs(5));
        let _ = self.wait_gone(Duration::from_secs(5));
    }

    /// True once the service and (POSIX) every other process of its group have exited and been reaped.
    fn wait_gone(&mut self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            let service_gone = matches!(self.child.try_wait(), Ok(Some(_)));
            if service_gone && self.group_gone() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    fn group_gone(&self) -> bool {
        let pgid = self.child.id() as libc::pid_t;
        unsafe {
            // Reap any member that is our child (the worker, once this process adopted it).
            while libc::waitpid(-pgid, std::ptr::null_mut(), libc::WNOHANG) > 0 {}
            libc::kill(-pgid, 0) == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }

    #[cfg(not(unix))]
    fn group_gone(&self) -> bool {
        true
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) || !self.group_gone() {
            self.kill_all();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ao-desktop-svc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn node() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|d| d.join("node")).find(|p| p.is_file()).expect("node on PATH")
    }

    /// A stand-in service: reads the token line, records it and its environment, starts a child
    /// that (like the worker) stops when its own standard input closes, prints the ready line, and
    /// (unless told otherwise) stops when its standard input ends.
    const STUB: &str = r#"
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [dir, mode] = [process.env.STUB_DIR, process.env.STUB_MODE];
const lines = createInterface({ input: process.stdin });
let first = true;
lines.on("line", (line) => {
  if (first) { first = false; return; }
  appendFileSync(dir + "/lines", line + "\n");
});
lines.once("line", (token) => {
  writeFileSync(dir + "/token", token);
  writeFileSync(dir + "/env.json", JSON.stringify(process.env));
  if (mode === "refuse") { console.error("The library service will not start: a plain reason."); process.exit(1); }
  const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);"], { stdio: ["pipe", "ignore", "ignore"] });
  writeFileSync(dir + "/child.pid", String(child.pid));
  if (mode === "silent") return;
  console.log("some log line");
  console.log("AO_SERVICE_READY port=43210");
});
if (mode === "stubborn") { process.on("SIGTERM", () => {}); }
else lines.once("close", () => setTimeout(() => process.exit(0), 100));
setInterval(() => {}, 1000);
"#;

    fn launch(dir: &Path, mode: &str) -> Launch {
        let script = dir.join("stub.mjs");
        fs::write(&script, STUB).unwrap();
        Launch {
            program: node(),
            args: vec![script.into_os_string()],
            cwd: dir.to_path_buf(),
            env: vec![("STUB_DIR".into(), dir.as_os_str().to_owned()), ("STUB_MODE".into(), mode.into())],
        }
    }

    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn quiet() -> LogFn {
        Arc::new(|_| {})
    }

    #[test]
    fn ready_lines() {
        assert_eq!(parse_ready_line("AO_SERVICE_READY port=43210"), Some(43210));
        assert_eq!(parse_ready_line("AO_SERVICE_READY port=43210\r\n"), Some(43210));
        for bad in ["AO_SERVICE_READY port=", "AO_SERVICE_READY port=0", "AO_SERVICE_READY port=70000", "AO_SERVICE_READY port=12 x", "x AO_SERVICE_READY port=1", "AO_SERVICE_READY port=-1"] {
            assert_eq!(parse_ready_line(bad), None, "{bad}");
        }
    }

    #[test]
    fn starts_with_the_token_on_stdin_only_and_stops_cleanly_when_stdin_closes() {
        become_subreaper();
        let dir = tmp("clean");
        let logs = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let l2 = logs.clone();
        let mut s = start(&launch(&dir, "ok"), TOKEN, Duration::from_secs(30), Arc::new(move |l| l2.lock().unwrap().push(l.to_string()))).unwrap();
        assert_eq!(s.port, 43210);
        assert_eq!(fs::read_to_string(dir.join("token")).unwrap(), TOKEN);
        let env: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("env.json")).unwrap()).unwrap();
        let mut names: Vec<&String> = env.as_object().unwrap().keys().collect();
        names.sort();
        assert_eq!(names, ["STUB_DIR", "STUB_MODE"]);
        assert!(!fs::read_to_string(dir.join("env.json")).unwrap().contains(TOKEN));
        let pid = s.pid() as i32;
        #[cfg(target_os = "linux")]
        {
            let cmdline = fs::read(format!("/proc/{pid}/cmdline")).unwrap();
            assert!(!String::from_utf8_lossy(&cmdline).contains(TOKEN));
        }
        let child: i32 = fs::read_to_string(dir.join("child.pid")).unwrap().parse().unwrap();
        assert!(alive(pid) && alive(child));
        let t0 = Instant::now();
        assert_eq!(s.stop(Duration::from_secs(20)), Stopped::Clean);
        assert!(t0.elapsed() < Duration::from_secs(10));
        assert!(!alive(pid) && !alive(child));
        assert!(logs.lock().unwrap().iter().any(|l| l == "some log line"));
        assert!(!logs.lock().unwrap().iter().any(|l| l.contains(TOKEN)));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn forces_the_stop_after_the_time_limit() {
        become_subreaper();
        let dir = tmp("forced");
        let mut s = start(&launch(&dir, "stubborn"), TOKEN, Duration::from_secs(30), quiet()).unwrap();
        let pid = s.pid() as i32;
        let child: i32 = fs::read_to_string(dir.join("child.pid")).unwrap().parse().unwrap();
        assert_eq!(s.stop(Duration::from_millis(1500)), Stopped::Forced);
        assert!(!alive(pid) && !alive(child));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_service_that_is_not_ready_in_time_is_stopped() {
        become_subreaper();
        let dir = tmp("timeout");
        let err = start(&launch(&dir, "silent"), TOKEN, Duration::from_secs(2), quiet()).err().unwrap();
        assert!(matches!(err, StartError::Timeout(_)));
        assert_eq!(err.user_message(), "The library service did not become ready within 2 seconds.");
        let child: i32 = fs::read_to_string(dir.join("child.pid")).unwrap().parse().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!alive(child));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_refusal_is_reported_in_the_services_own_plain_words() {
        become_subreaper();
        let dir = tmp("refuse");
        let err = start(&launch(&dir, "refuse"), TOKEN, Duration::from_secs(30), quiet()).err().unwrap();
        assert_eq!(err.user_message(), "The library service will not start: a plain reason.");
        let mut bad = launch(&dir, "ok");
        bad.program = dir.join("no-such-program");
        assert!(matches!(start(&bad, TOKEN, Duration::from_secs(5), quiet()).err().unwrap(), StartError::Spawn));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_refusal_names_no_path() {
        assert_eq!(
            plain_reason("The library service could not start: EACCES: permission denied, mkdir '/home/r/.config/alexandrine oxiana'").unwrap(),
            "The library service could not start: EACCES: permission denied, mkdir '[a folder]'"
        );
        assert_eq!(
            plain_reason(r"The library service could not start: EPERM, open C:\Users\r\AppData\x.json").unwrap(),
            "The library service could not start: EPERM, open [a folder]"
        );
        assert_eq!(plain_reason("The library service will not start: NODE_PATH is set.").unwrap(), "The library service will not start: NODE_PATH is set.");
        assert_eq!(plain_reason("anything else"), None);
    }

    #[test]
    fn a_line_sent_after_the_token_reaches_the_service_on_the_same_pipe() {
        become_subreaper();
        let dir = tmp("line");
        let mut s = start(&launch(&dir, "ok"), TOKEN, Duration::from_secs(30), quiet()).unwrap();
        let input = s.input();
        assert!(input.send_line("{\"type\":\"folder-grant\"}\n"));
        assert!(input.send_line("second\n"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while fs::read_to_string(dir.join("lines")).map(|l| l.lines().count()).unwrap_or(0) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(fs::read_to_string(dir.join("lines")).unwrap(), "{\"type\":\"folder-grant\"}\nsecond\n");
        assert_eq!(fs::read_to_string(dir.join("token")).unwrap(), TOKEN);
        assert_eq!(s.stop(Duration::from_secs(20)), Stopped::Clean);
        // Closed by the stop: nothing more is written.
        assert!(!input.send_line("late\n"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_send_racing_the_shutdown_neither_deadlocks_nor_writes_after_the_close() {
        become_subreaper();
        let dir = tmp("race");
        let mut s = start(&launch(&dir, "ok"), TOKEN, Duration::from_secs(30), quiet()).unwrap();
        let input = s.input();
        let sender = std::thread::spawn(move || {
            let mut sent = 0u32;
            while input.send_line("x\n") {
                sent += 1;
            }
            // Once refused, refused for good.
            assert!(!input.send_line("x\n"));
            sent
        });
        std::thread::sleep(Duration::from_millis(100));
        let t0 = Instant::now();
        assert_eq!(s.stop(Duration::from_secs(20)), Stopped::Clean);
        assert!(t0.elapsed() < Duration::from_secs(10));
        let sent = sender.join().unwrap();
        assert!(sent > 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_send_to_a_service_that_has_exited_is_refused() {
        become_subreaper();
        let dir = tmp("exited");
        let mut s = start(&launch(&dir, "ok"), TOKEN, Duration::from_secs(30), quiet()).unwrap();
        let input = s.input();
        unsafe {
            libc::kill(-(s.pid() as libc::pid_t), libc::SIGKILL);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !s.has_exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(s.has_exited());
        // The pipe's reader is gone: the write fails (EPIPE; SIGPIPE is ignored by Rust programs).
        assert!(!input.send_line("{\"type\":\"folder-grant\"}\n"));
        drop(s);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_documented_arguments() {
        let a = service_args(Path::new("/app/library-service"));
        assert_eq!(a, [OsString::from("--max-old-space-size=512"), OsString::from("/app/library-service/service.mjs")]);
    }
}
