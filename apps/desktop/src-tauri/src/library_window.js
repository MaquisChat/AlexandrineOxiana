// The sign-in window's start-up script (Task F16; library_window.rs says what it may do).
(function () {
  "use strict";
  try {
    var w = window;
    if (w.top !== w) return;
    var loc = w.location;
    if (loc.protocol !== "https:") return;
    var doc = w.document, U = w.URL, ss = w.sessionStorage;
    var qsa = w.Document.prototype.querySelectorAll, attr = w.Element.prototype.getAttribute;
    var get = w.Storage.prototype.getItem, set = w.Storage.prototype.setItem;
    doc.addEventListener("DOMContentLoaded", function () {
      try {
        var m = qsa.call(doc, 'meta[name="citation_pdf_url"]');
        if (m.length !== 1) return;
        var v = attr.call(m[0], "content");
        if (typeof v !== "string" || v.length > 2048 || v.slice(0, 8) !== "https://") return;
        var u = new U(v);
        if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.origin !== loc.origin || u.href === loc.href) return;
        var key = "ao-library-pdf " + u.href;
        if (get.call(ss, key) !== null) return;
        set.call(ss, key, "1");
        loc.assign(u.href);
      } catch (e) {}
    }, { once: true });
  } catch (e) {}
})();
