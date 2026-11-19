import { RUNTIME_SOURCE, STUDIO_SOURCE } from "../protocol.ts";
import type { GameExportData } from "./gameExport.ts";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The export's index.html: hosts the unchanged web runtime (runtime/index.html) full window and
 * plays the studio's side of the protocol (packages/core/src/protocol.ts): on `ready` it sends the
 * images and the game (game.json), on `loaded` it plays from the world's start, resuming the run
 * saved in this browser if there is one. The controls show for a few seconds, and again from the
 * corner button (with "Start over" when a save exists, and "Change keys": the player's own keys,
 * kept in this browser under data.controls.storageKey and sent to the runtime as the `controls`
 * message before the game loads and on every change). The keys shown are always the ones in effect.
 * Everything is relative and inline: no other requests than the export's own files.
 *
 * For tests and embedding pages: `window.game.state()` resolves to the runtime's `state` message,
 * and <body data-status> is "loading" | "playing" | "error" (data-room: the room the player is in).
 */
export function exportBootPage(data: GameExportData): string {
  const title = escapeHtml(data.title);
  const background = /^#[0-9a-f]{6}$/i.test(data.project.world.backgroundColor) ? data.project.world.backgroundColor : "#1b2030";
  // The game's keys until the page fills in the player's own (it renders the same list from data.controls).
  const controls = data.controls.help.map((c) => `<dt>${escapeHtml(c.keys)}</dt><dd>${escapeHtml(c.action)}</dd>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>${title}</title>
<link rel="icon" type="image/png" href="runtime/index.icon.png">
<style>
html, body { margin: 0; height: 100%; overflow: hidden; background: ${background}; color: #eef0f4; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
#stage, #stage iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
#cover { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: ${background}; text-align: center; padding: 16px; }
#cover h1 { margin: 0; font-size: clamp(22px, 5vw, 40px); font-weight: 650; letter-spacing: 0.01em; }
#cover p { margin: 0; color: #b8bfcc; max-width: 36em; }
body[data-status="loading"] #cover p::after { content: ""; display: inline-block; width: 0.9em; height: 0.9em; margin-left: 0.6em; vertical-align: -0.1em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
body[data-status="error"] #cover p { color: #ffb4be; }
@keyframes spin { to { transform: rotate(360deg); } }
#controls { position: fixed; left: 16px; bottom: 16px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 12px 16px; background: rgb(12 14 20 / 0.86); border: 1px solid rgb(255 255 255 / 0.14); border-radius: 10px; box-shadow: 0 10px 30px rgb(0 0 0 / 0.45); }
#controls p { margin: 0 0 6px; color: #c9ceda; }
#controls h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #b8bfcc; text-transform: uppercase; letter-spacing: 0.08em; }
#controls dl { display: grid; grid-template-columns: auto auto; gap: 2px 16px; margin: 0; }
#controls dt { font-weight: 600; white-space: nowrap; }
#controls dd { margin: 0; color: #c9ceda; }
#controls .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
button { font: inherit; color: inherit; background: rgb(255 255 255 / 0.08); border: 1px solid rgb(255 255 255 / 0.22); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
button:hover { background: rgb(255 255 255 / 0.16); }
button:focus-visible { outline: 2px solid #8fb3ff; outline-offset: 2px; }
#keys-view { min-width: min(420px, calc(100vw - 64px)); }
#keys-view .note { font-size: 13px; }
.key-row { display: grid; grid-template-columns: 1fr auto auto auto auto; align-items: center; gap: 4px 8px; padding: 3px 0; border-top: 1px solid rgb(255 255 255 / 0.08); }
.key-row .key-keys { font-weight: 600; white-space: nowrap; text-align: right; }
.key-row.changed .key-keys::after { content: " •"; color: #8fb3ff; }
.key-row.listening .key-keys { color: #ffd479; }
.key-capture { cursor: pointer; user-select: none; padding: 0 6px; border: 1px dashed #ffd479; border-radius: 4px; }
.key-row button { padding: 2px 8px; font-size: 13px; }
.key-row button:disabled { opacity: 0.4; cursor: default; }
#keys-message { min-height: 1.4em; margin: 8px 0 0; color: #ffd479; }
#help { position: fixed; right: 12px; bottom: 12px; width: 32px; height: 32px; padding: 0; border-radius: 50%; opacity: 0.55; }
#help:hover, #help:focus-visible { opacity: 1; }
body:not([data-status="playing"]) #help { display: none; }
[hidden] { display: none !important; }
</style>
</head>
<body data-status="loading">
<div id="stage"></div>
<div id="cover"><h1>${title}</h1><p id="cover-text">Loading</p></div>
<aside id="controls" aria-label="Controls" hidden>
<div id="help-view">
<h2>Controls</h2>
<p id="resumed" hidden>Continuing your saved game.</p>
<dl id="help-list">${controls}</dl>
<div class="actions"><button type="button" id="change-keys">Change keys</button><button type="button" id="start-over" hidden title="Forget the saved game and play from the beginning">Start over</button><button type="button" id="close">OK</button></div>
</div>
<div id="keys-view" hidden>
<h2>Change keys</h2>
<p class="note">Change, then press the key you want, or click “click here” with the mouse button you want (Escape cancels). Saved in this browser; • = changed.</p>
<div id="key-list" role="list"></div>
<p id="keys-message" role="status" aria-live="polite"></p>
<div class="actions"><button type="button" id="reset-keys">Reset to the game's defaults</button><button type="button" id="keys-done">Done</button></div>
</div>
</aside>
<button type="button" id="help" aria-label="Controls" title="Controls">?</button>
<script>
(function () {
  "use strict";
  var PROTOCOL = ${data.protocolVersion};
  var body = document.body;
  var cover = document.getElementById("cover");
  var coverText = document.getElementById("cover-text");
  var controls = document.getElementById("controls");
  var startOver = document.getElementById("start-over");
  var data = null;
  var frame = null;
  var started = false;
  var pending = {};
  var nextRequest = 1;
  var hideTimer = 0;
  var resumed = false;
  var keys = null; // data.controls
  var overrides = {}; // the player's own keys: { action: [key names] }
  var listening = null; // { action, mode: "replace" | "add" } while waiting for a key
  var swallow = null; // the key just captured: its keyup must not reach a button

  function fail(text) {
    body.dataset.status = "error";
    cover.hidden = false;
    coverText.textContent = text;
  }
  function post(message) {
    frame.contentWindow.postMessage(JSON.stringify({ source: ${JSON.stringify(STUDIO_SOURCE)}, protocolVersion: PROTOCOL, message: message }), location.origin);
  }
  // Keys reach the runtime only while its canvas has the focus (inside the frame).
  function focusGame() {
    if (!frame) return;
    frame.focus();
    try {
      var canvas = frame.contentDocument && frame.contentDocument.getElementById("canvas");
      if (canvas) canvas.focus();
      else frame.contentWindow.focus();
    } catch (e) {}
  }
  // --- keys: the game's (data.controls.actions), with the player's own on top ---
  function action(id) {
    for (var i = 0; i < keys.actions.length; i++) if (keys.actions[i].id === id) return keys.actions[i];
    return null;
  }
  function gameKeys(id) {
    var a = action(id);
    var bindings = data.project.controls && data.project.controls.bindings;
    return a ? a.keys : (bindings && bindings[id]) || [];
  }
  function bound(id) { return overrides[id] || gameKeys(id); }
  function label(key) { return keys.keyLabels[key] || key; }
  function keysText(list) { return list.map(label).join("/"); }
  function same(a, b) { return a.length === b.length && a.every(function (k, i) { return k === b[i]; }); }
  function loadOverrides() {
    var stored = {};
    try { stored = JSON.parse(localStorage.getItem(keys.storageKey) || "{}") || {}; } catch (e) {}
    overrides = {};
    keys.actions.forEach(function (a) {
      var list = stored[a.id];
      if (!Array.isArray(list) || list.length < 1 || list.length > keys.maxKeys) return;
      var ok = list.every(function (k, i) { return typeof k === "string" && keys.keyLabels.hasOwnProperty(k) && list.indexOf(k) === i; });
      if (ok && !same(list, a.keys)) overrides[a.id] = list;
    });
  }
  function sendControls() {
    if (frame) post({ type: "controls", overrides: overrides });
  }
  function saveOverrides() {
    try {
      if (Object.keys(overrides).length) localStorage.setItem(keys.storageKey, JSON.stringify(overrides));
      else localStorage.removeItem(keys.storageKey);
    } catch (e) {}
    sendControls();
    renderKeys();
  }
  function mayShare(a, b) {
    return a.context !== b.context || a.shares.indexOf(b.id) >= 0 || b.shares.indexOf(a.id) >= 0;
  }
  // Bind key to the listening action, unless another action used at the same time has it. Says what happened.
  function bind(key) {
    var a = action(listening.action);
    var current = bound(a.id);
    var next = listening.mode === "add" ? (current.indexOf(key) >= 0 ? current : current.concat([key])) : [key];
    for (var i = 0; i < keys.actions.length; i++) {
      var other = keys.actions[i];
      if (other.id !== a.id && !mayShare(a, other) && bound(other.id).indexOf(key) >= 0) {
        return label(key) + " is already " + other.label + "'s key. Change " + other.label + " first, or pick another key.";
      }
    }
    if (next.length > keys.maxKeys) return a.label + " already has " + keys.maxKeys + " keys.";
    if (same(next, a.keys)) delete overrides[a.id];
    else overrides[a.id] = next;
    saveOverrides();
    return a.label + ": " + keysText(next);
  }
  function renderKeys() {
    var help = document.getElementById("help-list");
    help.textContent = "";
    keys.help.forEach(function (h) {
      var dt = document.createElement("dt");
      dt.textContent = h.template.replace(/\\{([a-z_]+)\\}/g, function (all, id) { return keysText(bound(id)); });
      var dd = document.createElement("dd");
      dd.textContent = h.action;
      help.appendChild(dt);
      help.appendChild(dd);
    });
    var list = document.getElementById("key-list");
    list.textContent = "";
    keys.actions.forEach(function (a) {
      var row = document.createElement("div");
      var waiting = listening && listening.action === a.id;
      row.className = "key-row" + (overrides[a.id] ? " changed" : "") + (waiting ? " listening" : "");
      row.setAttribute("role", "listitem");
      row.setAttribute("aria-label", a.label);
      row.dataset.action = a.id;
      var name = document.createElement("span");
      name.textContent = a.label;
      var current = document.createElement("span");
      current.className = "key-keys" + (waiting ? " key-capture" : "");
      current.textContent = waiting ? "press a key or click here…" : keysText(bound(a.id));
      if (waiting) current.title = "Press a key, or click here with the mouse button you want";
      row.appendChild(name);
      row.appendChild(current);
      [["replace", "Change", "Change " + a.label], ["add", "+ Key", "Add a key to " + a.label]].forEach(function (b) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = b[1];
        button.setAttribute("aria-label", b[2]);
        button.addEventListener("click", function () { listen(a.id, b[0]); });
        row.appendChild(button);
      });
      var reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "Reset";
      reset.setAttribute("aria-label", "Reset " + a.label);
      reset.disabled = !overrides[a.id];
      reset.addEventListener("click", function () {
        delete overrides[a.id];
        listening = null;
        saveOverrides();
        message(a.label + ": " + keysText(bound(a.id)) + " (the game's)");
      });
      row.appendChild(reset);
      list.appendChild(row);
    });
  }
  function message(text) { document.getElementById("keys-message").textContent = text; }
  function listen(id, mode) {
    listening = { action: id, mode: mode };
    renderKeys();
    message("Press a key for " + action(id).label + (mode === "add" ? " (added beside its keys)" : "") + ". Escape cancels.");
  }
  function showKeys() {
    clearTimeout(hideTimer);
    controls.hidden = false;
    document.getElementById("help-view").hidden = true;
    document.getElementById("keys-view").hidden = false;
    message("");
    renderKeys();
  }
  function showHelp() {
    listening = null;
    document.getElementById("keys-view").hidden = true;
    document.getElementById("help-view").hidden = false;
    if (keys) renderKeys();
  }
  window.addEventListener("keydown", function (event) {
    if (!listening) {
      if (event.key === "Escape" && !controls.hidden && !document.getElementById("keys-view").hidden) hideControls();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Escape") {
      listening = null;
      renderKeys();
      return message("");
    }
    var key = keys.browserCodes[event.code];
    if (!key) return message("That key can't be used. Press another (Escape cancels).");
    swallow = event.code;
    var said = bind(key);
    listening = null;
    renderKeys();
    message(said);
  }, true);
  window.addEventListener("keyup", function (event) {
    if (swallow && event.code === swallow) {
      swallow = null;
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  // Mouse buttons: a press on the waiting row's "click here" binds that button. The spot only exists
  // once Change was clicked, so the click that started waiting is never the one bound.
  function onCapture(target) { return listening && target && target.closest && target.closest(".key-capture"); }
  window.addEventListener("mousedown", function (event) {
    if (!onCapture(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    menuUntil = Date.now() + 1000; // this press's own context menu (the spot is gone by then)
    var key = keys.browserButtons[String(event.button)];
    if (!key) return message("That mouse button can't be used. Press another (Escape cancels).");
    var said = bind(key);
    listening = null;
    renderKeys();
    message(said);
  }, true);
  // No browser menu on right click over the game (right click can be a game action), nor for a
  // captured button; the panel's text keeps it. The runtime's own page gets the same once it loads.
  var menuUntil = 0;
  function noMenu(event) { event.preventDefault(); }
  window.addEventListener("contextmenu", function (event) {
    var inPanel = event.target && event.target.closest && event.target.closest("#controls");
    if (!inPanel || onCapture(event.target) || Date.now() < menuUntil) event.preventDefault();
  });

  function hasSave() {
    try { return localStorage.getItem(data.saveKey) !== null; } catch (e) { return false; }
  }
  // At the start: "Start over" only when a saved game was resumed. From the ? button: whenever a save exists.
  function showControls(seconds, atStart) {
    showHelp();
    controls.hidden = false;
    document.getElementById("resumed").hidden = !(atStart && resumed);
    startOver.hidden = atStart ? !resumed : !hasSave();
    clearTimeout(hideTimer);
    if (seconds) hideTimer = setTimeout(hideControls, seconds * 1000);
  }
  function hideControls() {
    showHelp();
    controls.hidden = true;
    clearTimeout(hideTimer);
    focusGame();
  }
  function base64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(",")[1] || ""); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }
  function loadImages() {
    return Promise.all(data.images.map(function (ref) {
      return fetch("files/" + ref).then(function (res) {
        if (!res.ok) throw new Error("missing " + ref);
        return res.blob();
      }).then(base64).then(function (b64) { return [ref, b64]; });
    })).then(function (pairs) {
      var images = {};
      pairs.forEach(function (pair) { images[pair[0]] = pair[1]; });
      return images;
    });
  }

  window.addEventListener("message", function (event) {
    if (!frame || event.source !== frame.contentWindow || typeof event.data !== "string") return;
    var envelope;
    try { envelope = JSON.parse(event.data); } catch (e) { return; }
    if (!envelope || envelope.source !== ${JSON.stringify(RUNTIME_SOURCE)} || !envelope.message) return;
    var m = envelope.message;
    if (m.type === "ready") {
      if (m.protocolVersion !== PROTOCOL) return fail("This game's runtime does not match its data (protocol " + m.protocolVersion + ", expected " + PROTOCOL + ").");
      loadImages().then(function (images) {
        if (data.images.length > 0) post({ type: "images", images: images });
        sendControls(); // before the game loads, so it starts with the player's keys
        post({ type: "load", project: data.project });
      }, function (e) { fail("This game could not load its art (" + e.message + ")."); });
    } else if (m.type === "loaded" && !started) {
      started = true;
      resumed = hasSave();
      var start = data.start;
      post({ type: "play", seed: Math.floor(Math.random() * 2147483647), world: { room: start.room, x: start.x, y: start.y, abilities: start.abilities, continue: true } });
    } else if (m.type === "modeChanged" && m.mode === "play" && body.dataset.status !== "playing") {
      body.dataset.status = "playing";
      cover.hidden = true;
      showControls(8, true);
      focusGame();
    } else if (m.type === "roomEntered") {
      body.dataset.room = m.room;
    } else if (m.type === "state") {
      var resolve = pending[m.requestId];
      delete pending[m.requestId];
      if (resolve) resolve(m);
    } else if (m.type === "error") {
      if (body.dataset.status === "loading") fail("This game could not start: " + m.message);
      else console.warn("[game]", m.code, m.message);
    }
  });

  window.game = {
    /** The runtime's state (protocol "state"): mode, room, modal, flags... */
    state: function () {
      return new Promise(function (resolve, reject) {
        if (!frame || !data) return reject(new Error("the game is not loaded"));
        var id = "req_" + nextRequest++;
        pending[id] = resolve;
        setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(new Error("the game did not answer"));
        }, 3000);
        post({ type: "getState", requestId: id });
      });
    },
  };

  document.getElementById("help").addEventListener("click", function () {
    if (controls.hidden) showControls(0, false);
    else hideControls();
  });
  document.getElementById("close").addEventListener("click", hideControls);
  document.getElementById("change-keys").addEventListener("click", showKeys);
  document.getElementById("keys-done").addEventListener("click", hideControls);
  document.getElementById("reset-keys").addEventListener("click", function () {
    overrides = {};
    listening = null;
    saveOverrides();
    message("Back to the game's keys.");
  });
  startOver.addEventListener("click", function () {
    try { localStorage.removeItem(data.saveKey); } catch (e) {}
    location.reload();
  });

  if (location.protocol === "file:") return fail("Browsers only run this game from a web server, not from a file. See README.txt for how to serve it.");
  fetch("game.json").then(function (res) {
    if (!res.ok) throw new Error("game.json: HTTP " + res.status);
    return res.json();
  }).then(function (json) {
    data = json;
    keys = data.controls;
    loadOverrides();
    renderKeys();
    frame = document.createElement("iframe");
    frame.title = data.title;
    frame.allow = "autoplay; fullscreen; gamepad";
    frame.src = "runtime/index.html";
    frame.addEventListener("load", function () {
      try { frame.contentDocument.addEventListener("contextmenu", noMenu); } catch (e) {}
    });
    document.getElementById("stage").appendChild(frame);
  }, function (e) { fail("This game could not load (" + e.message + ")."); });
})();
</script>
</body>
</html>
`;
}
