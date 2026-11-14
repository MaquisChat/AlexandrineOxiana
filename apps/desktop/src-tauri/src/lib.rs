//! The desktop shell (Task 37c, R155). It starts ONE helper, the library service (which starts the
//! media worker), hands the interface its connection, provides native pickers and dropped-file
//! paths through the Tauri dialog plugin and the web view's drop events, and stops everything when
//! it closes. No library logic lives here: every decision about a library is the service's.
//!
//! Start-up: find the helpers (`paths`), make the token (`token`), start the service with the
//! allow-listed environment (`helper_env`) and the token on its standard input, wait for its ready
//! line (`service`), then create the window with the connection script (`connection`). If the
//! service does not become ready, a plain error window is shown and the program exits non-zero; no
//! empty window is ever shown.
//!
//! Closing: when the last window closes (or on SIGTERM, SIGINT or SIGHUP), the event loop ends, the
//! service's standard input is closed (it shuts down cleanly and stops the worker), and the shell
//! waits until both are gone, forcing the stop after SHUTDOWN_GRACE. If the shell is killed outright
//! (SIGKILL, a crash), the closed pipe stops the service, and the service's closed pipe stops the
//! worker (R155 rule 3).

pub mod connection;
pub mod grant;
pub mod helper_env;
pub mod library_window;
pub mod paths;
#[cfg(debug_assertions)]
pub mod probe;
pub mod service;
pub mod token;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::service::{Launch, Service, Stopped};

/// How long the service may take to print its ready line (building the index of a large library
/// can make the first start slow; a loaded machine too).
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long closing waits for the service and the worker: longer than the service's own forced
/// exit (FORCE_EXIT_MS, 90 s: an import reaching a safe point, then the rest), so the service
/// normally finishes by itself; after it, the rest is killed.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(95);

const APP_NAME: &str = "Alexandrine Oxiana";

/// How long a start-up error window waits for a person before the program exits by itself (its
/// helpers are already stopped by then); a few seconds in test mode.
fn fail_window_limit() -> Duration {
    if test_mode() { Duration::from_secs(3) } else { Duration::from_secs(600) }
}

#[derive(Default)]
struct Shell {
    service: Mutex<Option<Service>>,
    stopping: AtomicBool,
    /// Closing has begun: the helpers are being stopped while the single-instance guard is held.
    closing: AtomicBool,
    /// The helpers are confirmed gone: the event loop may now end (and release the guard).
    helpers_stopped: AtomicBool,
    /// Someone opened the app again while it was closing: it starts again once the helpers are gone.
    relaunch: AtomicBool,
    /// Start-up failed: the program exits non-zero however its error window is closed.
    failed: AtomicBool,
    /// The watched-folder chooser: one at a time.
    picker: grant::Picker,
    /// The sign-in window (Task F16): its ticket, its fetch, its store.
    library: Arc<library_window::Library>,
}

impl grant::GrantTarget for Shell {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst)
    }

    /// The running service's standard input; None once a stop has taken the service or it has exited.
    fn service_input(&self) -> Option<service::ServiceInput> {
        let mut guard = self.service.lock().unwrap_or_else(|p| p.into_inner());
        let svc = guard.as_mut()?;
        if svc.has_exited() {
            return None;
        }
        Some(svc.input())
    }
}

/// Debug builds only: with NODE_ENV=test the shell reports what the launch check needs on its
/// standard output (never the token) and takes `close` on its standard input (R47).
fn test_mode() -> bool {
    cfg!(debug_assertions) && std::env::var("NODE_ENV").as_deref() == Ok("test")
}

fn log_helper(line: &str) {
    eprintln!("[service] {line}");
}

