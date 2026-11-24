//! Quit on a Mac (FR-731, R503 h): the app's own Quit goes the orderly way.
//!
//! On macOS the app menu's Quit (Cmd-Q; tauri's default menu, `PredefinedMenuItem::quit`, whose action
//! is `terminate:`, muda 0.20.0 `platform_impl/macos/mod.rs:944`), the Dock's Quit and a quit Apple
//! event all end in `-[NSApplication terminate:]`. tao 0.37.2 answers only
//! `applicationWillTerminate:` (`platform_impl/macos/app_delegate.rs:61-64, 130-134`), which sends
//! `LoopDestroyed`, i.e. `RunEvent::Exit` (tauri-runtime-wry 2.12.3 `lib.rs:4131-4133`) and never
//! `RunEvent::ExitRequested`; AppKit then ends the process. So, without this module, such a quit skipped
//! the orderly path (no wait for the helpers, no closing window, the sign-in window's store not emptied
//! at the quit).
//!
//! Here the shell adds `applicationShouldTerminate:` to tao's application delegate. For a quit asked by
//! the researcher it answers "cancel" and asks for the same exit SIGTERM asks for (`AppHandle::exit`,
//! which delivers `RunEvent::ExitRequested` and honours its prevention: tauri-runtime-wry 2.12.3
//! `lib.rs:4300-4313`), so the quit then goes exactly the way closing the window goes. The orderly exit
//! itself ends the loop with `-[NSApplication stop:]` (tao `app_state.rs:402-409`), never `terminate:`,
//! so it does not come back here. Everything else is answered "now", as before: a quit after the orderly
//! exit has finished, a quit while a failed start shows its error window, and a quit the system itself
//! asks for at logout, restart or shutdown (the Apple event carries a quit reason): that last case is
//! the owner's to decide, because refusing it would interrupt the logout.

/// What the shell answers to the Mac's request to end the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminate {
    /// End now (`NSTerminateNow`): AppKit ends the process, as it did before this module.
    Now,
    /// Not now (`NSTerminateCancel`); the shell's own orderly exit is asked for instead.
    Orderly,
}

impl Terminate {
    /// The word the shell prints in test mode (`AO_SHELL_QUIT <word>`, read by the launch check's scenario Q).
    pub fn word(self) -> &'static str {
        match self {
            Terminate::Now => "now",
            Terminate::Orderly => "orderly",
        }
    }
}

/// The answer to a terminate request: `system` when the system asks (logout, restart, shutdown),
/// `helpers_stopped` when the orderly exit has finished, `failed` when start-up failed.
pub fn on_terminate(system: bool, helpers_stopped: bool, failed: bool) -> Terminate {
    if system || helpers_stopped || failed {
        Terminate::Now
    } else {
        Terminate::Orderly
    }
}

/// The shell's answer, given whether the system asks (set once, by `install`).
#[cfg(target_os = "macos")]
type Decide = Box<dyn Fn(bool) -> Terminate + Send + Sync>;

#[cfg(target_os = "macos")]
static DECIDE: std::sync::OnceLock<Decide> = std::sync::OnceLock::new();

/// `NSApplicationTerminateReply`.
#[cfg(target_os = "macos")]
const NS_TERMINATE_CANCEL: usize = 0;
#[cfg(target_os = "macos")]
const NS_TERMINATE_NOW: usize = 1;

/// `keyAEQuitReason` ('why?'): present on the quit Apple event the system sends at logout, restart or
/// shutdown; absent on Cmd-Q (no Apple event at all), the Dock's Quit and an ordinary quit event.
#[cfg(target_os = "macos")]
const KEY_AE_QUIT_REASON: u32 = u32::from_be_bytes(*b"why?");

/// Adds `applicationShouldTerminate:` to the application delegate tao installed (on the main thread,
/// after the app is built, before its loop runs); `decide` answers it (it also asks for the orderly
/// exit when it answers `Orderly`). False, with nothing changed, when it cannot be added; the app then
/// quits as before.
#[cfg(target_os = "macos")]
pub fn install(decide: impl Fn(bool) -> Terminate + Send + Sync + 'static) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    if DECIDE.set(Box::new(decide)).is_err() {
        return false;
    }
    unsafe {
        let Some(app_class) = AnyClass::get(c"NSApplication") else { return false };
        let app: *mut AnyObject = msg_send![app_class, sharedApplication];
        if app.is_null() {
            return false;
        }
        let delegate: *mut AnyObject = msg_send![app, delegate];
        if delegate.is_null() {
            return false;
        }
        let class = (*delegate).class();
        let imp = std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize, Imp>(should_terminate);
        // "Q@:@": NSUInteger, self, _cmd, the sender. tao's delegate has no such method, so it is added.
        objc2::ffi::class_addMethod(class as *const AnyClass as *mut AnyClass, objc2::sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr()).as_bool()
    }
}

/// `-[NSApplicationDelegate applicationShouldTerminate:]`, on the main thread.
#[cfg(target_os = "macos")]
extern "C-unwind" fn should_terminate(_this: &objc2::runtime::AnyObject, _cmd: objc2::runtime::Sel, _sender: *mut objc2::runtime::AnyObject) -> usize {
    // Reading the quit reason must never end the app: if it fails, the quit counts as the researcher's.
    let system = std::panic::catch_unwind(|| unsafe { quit_reason() }).ok().flatten().is_some();
    match DECIDE.get().map(|decide| decide(system)) {
        Some(Terminate::Orderly) => NS_TERMINATE_CANCEL,
        _ => NS_TERMINATE_NOW,
    }
}

/// The quit reason of the Apple event being handled, if a quit event with one is being handled now.
#[cfg(target_os = "macos")]
unsafe fn quit_reason() -> Option<u32> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let manager_class = AnyClass::get(c"NSAppleEventManager")?;
    let manager: *mut AnyObject = msg_send![manager_class, sharedAppleEventManager];
    if manager.is_null() {
        return None;
    }
    let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
    if event.is_null() {
        return None;
    }
    let reason: *mut AnyObject = msg_send![event, attributeDescriptorForKeyword: KEY_AE_QUIT_REASON];
    if reason.is_null() {
        return None;
    }
    let code: u32 = msg_send![reason, enumCodeValue];
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_researcher_s_quit_goes_the_orderly_way_and_nothing_else_changes() {
        // Cmd-Q, the Dock's Quit, a quit Apple event: not now; the orderly exit instead (also while it runs,
        // so that a second Cmd-Q during the closing does not end the app half-way).
        assert_eq!(on_terminate(false, false, false), Terminate::Orderly);
        // As before: once the orderly exit has finished, while a failed start shows its error, and when the
        // system itself asks (logout, restart, shutdown).
        assert_eq!(on_terminate(false, true, false), Terminate::Now);
        assert_eq!(on_terminate(false, false, true), Terminate::Now);
        assert_eq!(on_terminate(true, false, false), Terminate::Now);
        assert_eq!(on_terminate(true, true, true), Terminate::Now);
        assert_eq!((Terminate::Orderly.word(), Terminate::Now.word()), ("orderly", "now"));
    }
}
