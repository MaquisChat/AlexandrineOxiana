// The launch check's probe of the sign-in window (Task F19, R343 b). Compiled into debug builds only
// (library_window.rs, `cfg(debug_assertions)`), and given to the sign-in window only in test mode
// (NODE_ENV=test) with AO_SHELL_LIBRARY_PROBE set to the check's report address
// (`http://127.0.0.1:<port>/report`); never in a release build. It runs in the window's main frame
// as an outside page's own script would, and tries every command of the app through what such a page
// can reach: Tauri's `__TAURI_INTERNALS__` (if the page sees it) for each command of the app (the
// sign-in window's six, the main window's own, the folder chooser), the event system's listen,
// unlisten, emit and emit-to, the file dialogs and the dialog's ask and confirm, one command each of
// the image, resources, menu and tray families; then the IPC's raw entry points without the
// invoke key (`window.ipc.postMessage` and the `ipc:` protocol). Each outcome is reported, by
// navigating to the report address with the results as JSON in `r`:
//   "allowed"      the command answered
//   "denied"       refused by the shell (Tauri's "not allowed" answer)
//   "no answer"    nothing came back within the limit
//   "no IPC"       the page has no IPC object at all
//   "error: …"     any other refusal
// The launch check requires every one to be refused (`EXPECTED_LIBRARY_WINDOW_IPC`), and that the
// raw attempts changed nothing (the shell said nothing for them). The probe sends no cookie, address
// or ticket of the researcher's anywhere: it holds none.
(function () {
  "use strict";
  if (window.top !== window) return;
  var cfg = __LIBRARY_PROBE_CONFIG__;
  var here = String(window.location.href);
  if (here.indexOf(cfg.report) === 0) return;
  var proto = window.location.protocol;
  if (proto !== "http:" && proto !== "https:") {
    // An error page in place of the address the window was opened at (an https address this machine
    // does not trust, as in the launch check): go on to the check's own outside page and probe there.
    setTimeout(function () {
      window.location.replace(cfg.page);
    }, 100);
    return;
  }
  var internals = window.__TAURI_INTERNALS__;
  var hasIpc = !!(internals && typeof internals.invoke === "function");
  var out = { probe: "library", origin: window.location.origin, internals: hasIpc, ipc: {}, raw: {} };
  var LIMIT = 10000;
  var TICKET = "0123456789abcdef0123456789abcdef";
  var NOWHERE = "https://example.invalid/";

  var ask = function (cmd, args) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        resolve("no answer");
      }, LIMIT);
      var done = function (v) {
        clearTimeout(timer);
        resolve(v);
      };
      try {
        internals.invoke(cmd, args).then(
          function () {
            done("allowed");
          },
          function (e) {
            var m = String(e && e.message ? e.message : e);
            done(/not allowed|denied|forbidden|permission/i.test(m) ? "denied" : "error: " + m.slice(0, 120));
          },
        );
      } catch (e) {
        done("error: " + String(e).slice(0, 120));
      }
    });
  };
  var try_ = async function (name, cmd, args) {
    out.ipc[name] = hasIpc ? await ask(cmd, args) : "no IPC";
  };
  var handler = function () {
    try {
      return internals.transformCallback(function () {});
    } catch (e) {
      return 0;
    }
  };
  var closedEvent = { ticket: null, state: "closed" };

  var run = async function () {
    // The sign-in window's six commands (each also checks its caller's window; none may even reach that).
    await try_("library.open", "open_library_window", { ticket: TICKET, url: NOWHERE });
    await try_("library.take", "library_window_take_pdf", {});
    await try_("library.close", "close_library_window", {});
    await try_("library.signOut", "sign_out_of_library", {});
    await try_("library.stay", "set_stay_signed_in", { on: false });
    await try_("browser.open", "open_in_browser", { url: NOWHERE });
    // The watched-folder chooser.
    await try_("watch.pick", "pick_watch_folder", { title: "x" });
    // The event system: hear the main window's events, or send it one as if from the shell.
    await try_("event.listen", "plugin:event|listen", { event: "library-window", target: { kind: "Any" }, handler: handler() });
    await try_("event.unlisten", "plugin:event|unlisten", { event: "library-window", eventId: 1 });
    await try_("event.emit", "plugin:event|emit", { event: "library-window", payload: closedEvent });
    await try_("event.emitTo", "plugin:event|emit_to", { target: { kind: "WebviewWindow", label: "main" }, event: "library-window", payload: closedEvent });
    // The main window's other commands, granted and refused alike.
    await try_("dialog.open", "plugin:dialog|open", { options: {} });
    await try_("dialog.save", "plugin:dialog|save", { options: {} });
    await try_("dialog.message", "plugin:dialog|message", { message: "x" });
    await try_("fs.readFile", "plugin:fs|read_file", { path: "/etc/hostname" });
    await try_("path.resolveDirectory", "plugin:path|resolve_directory", { directory: 11 });
    await try_("window.close", "plugin:window|close", { label: "main" });
    await try_("webview.print", "plugin:webview|print", { label: "main" });
    await try_("app.version", "plugin:app|version", {});
    // One command of each core family no window of the app is granted, and the dialog's other two
    // (R346 h): a picture, a resource, a menu, a tray icon; asking and confirming.
    await try_("image.new", "plugin:image|new", { rgba: [0, 0, 0, 0], width: 1, height: 1 });
    await try_("resources.close", "plugin:resources|close", { rid: 1 });
    await try_("menu.new", "plugin:menu|new", { kind: "Menu", options: {} });
    await try_("tray.new", "plugin:tray|new", { options: {} });
    await try_("dialog.ask", "plugin:dialog|ask", { message: "x" });
    await try_("dialog.confirm", "plugin:dialog|confirm", { message: "x" });

    // The raw entry points, without the invoke key Tauri's own script keeps to itself. What they would
    // do (start the researcher's browser) is printed by the shell in test mode: the check looks for it.
    if (window.ipc && typeof window.ipc.postMessage === "function") {
      try {
        window.ipc.postMessage(JSON.stringify({ cmd: "open_in_browser", callback: 0, error: 0, payload: { url: NOWHERE } }));
        out.raw["ipc.postMessage"] = "sent";
      } catch (e) {
        out.raw["ipc.postMessage"] = "refused";
      }
    } else {
      out.raw["ipc.postMessage"] = "absent";
    }
    try {
      var r = await Promise.race([
        fetch("ipc://localhost/open_in_browser", {
          method: "POST",
          body: JSON.stringify({ url: NOWHERE }),
          headers: { "Content-Type": "application/json", "Tauri-Callback": "0", "Tauri-Error": "0" },
        }),
        new Promise(function (_, reject) {
          setTimeout(function () {
            reject(new Error("no answer"));
          }, LIMIT);
        }),
      ]);
      out.raw["fetch.ipc"] = r.ok && r.headers.get("Tauri-Response") === "ok" ? "allowed" : "refused";
    } catch (e) {
      out.raw["fetch.ipc"] = "unreachable";
    }
  };

  var report = function () {
    window.location.replace(cfg.report + "?r=" + encodeURIComponent(JSON.stringify(out)));
  };
  var start = function () {
    run().then(report, function (e) {
      out.error = String(e).slice(0, 200);
      report();
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