/// Reports a start-up failure at once on standard error, stops what was started, shows a plain
/// error window, and exits non-zero when it is closed or after `fail_window_limit()` unanswered
/// (so an unattended start, or the launch check, never waits on a window no one sees).
fn fail(app: &AppHandle, shell: &Shell, message: &str) -> ! {
    eprintln!("{APP_NAME} could not start: {message}");
    if test_mode() {
        println!("AO_SHELL_FAILED {message}");
    }
    shell.stopping.store(true, Ordering::SeqCst);
    shell.failed.store(true, Ordering::SeqCst);
    let started = shell.service.lock().unwrap().take();
    if let Some(mut s) = started {
        s.stop(Duration::from_secs(10));
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let dialog = app
        .dialog()
        .message(format!("{message}\n\nThe app will close. If this keeps happening, reinstall the app."))
        .title(format!("{APP_NAME} could not start"))
        .kind(MessageDialogKind::Error);
    std::thread::spawn(move || {
        dialog.blocking_show();
        let _ = tx.send(());
    });
    // Closed by a person, or unanswered after the limit: exit either way (nothing is left running).
    let _ = rx.recv_timeout(fail_window_limit());
    std::process::exit(1);
}

fn launch(app: AppHandle, shell: Arc<Shell>, main_thread: std::thread::ThreadId) {
    let resources = app.path().resource_dir().ok();
    let helpers = match paths::resolve(resources.as_deref(), &paths::Overrides::from_env()) {
        Ok(p) => p,
        Err(m) => fail(&app, &shell, &m),
    };
    let data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => fail(&app, &shell, "The app's data folder could not be found."),
    };
    // Everything the service keeps lives under the shell's own data folder (R159), whose place is
    // decided by the app identifier (tauri.conf.json `identifier`, the one place it is defined):
    // app settings, pairings and the outbox (`settings/`), the tools and the speech models.
    let config_dir = data.join("settings");
    let tools_dir = data.join("tools");
    let models_dir = data.join("models");
    for d in [&config_dir, &tools_dir, &models_dir] {
        let _ = std::fs::create_dir_all(d);
    }
    // The sign-in window (Task F16): its inbox emptied and its store emptied unless kept, before
    // anything else runs (this also catches a forced quit, a crash or a power loss).
    shell.library.configure(library_window::Config {
        device: data.join(library_window::DEVICE_FILE),
        config_dir: config_dir.clone(),
        test_mode: test_mode(),
        main_thread,
    });
    let _ = library_window::empty_inbox(&config_dir);
    shell.library.at_start(&library_host(&app, &shell));
    let token = match token::new_token() {
        Ok(t) => t,
        Err(m) => fail(&app, &shell, &format!("A new access key could not be made: {m}.")),
    };
    let env = helper_env::service_env(
        std::env::vars_os(),
        &helper_env::ServiceConfig { worker_bin: helpers.worker_bin.as_deref(), config_dir: &config_dir, tools_dir: &tools_dir, models_dir: &models_dir },
    );
    let launch = Launch { program: helpers.node.clone(), args: service::service_args(&helpers.service_dir), cwd: helpers.service_dir.clone(), env };
    let svc = match service::start(&launch, &token, READY_TIMEOUT, Arc::new(log_helper)) {
        Ok(s) => s,
        Err(e) => fail(&app, &shell, &e.user_message()),
    };
    let port = svc.port;
    if test_mode() {
        println!("AO_SHELL_SERVICE pid={} port={port} shell={}", svc.pid(), std::process::id());
    }
    *shell.service.lock().unwrap() = Some(svc);

    let script = connection::init_script(&connection::base_url(port), &token);
    drop(token);
    let mut builder = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .title(APP_NAME)
        .inner_size(1280.0, 820.0)
        .min_inner_size(800.0, 560.0)
        .initialization_script(script)
        .on_navigation(|url| connection::navigation_allowed(url))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .devtools(cfg!(debug_assertions));
    if test_mode() {
        builder = builder.on_document_title_changed(|_, title| println!("AO_SHELL_TITLE {title}"));
        #[cfg(debug_assertions)]
        if let Some(dir) = std::env::var_os("AO_SHELL_PROBE_DIR") {
            builder = builder.initialization_script(probe::script(std::path::Path::new(&dir)));
        }
    }
    match builder.build() {
        Ok(w) => {
            // Closing the main window closes the sign-in window too, so the app still quits.
            let main_app = app.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    if let Some(l) = main_app.get_webview_window(library_window::LABEL) {
                        let _ = l.close();
                    }
                }
            });
            if test_mode() {
                println!("AO_SHELL_WINDOW label={} visible={}", w.label(), w.is_visible().unwrap_or(false));
            }
        }
        Err(_) => fail(&app, &shell, "The app's window could not be opened."),
    }
    watch_service(app, shell);
}

/// If the service stops on its own while the app runs, say so and close.
fn watch_service(app: AppHandle, shell: Arc<Shell>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        if shell.stopping.load(Ordering::SeqCst) {
            return;
        }
        let exited = shell.service.lock().unwrap().as_mut().map(|s| s.has_exited()).unwrap_or(false);
        if exited && !shell.stopping.swap(true, Ordering::SeqCst) {
            eprintln!("{APP_NAME}: the library service stopped unexpectedly");
            app.dialog()
                .message("The library service stopped unexpectedly, so the app has to close. Your libraries were not changed by this; open the app again to continue.")
                .title(APP_NAME)
                .kind(MessageDialogKind::Error)
                .blocking_show();
            app.exit(1);
            return;
        }
    });
}

