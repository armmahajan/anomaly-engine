import { RUNTIME_SOURCE, STUDIO_SOURCE } from "../protocol.ts";
import type { GameExportData } from "./gameExport.ts";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The export's index.html: hosts the unchanged web runtime (runtime/index.html) full window and
 * plays the studio's side of the protocol (packages/core/src/protocol.ts): on `ready` it sends the
 * images and the game (game.json), on `loaded` it plays from the world's start, resuming the run
 * saved in this browser if there is one. The controls show for a few seconds, and again from the
 * corner button (with "Start over" when a save exists). Everything is relative and inline: no
 * other requests than the export's own files.
 *
 * For tests and embedding pages: `window.game.state()` resolves to the runtime's `state` message,
 * and <body data-status> is "loading" | "playing" | "error" (data-room: the room the player is in).
 */
export function exportBootPage(data: GameExportData): string {
  const title = escapeHtml(data.title);
  const background = /^#[0-9a-f]{6}$/i.test(data.project.world.backgroundColor) ? data.project.world.backgroundColor : "#1b2030";
  const controls = data.controls.map((c) => `<dt>${escapeHtml(c.keys)}</dt><dd>${escapeHtml(c.action)}</dd>`).join("");
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
<h2>Controls</h2>
<p id="resumed" hidden>Continuing your saved game.</p>
<dl>${controls}</dl>
<div class="actions"><button type="button" id="start-over" hidden title="Forget the saved game and play from the beginning">Start over</button><button type="button" id="close">OK</button></div>
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
  function hasSave() {
    try { return localStorage.getItem(data.saveKey) !== null; } catch (e) { return false; }
  }
  // At the start: "Start over" only when a saved game was resumed. From the ? button: whenever a save exists.
  function showControls(seconds, atStart) {
    controls.hidden = false;
    document.getElementById("resumed").hidden = !(atStart && resumed);
    startOver.hidden = atStart ? !resumed : !hasSave();
    clearTimeout(hideTimer);
    if (seconds) hideTimer = setTimeout(hideControls, seconds * 1000);
  }
  function hideControls() {
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
    frame = document.createElement("iframe");
    frame.title = data.title;
    frame.allow = "autoplay; fullscreen; gamepad";
    frame.src = "runtime/index.html";
    document.getElementById("stage").appendChild(frame);
  }, function (e) { fail("This game could not load (" + e.message + ")."); });
})();
</script>
</body>
</html>
`;
}
