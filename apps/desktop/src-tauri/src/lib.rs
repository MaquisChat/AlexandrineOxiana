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
pub mod helper_env;
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

#[derive(Default)]
struct Shell {
    service: Mutex<Option<Service>>,
    stopping: AtomicBool,
}

/// Debug builds only: with NODE_ENV=test the shell reports what the launch check needs on its
/// standard output (never the token) and takes `close` on its standard input (R47).
fn test_mode() -> bool {
    cfg!(debug_assertions) && std::env::var("NODE_ENV").as_deref() == Ok("test")
}

fn log_helper(line: &str) {
    eprintln!("[service] {line}");
}

/// Shows a plain error window, stops what was started, and exits non-zero.
fn fail(app: &AppHandle, shell: &Shell, message: &str) -> ! {
    eprintln!("{APP_NAME} could not start: {message}");
    if test_mode() {
        println!("AO_SHELL_FAILED");
    }
    shell.stopping.store(true, Ordering::SeqCst);
    if let Some(mut s) = shell.service.lock().unwrap().take() {
        s.stop(Duration::from_secs(10));
    }
    app.dialog()
        .message(format!("{message}\n\nThe app will close. If this keeps happening, reinstall the app."))
        .title(format!("{APP_NAME} could not start"))
        .kind(MessageDialogKind::Error)
        .blocking_show();
    std::process::exit(1);
}

fn launch(app: AppHandle, shell: Arc<Shell>) {
    let resources = app.path().resource_dir().ok();
    let helpers = match paths::resolve(resources.as_deref(), &paths::Overrides::from_env()) {
        Ok(p) => p,
        Err(m) => fail(&app, &shell, &m),
    };
    let data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => fail(&app, &shell, "The app's data folder could not be found."),
    };
    let tools_dir = data.join("tools");
    let models_dir = data.join("models");
    let _ = std::fs::create_dir_all(&tools_dir);
    let _ = std::fs::create_dir_all(&models_dir);
    let token = match token::new_token() {
        Ok(t) => t,
        Err(m) => fail(&app, &shell, &format!("A new access key could not be made: {m}.")),
    };
    let env = helper_env::service_env(
        std::env::vars_os(),
        &helper_env::ServiceConfig { worker_bin: helpers.worker_bin.as_deref(), tools_dir: &tools_dir, models_dir: &models_dir },
    );
    let launch = Launch { program: helpers.node.clone(), args: service::service_args(&helpers.service_dir), cwd: helpers.service_dir.clone(), env };
    let svc = match service::start(&launch, &token, READY_TIMEOUT, Arc::new(log_helper)) {
        Ok(s) => s,
        Err(e) => fail(&app, &shell, &e.user_message()),
    };
    let port = svc.port;
    if test_mode() {
        println!("AO_SHELL_SERVICE pid={} port={port}", svc.pid());
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

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if test_mode() {
        println!("AO_SHELL_SECOND_LAUNCH");
    }
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
    let app = tauri::Builder::default()
        // First, so that a second launch hands over to the first before it starts anything.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            #[cfg(unix)]
            on_termination_signals(handle.clone());
            if test_mode() {
                test_commands(handle.clone());
            }
            let shell = setup_shell.clone();
            std::thread::spawn(move || launch(handle, shell));
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|_| {
            eprintln!("{APP_NAME} could not start its window system.");
            std::process::exit(1);
        });
    let code = app.run_return(|_app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // The window is gone; the helpers are stopped once the event loop has ended.
        }
    });
    shell.stopping.store(true, Ordering::SeqCst);
    let taken = shell.service.lock().unwrap().take();
    if let Some(mut svc) = taken {
        let how = svc.stop(SHUTDOWN_GRACE);
        if how == Stopped::Forced {
            eprintln!("{APP_NAME}: the library service did not stop in time and was stopped forcibly");
        }
        if test_mode() {
            println!("AO_SHELL_STOPPED {}", if how == Stopped::Clean { "clean" } else { "forced" });
        }
    }
    std::process::exit(code);
}