fn focus_main(app: &AppHandle, shell: &Shell) {
    if shell.closing.load(Ordering::SeqCst) {
        // Opened again while closing: once the helpers are gone, the app starts again by itself.
        shell.relaunch.store(true, Ordering::SeqCst);
        if test_mode() {
            println!("AO_SHELL_RELAUNCH_REQUESTED");
        }
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if test_mode() {
        println!("AO_SHELL_SECOND_LAUNCH");
    }
}

/// The watched-folder chooser (Task W6, R207): the system's own folder chooser, ONE folder, started
/// here (the page passes only a title). The chosen path goes to the service as a grant line on its
/// standard input (grant.rs), written under the lock the shutdown closes that pipe under; the page
/// receives only `{grantId, name}`, or null when the choice was cancelled, the window is not the main
/// window, the chooser is already open, the app is closing, the service has exited, the folder is a
/// root or cannot be put in a grant line, or the write failed (see `grant::pick_with`). Granted to the main window only (capabilities/main-window.json); the browser
/// extension's token is the service's affair and reaches no shell command (it is not a window of
/// this app and has no IPC).
#[tauri::command]
async fn pick_watch_folder(app: AppHandle, window: tauri::WebviewWindow, title: String) -> Option<serde_json::Value> {
    let shell = app.try_state::<Arc<Shell>>()?.inner().clone();
    let label = window.label().to_string();
    let dialog = app.dialog().file().set_title(grant::chooser_title(&title)).set_parent(&window);
    // The checks, the chooser and the hand-over (grant::pick_with, tested there), off the main thread.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        grant::pick_with(&shell.picker, &label, &*shell, || dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()))
    })
    .await
    .ok()??;
    Some(picked.to_json())
}

/// The sign-in window's controller with the app as its host.
fn library_host(app: &AppHandle, shell: &Arc<Shell>) -> library_window::TauriHost {
    library_window::TauriHost::new(app.clone(), shell.library.clone(), shell.clone())
}

/// Runs `f` on a thread of its own, outside the async runtime (the window and store calls wait on
/// the main thread, and `block_on` may not run inside the runtime), and awaits its answer.
async fn detached<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv().ok()
    })
    .await
    .ok()
    .flatten()
}

/// The sign-in window's commands (Task F16), granted to the main window only
/// (capabilities/main-window.json). Each also checks its caller's label itself: from any other
/// window it answers false and does nothing (library_window.rs, `Library`).
#[tauri::command]
async fn open_library_window(app: AppHandle, window: tauri::WebviewWindow, ticket: String, url: String) -> bool {
    let Some(shell) = app.try_state::<Arc<Shell>>().map(|s| s.inner().clone()) else { return false };
    let label = window.label().to_string();
    detached(move || shell.library.open(&library_host(&app, &shell), &label, &ticket, &url)).await.unwrap_or(false)
}

#[tauri::command]
async fn library_window_take_pdf(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    let Some(shell) = app.try_state::<Arc<Shell>>().map(|s| s.inner().clone()) else { return false };
    let label = window.label().to_string();
    detached(move || shell.library.take_pdf(&library_host(&app, &shell), &label, std::time::Instant::now())).await.unwrap_or(false)
}

#[tauri::command]
async fn close_library_window(app: AppHandle, window: tauri::WebviewWindow) {
    let Some(shell) = app.try_state::<Arc<Shell>>().map(|s| s.inner().clone()) else { return };
    let label = window.label().to_string();
    detached(move || shell.library.close(&library_host(&app, &shell), &label)).await;
}

#[tauri::command]
async fn sign_out_of_library(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    let Some(shell) = app.try_state::<Arc<Shell>>().map(|s| s.inner().clone()) else { return false };
    let label = window.label().to_string();
    detached(move || shell.library.sign_out(&library_host(&app, &shell), &label)).await.unwrap_or(false)
}

#[tauri::command]
async fn set_stay_signed_in(app: AppHandle, window: tauri::WebviewWindow, on: bool) -> bool {
    let Some(shell) = app.try_state::<Arc<Shell>>().map(|s| s.inner().clone()) else { return false };
    let label = window.label().to_string();
    detached(move || shell.library.set_stay(&library_host(&app, &shell), &label, on)).await.unwrap_or(false)
}

/// Test mode never starts the system's opener: it says that it would have (no address).
fn test_opener(_url: &str) -> bool {
    println!("AO_SHELL_BROWSER_OPENED");
    true
}

#[tauri::command]
async fn open_in_browser(window: tauri::WebviewWindow, url: String) -> bool {
    let opener: fn(&str) -> bool = if test_mode() { test_opener } else { library_window::system_opener };
    library_window::open_in_browser(window.label(), &url, &opener)
}

