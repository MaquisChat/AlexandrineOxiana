// The launch check's probe (debug builds with NODE_ENV=test only; never in a release build). It
// runs in the real web view, in the app's own page and origin, under the app's real
// content-security policy, after the connection script and before any app code. It keeps the
// connection the page receives, waits for the app to load, then checks what the page must be able
// to do with the service (Task 37c, item 3), and reports the results through the document title,
// which the shell prints as `AO_SHELL_TITLE AO_PROBE {...}`:
//   fetch    a plain authorised request (GET /libraries)
//   events   the event stream (GET /events read with fetch streaming, as the client does)
//   worker   the media worker answers through the service (GET /tools/versions)
//   picture  a picture fetched as bytes, shown from a blob: address
//   audio    an <audio> element loading a media ticket address
//   video    a <video> element loading a media ticket address
// It also reports what it could see of the page: its origin, and that the connection was handed
// over and then removed from the window by the app (serviceConnection.ts).
(function () {
  "use strict";
  if (window.top !== window) return;
  var conn = window.__AO_SERVICE__;
  if (!conn) return;
  var cfg = __PROBE_CONFIG__;
  var results = { origin: window.location.origin };
  var report = function () {
    document.title = "AO_PROBE " + JSON.stringify(results);
  };
  var timeout = function (ms, what) {
    return new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error(what + " timed out"));
      }, ms);
    });
  };
  var api = async function (method, path, body) {
    var headers = { authorization: "Bearer " + conn.token };
    if (body !== undefined) headers["content-type"] = "application/json";
    var r = await fetch(conn.baseUrl + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var json = null;
    try {
      json = await r.json();
    } catch (e) {}
    return { status: r.status, body: json };
  };
  var step = async function (name, fn) {
    try {
      results[name] = await Promise.race([fn(), timeout(60000, name)]);
    } catch (e) {
      results[name] = "failed: " + (e && e.message ? e.message : String(e));
    }
  };
  var media = function (tag, src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement(tag);
      el.preload = "metadata";
      el.muted = true;
      el.addEventListener("loadedmetadata", function () {
        resolve("ok (" + (tag === "video" ? el.videoWidth + "x" + el.videoHeight + ", " : "") + Math.round(el.duration * 10) / 10 + " s)");
      });
      el.addEventListener("error", function () {
        reject(new Error("media error " + (el.error ? el.error.code + " " + (el.error.message || "") : "?")));
      });
      el.src = src;
    });
  };
  var sourceWithAsset = async function (projectId, path) {
    var att = await api("POST", "/projects/" + projectId + "/attach", { paths: [path] });
    var item = att.body && att.body.items && att.body.items[0];
    if (!item || !item.sourceId) throw new Error("attach answered " + att.status + " " + JSON.stringify(att.body).slice(0, 200));
    var src = await api("GET", "/projects/" + projectId + "/sources/" + item.sourceId);
    var assets = (src.body && (src.body.assets || (src.body.source && src.body.source.assets))) || [];
    if (!assets.length) throw new Error("no asset in " + JSON.stringify(src.body).slice(0, 300));
    return { sid: item.sourceId, aid: assets[0].id };
  };
  var ticketUrl = async function (projectId, a) {
    var t = await api("POST", "/projects/" + projectId + "/sources/" + a.sid + "/assets/" + a.aid + "/media-ticket");
    if (t.status !== 200 || !t.body || typeof t.body.path !== "string") throw new Error("ticket answered " + t.status);
    return conn.baseUrl + t.body.path;
  };

  // What the page may ask of the shell (least privilege): each command answered "allowed" or
  // "denied". Only listening for events (drag and drop) and the open-file dialog are granted; the
  // dialog itself is not opened here (it would wait for a person).
  var ipc = async function () {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals) return "no IPC";
    var out = {};
    var tryCmd = async function (name, cmd, args) {
      try {
        await internals.invoke(cmd, args || {});
        out[name] = "allowed";
      } catch (e) {
        var m = String(e && e.message ? e.message : e);
        out[name] = /not allowed|denied|forbidden|permission/i.test(m) ? "denied" : "error: " + m.slice(0, 120);
      }
    };
    await tryCmd("event.listen", "plugin:event|listen", { event: "tauri://drag-drop", target: { kind: "Webview", label: "main" }, handler: internals.transformCallback(function () {}) });
    await tryCmd("dialog.save", "plugin:dialog|save", { options: {} });
    await tryCmd("dialog.message", "plugin:dialog|message", { message: "x" });
    await tryCmd("fs.readFile", "plugin:fs|read_file", { path: "/etc/hostname" });
    await tryCmd("path.resolveDirectory", "plugin:path|resolve_directory", { directory: 11 });
    await tryCmd("window.close", "plugin:window|close", { label: "main" });
    await tryCmd("webview.print", "plugin:webview|print", { label: "main" });
    await tryCmd("app.version", "plugin:app|version", {});
    await tryCmd("event.emit", "plugin:event|emit", { event: "x", payload: null });
    return out;
  };

  var run = async function () {
    results.connectionRemovedByApp = window.__AO_SERVICE__ === undefined;
    results.ipc = await ipc();
    results.baseUrl = conn.baseUrl;
    await step("fetch", async function () {
      var r = await api("GET", "/libraries");
      return r.status === 200 ? "ok" : "status " + r.status;
    });
    await step("events", async function () {
      var ctl = new AbortController();
      var r = await fetch(conn.baseUrl + "/events", { headers: { authorization: "Bearer " + conn.token, accept: "text/event-stream" }, signal: ctl.signal });
      var reader = r.body.getReader();
      var chunk = await reader.read();
      var text = new TextDecoder().decode(chunk.value || new Uint8Array());
      ctl.abort();
      return /library\.state/.test(text) ? "ok" : "unexpected first event";
    });
    var projectId;
    await step("library", async function () {
      var lib = await api("POST", "/libraries", { path: cfg.libraryDir, name: "Launch check" });
      if (lib.status !== 200) throw new Error("create library answered " + lib.status);
      var p = await api("POST", "/projects", {
        name: "Probe",
        governanceYaml: "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\nprocessing:\n  metadata_lookup: []\n",
        encryption: { enabled: false },
      });
      if (p.status !== 200) throw new Error("create project answered " + p.status);
      projectId = p.body.project.id;
      return "ok";
    });
    await step("worker", async function () {
      var r = await api("GET", "/tools/versions");
      return r.status === 200 && r.body && r.body.versions ? "ok" : "status " + r.status;
    });
    if (projectId) {
      await step("picture", async function () {
        var a = await sourceWithAsset(projectId, cfg.png);
        var r = await fetch(conn.baseUrl + "/projects/" + projectId + "/sources/" + a.sid + "/assets/" + a.aid + "/content", { headers: { authorization: "Bearer " + conn.token } });
        if (r.status !== 200) throw new Error("content answered " + r.status);
        var url = URL.createObjectURL(await r.blob());
        return await new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () {
            resolve("ok (" + img.naturalWidth + "x" + img.naturalHeight + ")");
            URL.revokeObjectURL(url);
          };
          img.onerror = function () {
            reject(new Error("the blob: picture did not decode"));
          };
          img.src = url;
        });
      });
      if (cfg.wav) {
        await step("audio", async function () {
          return media("audio", await ticketUrl(projectId, await sourceWithAsset(projectId, cfg.wav)));
        });
      }
      if (cfg.mp4) {
        await step("video", async function () {
          return media("video", await ticketUrl(projectId, await sourceWithAsset(projectId, cfg.mp4)));
        });
      }
    }
    // Task F19: when the check asks for the sign-in window's own probe, open that window once, as
    // the app's page does (a ticket of 32 hex digits and an https address); its probe reports to the check.
    if (cfg.libraryOpen && window.__TAURI_INTERNALS__) {
      await step("libraryWindowOpened", async function () {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        var ticket = Array.from(bytes, function (b) {
          return (b < 16 ? "0" : "") + b.toString(16);
        }).join("");
        var opened = await window.__TAURI_INTERNALS__.invoke("open_library_window", { ticket: ticket, url: cfg.libraryOpen });
        return opened === true ? "ok" : "answered " + JSON.stringify(opened);
      });
    }
  };

  window.addEventListener("load", function () {
    setTimeout(function () {
      run().then(report, function (e) {
        results.error = String(e);
        report();
      });
    }, 1000);
  });
})();
