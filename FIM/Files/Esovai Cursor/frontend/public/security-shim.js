/**
 * Security Shim - laeuft VOR dem Vite/React-Bundle.
 * Faengt SecurityErrors beim cross-origin iframe-Zugriff ab (Base44-Preview).
 */
(function () {
  "use strict";

  function makeWindowProxy(win) {
    if (!win) return win;
    return new Proxy(win, {
      get: function (target, prop) {
        if (prop === "document") {
          try { return target.document; }
          catch (e) { if (e.name === "SecurityError") { console.warn("[shim] cross-origin .document blocked -> null"); return null; } throw e; }
        }
        try { var v = target[prop]; return typeof v === "function" ? v.bind(target) : v; }
        catch (e) { if (e.name === "SecurityError") return undefined; throw e; }
      }
    });
  }

  function patchContentWindow(Ctor) {
    if (!Ctor) return;
    var d = Object.getOwnPropertyDescriptor(Ctor.prototype, "contentWindow");
    if (!d || typeof d.get !== "function") return;
    var orig = d.get;
    Object.defineProperty(Ctor.prototype, "contentWindow", {
      get: function () {
        try { return makeWindowProxy(orig.call(this)); }
        catch (e) { if (e.name === "SecurityError") return null; throw e; }
      },
      configurable: true
    });
  }

  patchContentWindow(typeof HTMLIFrameElement !== "undefined" ? HTMLIFrameElement : null);
  patchContentWindow(typeof HTMLFrameElement !== "undefined" ? HTMLFrameElement : null);

  try {
    var mpd = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
    if (mpd && mpd.set) {
      var origSet = mpd.set;
      Object.defineProperty(MessagePort.prototype, "onmessage", {
        set: function (fn) {
          origSet.call(this, function (e) {
            try { fn.call(this, e); }
            catch (err) {
              if (err.name === "SecurityError") { console.warn("[shim] MessagePort SecurityError suppressed"); }
              else { throw err; }
            }
          });
        },
        get: mpd.get,
        configurable: true
      });
    }
  } catch (_) {}

  var PATTERNS = ["cross-origin", "blocked a frame", "failed to read a named property"];
  function isFrameErr(msg, err) {
    if (err && err.name === "SecurityError") return true;
    if (!msg) return false;
    var l = msg.toLowerCase();
    return PATTERNS.some(function (p) { return l.indexOf(p) !== -1; });
  }
  window.addEventListener("error", function (e) {
    if (isFrameErr(e.message, e.error)) {
      e.preventDefault(); e.stopImmediatePropagation();
      console.warn("[shim] global SecurityError suppressed");
      return true;
    }
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    if (e.reason && isFrameErr(e.reason.message, e.reason)) { e.preventDefault(); }
  });
})();