/// SIGTERM, SIGINT and SIGHUP end the app the same way closing the window does.
#[cfg(unix)]
fn on_termination_signals(app: AppHandle) {
    use std::io::Read;
    use std::os::fd::FromRawFd;
    static mut WRITE_FD: libc::c_int = -1;
    extern "C" fn handler(_: libc::c_int) {
        unsafe {
            let b = 1u8;
            libc::write(WRITE_FD, &b as *const u8 as *const libc::c_void, 1);
        }
    }
    let mut fds = [0 as libc::c_int; 2];
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        // Close-on-exec: the pipe stays in this process, not in the service or the web view's processes.
        for fd in fds {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        WRITE_FD = fds[1];
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, handler as *const () as libc::sighandler_t);
        }
    }
    let mut read = unsafe { std::fs::File::from_raw_fd(fds[0]) };
    std::thread::spawn(move || {
        let mut b = [0u8; 1];
        if read.read(&mut b).is_ok() {
            app.exit(0);
        }
    });
}

/// Debug builds with NODE_ENV=test: `close` on standard input closes the main window, exactly as
/// the window's close button does.
fn test_commands(app: AppHandle) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim() == "close" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
        }
    });
}

pub fn run() {
    service::become_subreaper();
    let shell = Arc::new(Shell::default());
    let setup_shell = shell.clone();
    let instance_shell = shell.clone();
    let loop_shell = shell.clone();
    let app = tauri::Builder::default()
        // First, so that a second launch hands over to the first before it starts anything.
        .plugin(tauri_plugin_single_instance::init(move |app, _argv, _cwd| focus_main(app, &instance_shell)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pick_watch_folder,
            open_library_window,
            library_window_take_pdf,
            close_library_window,
            sign_out_of_library,
            set_stay_signed_in,
            open_in_browser
        ])
        .setup(move |app| {
            app.manage(setup_shell.clone());
            let handle = app.handle().clone();
            #[cfg(unix)]
            on_termination_signals(handle.clone());
            if test_mode() {
                test_commands(handle.clone());
            }
            let shell = setup_shell.clone();
            let main_thread = std::thread::current().id();
            std::thread::spawn(move || launch(handle, shell, main_thread));
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|_| {
            eprintln!("{APP_NAME} could not start its window system.");
            std::process::exit(1);
        });
    // Closing (the last window closed, or a termination signal): the exit is held back until the
    // helpers are confirmed gone, because ending the event loop releases the single-instance guard
    // (the plugin's cleanup runs on RunEvent::Exit). While the guard is held, a second launch hands
    // over to this instance, which notes it and starts the app again once the helpers are gone:
    // never a second service beside a first that is still stopping (which would find the library
    // in use), and the researcher's "open" is not lost.
    let code = app.run_return(move |app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if loop_shell.helpers_stopped.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            if loop_shell.closing.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            let app = app.clone();
            let shell = loop_shell.clone();
            std::thread::spawn(move || {
                // The sign-in window closes and its store is emptied unless kept (on this thread:
                // the event loop still runs); the inbox is emptied once the service is gone.
                shell.library.at_quit(&library_host(&app, &shell));
                stop_helpers(&shell);
                empty_library_inbox(&shell);
                shell.helpers_stopped.store(true, Ordering::SeqCst);
                if shell.relaunch.load(Ordering::SeqCst) {
                    if test_mode() {
                        println!("AO_SHELL_RELAUNCHING");
                    }
                    app.request_restart();
                } else {
                    app.exit(code.unwrap_or(0));
                }
            });
        }
    });
    // Normally already done above; this covers an event loop that ended any other way.
    stop_helpers(&shell);
    empty_library_inbox(&shell);
    std::process::exit(if shell.failed.load(Ordering::SeqCst) { 1 } else { code });
}

/// Empties the sign-in window's inbox (R325 g), once the service that reads it is gone.
fn empty_library_inbox(shell: &Shell) {
    if let Some(c) = shell.library.config() {
        let _ = library_window::empty_inbox(&c.config_dir);
    }
}

/// Stops the service (which stops the worker) and waits for both to be gone (see `Service::stop`).
fn stop_helpers(shell: &Shell) {
    shell.stopping.store(true, Ordering::SeqCst);
    let taken = shell.service.lock().unwrap().take();
    let Some(mut svc) = taken else { return };
    if test_mode() {
        println!("AO_SHELL_CLOSING");
        #[cfg(debug_assertions)]
        if let Some(ms) = std::env::var("AO_SHELL_TEST_SLOW_STOP_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
            // The launch check's slowed quit: the helpers keep running a while, as during an import's pause.
            std::thread::sleep(Duration::from_millis(ms.min(60_000)));
        }
    }
    let how = svc.stop(SHUTDOWN_GRACE);
    if how == Stopped::Forced {
        eprintln!("{APP_NAME}: the library service did not stop in time and was stopped forcibly");
    }
    if test_mode() {
        println!("AO_SHELL_STOPPED {}", if how == Stopped::Clean { "clean" } else { "forced" });
    }
}
