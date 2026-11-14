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
    var P = U.prototype, g = function (k) { return Object.getOwnPropertyDescriptor(P, k).get; };
    var gProt = g("protocol"), gUser = g("username"), gPass = g("password"), gOrigin = g("origin"), gHref = g("href");
    doc.addEventListener("DOMContentLoaded", function () {
      try {
        var m = qsa.call(doc, 'meta[name="citation_pdf_url"]');
        if (m.length !== 1) return;
        var v = attr.call(m[0], "content");
        if (typeof v !== "string" || v.length > 2048 || v.slice(0, 8) !== "https://") return;
        var u = new U(v);
        var href = gHref.call(u);
        if (gProt.call(u) !== "https:" || gUser.call(u) !== "" || gPass.call(u) !== "" || gOrigin.call(u) !== loc.origin || href === loc.href) return;
        var key = "ao-library-pdf " + href;
        if (get.call(ss, key) !== null) return;
        set.call(ss, key, "1");
        loc.assign(href);
      } catch (e) {}
    }, { once: true });
  } catch (e) {}
})();
