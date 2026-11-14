fn main() {
    // The shell's own commands the page may be granted (capabilities/main-window.json): the
    // watched-folder chooser (Task W6, R207) and the sign-in window's six (Task F16, R325). Declaring
    // them here makes Tauri generate one `allow-<command>` permission for each and refuse the command
    // to any window not granted it (the sign-in window, `library`, is granted none).
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "pick_watch_folder",
        "open_library_window",
        "library_window_take_pdf",
        "close_library_window",
        "sign_out_of_library",
        "set_stay_signed_in",
        "open_in_browser",
    ]));
    tauri_build::try_build(attributes).expect("the Tauri build step failed");
}
