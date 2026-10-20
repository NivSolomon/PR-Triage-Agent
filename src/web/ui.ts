/**
 * The whole web page, served as two strings (no build step, no framework).
 * Security rule for the script: untrusted text (PR titles, comments, model output) is only ever
 * written with textContent, never innerHTML, so it cannot inject markup. The JS avoids backticks
 * and template placeholders on purpose because it lives inside a TypeScript template string.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR Triage Agent</title>
<style>
  /* Explicit colours, not "color-scheme: light dark": some browsers then leave the page background unset and text unreadable. */
  :root { color-scheme: light; --b:#cbd5e1; --muted:#64748b; --accent:#2563eb; }
  body { font: 15px/1.45 system-ui, sans-serif; max-width: 920px; margin: 0 auto; padding: 16px; background: #fff; color: #0f172a; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  section, .card { border: 1px solid var(--b); border-radius: 8px; padding: 12px; margin: 10px 0; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: 13px/1.4 ui-monospace, monospace; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--b); cursor: pointer; background: #f8fafc; color: #0f172a; }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.danger { color: #b91c1c; }
  button:disabled { opacity: .5; cursor: default; }
  input[type=text], input[type=password], textarea { font: inherit; width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid var(--b); background: #fff; color: #0f172a; }
  .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .bubble { padding: 8px 10px; border-radius: 8px; margin: 6px 0; white-space: pre-wrap; word-break: break-word; }
  .me { background: #dbeafe; }
  .bot { background: #f1f5f9; }
  .status { font-weight: 600; }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>PR Triage Agent</h1>
<div class="muted" id="repo">Answers only from live GitHub data. Posts a comment only after a human approves it.</div>

<section id="login">
  <label for="key">Access key</label>
  <input id="key" type="password" autocomplete="off" placeholder="Paste your access or approver key">
  <div class="row"><button class="primary" id="loginBtn">Sign in</button><span id="loginMsg" class="muted"></span></div>
</section>

<div id="main" class="hidden">
  <div class="muted"><span id="who"></span> <button id="logout">Sign out</button> <span id="budget"></span></div>

  <h2>Ask the agent</h2>
  <section>
    <div id="chat"></div>
    <textarea id="text" rows="2" placeholder="What should we review first?"></textarea>
    <div class="row"><button class="primary" id="send">Send</button><span id="chatMsg" class="muted"></span></div>
  </section>

  <h2>Approvals</h2>
  <div class="muted">Nothing is posted to GitHub until an approver approves the exact text shown.</div>
  <div id="actions"></div>

  <h2>Review queue</h2>
  <div class="row"><button id="refresh">Refresh queue</button></div>
  <pre id="queue" class="card">Not loaded yet.</pre>
</div>
<script src="/app.js"></script>
</body>
</html>`;

export const APP_JS = `
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var key = sessionStorage.getItem("key") || "";
  var role = "";
  var conv = sessionStorage.getItem("conv");
  if (!conv) { conv = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); sessionStorage.setItem("conv", conv); }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + key, "Content-Type": "application/json" }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (r.status === 401) { signOut(); throw new Error(body.error || "Signed out"); }
        if (!r.ok && !body.text) throw new Error(body.error || ("HTTP " + r.status));
        return body;
      });
    });
  }

  function bubble(cls, text) {
    var d = document.createElement("div");
    d.className = "bubble " + cls;
    d.textContent = text;
    $("chat").appendChild(d);
    d.scrollIntoView({ block: "nearest" });
    return d;
  }

  function signOut() {
    sessionStorage.removeItem("key"); key = "";
    $("main").classList.add("hidden"); $("login").classList.remove("hidden");
  }

  function signIn() {
    return api("/api/me").then(function (me) {
      role = me.role;
      $("login").classList.add("hidden"); $("main").classList.remove("hidden");
      $("who").textContent = "Signed in as " + (role === "approver" ? "approver" : "reader (cannot approve)") + " for " + me.repo + ".";
      loadActions(); loadBudget();
    });
  }

  function loadBudget() {
    api("/api/budget").then(function (b) {
      $("budget").textContent = " AI budget: " + Math.round(b.ratio * 100) + "% used (" + b.level + " mode)";
    }).catch(function () {});
  }

  function actionCard(a) {
    var box = document.createElement("div"); box.className = "card";
    var st = document.createElement("div"); st.className = "status"; st.textContent = a.status.toUpperCase() + " - #" + a.id.slice(0, 8);
    var pre = document.createElement("pre"); pre.textContent = a.card;
    box.appendChild(st); box.appendChild(pre);
    if (a.status === "pending" && role === "approver") {
      var row = document.createElement("div"); row.className = "row";
      var ok = document.createElement("button"); ok.className = "primary"; ok.textContent = "Approve and post";
      var no = document.createElement("button"); no.className = "danger"; no.textContent = "Reject";
      var msg = document.createElement("span"); msg.className = "muted";
      function decide(kind) {
        ok.disabled = true; no.disabled = true; msg.textContent = "Working...";
        api("/api/actions/" + encodeURIComponent(a.id) + "/" + kind, { method: "POST", body: "{}" })
          .then(function (r) { msg.textContent = r.text; loadActions(); })
          .catch(function (e) { msg.textContent = e.message; ok.disabled = false; no.disabled = false; });
      }
      ok.onclick = function () { decide("approve"); };
      no.onclick = function () { decide("reject"); };
      row.appendChild(ok); row.appendChild(no); row.appendChild(msg); box.appendChild(row);
    } else if (a.status === "pending") {
      var note = document.createElement("div"); note.className = "muted"; note.textContent = "Waiting for an approver.";
      box.appendChild(note);
    } else if (a.status !== "executing") {
      var out = document.createElement("div"); out.className = "muted";
      out.textContent = a.status === "executed" ? "Posted: " + (a.resultUrl || a.prUrl) : (a.error || "");
      box.appendChild(out);
    }
    return box;
  }

  function loadActions() {
    api("/api/actions").then(function (r) {
      var el = $("actions"); el.textContent = "";
      if (!r.actions.length) { el.textContent = "No actions yet."; return; }
      r.actions.forEach(function (a) { el.appendChild(actionCard(a)); });
    }).catch(function (e) { $("actions").textContent = e.message; });
  }

  function send() {
    var t = $("text").value.trim();
    if (!t) return;
    $("send").disabled = true; $("chatMsg").textContent = "";
    bubble("me", t); $("text").value = "";
    var wait = bubble("bot", "Thinking...");
    api("/api/chat", { method: "POST", body: JSON.stringify({ text: t, conversationId: conv }) })
      .then(function (r) { wait.textContent = r.text; loadActions(); loadBudget(); })
      .catch(function (e) { wait.textContent = "Error: " + e.message; })
      .then(function () { $("send").disabled = false; });
  }

  $("loginBtn").onclick = function () {
    key = $("key").value.trim(); $("loginMsg").textContent = "";
    sessionStorage.setItem("key", key);
    signIn().catch(function (e) { $("loginMsg").textContent = e.message; });
  };
  $("logout").onclick = signOut;
  $("send").onclick = send;
  $("text").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  $("refresh").onclick = function () {
    $("queue").textContent = "Loading...";
    api("/api/queue").then(function (r) { $("queue").textContent = r.text; }).catch(function (e) { $("queue").textContent = e.message; });
  };
  if (key) signIn().catch(function () {});
})();
`;
