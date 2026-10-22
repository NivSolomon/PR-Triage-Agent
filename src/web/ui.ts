/**
 * The whole web page, served as two strings (no build step, no framework).
 * Security rule for the script: untrusted text (PR titles, comments, model output) is only ever
 * written with textContent, never innerHTML, so it cannot inject markup. The JS avoids backticks,
 * template placeholders and backslashes on purpose because it lives inside a TypeScript template string.
 * Catalog JSON is interpolated once at load time (not by the browser script).
 */
import { EN } from "../i18n/catalog.js";
import { webPromptGroups } from "../prompts/bank.js";
import { LIST_PREVIEW, LIST_STEP } from "../text/fold-list.js";

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR Triage Agent</title>
<style>
  /* Every colour is set explicitly in both themes (background AND text), so a browser can never
     end up with an unset background and unreadable text. */
  :root {
    color-scheme: light;
    --bg:#f4f6fb; --panel:#ffffff; --fg:#0f172a; --muted:#64748b; --line:#e2e8f0; --soft:#f1f5f9;
    --accent:#4f46e5; --accent-fg:#ffffff; --accent-soft:#eef2ff;
    --ok:#15803d; --ok-bg:#dcfce7; --warn:#b45309; --warn-bg:#fef3c7; --bad:#b91c1c; --bad-bg:#fee2e2;
    --info:#1d4ed8; --info-bg:#dbeafe; --neutral:#475569; --neutral-bg:#e2e8f0;
    --me:#4f46e5; --me-fg:#ffffff; --shadow:0 1px 2px rgba(15,23,42,.06), 0 4px 14px rgba(15,23,42,.05);
  }
  /* Dark theme: follows the system unless the user picked one with the toggle (data-theme). */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg:#0b1020; --panel:#141a2e; --fg:#e5e9f5; --muted:#94a3b8; --line:#26304d; --soft:#1b2340;
      --accent:#818cf8; --accent-fg:#0b1020; --accent-soft:#1e2547;
      --ok:#86efac; --ok-bg:#12351f; --warn:#fcd34d; --warn-bg:#3b2a0b; --bad:#fca5a5; --bad-bg:#3d1519;
      --info:#93c5fd; --info-bg:#16284d; --neutral:#cbd5e1; --neutral-bg:#26304d;
      --me:#6366f1; --me-fg:#ffffff; --shadow:0 1px 2px rgba(0,0,0,.4), 0 4px 14px rgba(0,0,0,.3);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg:#0b1020; --panel:#141a2e; --fg:#e5e9f5; --muted:#94a3b8; --line:#26304d; --soft:#1b2340;
    --accent:#818cf8; --accent-fg:#0b1020; --accent-soft:#1e2547;
    --ok:#86efac; --ok-bg:#12351f; --warn:#fcd34d; --warn-bg:#3b2a0b; --bad:#fca5a5; --bad-bg:#3d1519;
    --info:#93c5fd; --info-bg:#16284d; --neutral:#cbd5e1; --neutral-bg:#26304d;
    --me:#6366f1; --me-fg:#ffffff; --shadow:0 1px 2px rgba(0,0,0,.4), 0 4px 14px rgba(0,0,0,.3);
  }
  * { box-sizing: border-box; }
  /* System fonts only: a web font would need a third-party request, which the page's security policy forbids. */
  body { margin: 0; font: 15px/1.55 "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "SF Pro Text", Roboto, "Helvetica Neue", Arial, sans-serif; letter-spacing: -0.005em; background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; font-feature-settings: "cv11", "ss01"; }
  h1, h2, h4 { letter-spacing: -0.015em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .hidden { display: none !important; }
  .muted { color: var(--muted); font-size: 13px; }

  /* top bar */
  header.bar { position: sticky; top: 0; z-index: 5; background: var(--panel); border-bottom: 1px solid var(--line); }
  .bar-in { max-width: 1240px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; }
  .logo { width: 30px; height: 30px; border-radius: 8px; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-size: 15px; }
  .spacer { flex: 1; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--neutral-bg); color: var(--neutral); white-space: nowrap; }
  #queueMeta.stale { color: var(--warn); font-weight: 600; }
  .chip.ok { background: var(--ok-bg); color: var(--ok); }
  .chip.warn { background: var(--warn-bg); color: var(--warn); }
  .chip.bad { background: var(--bad-bg); color: var(--bad); }
  .chip.info { background: var(--info-bg); color: var(--info); }
  .meter { width: 90px; height: 6px; border-radius: 99px; background: var(--neutral-bg); overflow: hidden; }
  .meter > i { display: block; height: 100%; background: var(--ok); border-radius: 99px; }
  .meter.warn > i { background: var(--warn); }
  .meter.bad > i { background: var(--bad); }
  .budget { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }

  /* buttons and inputs */
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 14px; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line); cursor: pointer; background: var(--panel); color: var(--fg); transition: background .12s, border-color .12s; }
  button:hover:not(:disabled) { background: var(--soft); }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
  button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
  button.danger { color: var(--bad); }
  button.ghost { border-color: transparent; background: transparent; color: var(--muted); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input[type=password], textarea { font: inherit; width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); resize: vertical; }

  /* login */
  #login { max-width: 420px; margin: 12vh auto 0; padding: 0 16px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
  .login-card { padding: 28px; }
  .login-card h1 { margin: 12px 0 4px; font-size: 22px; }
  .login-card label { display: block; margin: 18px 0 6px; font-weight: 600; font-size: 13px; }

  /* layout */
  main { max-width: 1240px; margin: 0 auto; padding: 20px; display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 20px; align-items: start; }
  .col { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  @media (max-width: 960px) { main { grid-template-columns: minmax(0, 1fr); } }
  .sec-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 0; flex-wrap: wrap; }
  .sec-head h2 { margin: 0; font-size: 16px; }
  .sec-body { padding: 12px 16px 16px; }

  /* queue */
  .toolbar { display: grid; gap: 10px; margin-bottom: 12px; }
  .tool-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .search { flex: 1; min-width: 160px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); font: inherit; font-size: 14px; }
  select { font: inherit; font-size: 13px; padding: 7px 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); max-width: 170px; }
  .filter { cursor: pointer; border: 1px solid transparent; user-select: none; opacity: .7; }
  .filter:hover { opacity: 1; }
  .filter.on { border-color: var(--accent); opacity: 1; box-shadow: 0 0 0 1px var(--accent); }
  .switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); cursor: pointer; user-select: none; }
  .switch input { accent-color: var(--accent); width: 15px; height: 15px; margin: 0; }
  .result-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  button.small { font-size: 12px; padding: 4px 10px; }

  /* PR card: colour strip by state, compact header, details revealed on toggle */
  .q-sec { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 8px; }
  .q-sec:first-child { margin-top: 2px; }
  .pr { --tone: var(--neutral); border: 1px solid var(--line); border-left: 4px solid var(--tone); border-radius: 12px; margin-bottom: 10px; background: var(--panel); overflow: hidden; transition: box-shadow .15s, border-color .15s; }
  .pr.t-ok { --tone: var(--ok); }
  .pr.t-warn { --tone: var(--warn); }
  .pr.t-bad { --tone: var(--bad); }
  .pr.t-info { --tone: var(--info); }
  .pr:hover { box-shadow: var(--shadow); }
  .pr.open { border-color: var(--tone); }
  .pr-head { display: flex; gap: 12px; align-items: center; padding: 12px 14px; cursor: pointer; }
  .pr-head:hover { background: var(--soft); }
  .chev { flex: none; width: 24px; height: 24px; padding: 0; border: 0; background: transparent; display: grid; place-items: center; border-radius: 6px; }
  .chev::before { content: ""; width: 7px; height: 7px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform .15s; }
  .pr.open .chev::before { transform: rotate(45deg); }
  .pr-main { flex: 1; min-width: 0; }
  .pr-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr.open .pr-title { white-space: normal; word-break: break-word; }
  .pr-num { color: var(--muted); font-weight: 500; margin-right: 6px; }
  .pr-sub { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
  .pr-line { margin-top: 4px; color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr.open .pr-line { display: none; }
  .ring { --p: 0; --ringc: var(--ok); flex: none; width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(var(--ringc) calc(var(--p) * 1%), var(--neutral-bg) 0); }
  .ring.warn { --ringc: var(--warn); }
  .ring.bad { --ringc: var(--bad); }
  .ring b { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--panel); font-size: 14px; }
  .pr-body { padding: 0 14px 14px 50px; border-top: 1px solid var(--line); }
  .pr-body > :first-child { margin-top: 12px; }
  @media (max-width: 560px) { .pr-body { padding-left: 14px; } }
  .reco { padding: 9px 12px; border-radius: 8px; background: var(--accent-soft); font-size: 14px; }
  /* score waterfall diagram */
  .wf { margin-top: 12px; }
  .wf h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .wf-rows { display: grid; gap: 6px; }
  .wf-row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(90px, 1fr) 38px; gap: 10px; align-items: center; font-size: 13px; }
  @media (max-width: 560px) { .wf-row { grid-template-columns: minmax(0, 1fr) 70px 34px; } }
  /* Long signal texts wrap onto more lines instead of being cut off. */
  .wf-label { display: flex; align-items: flex-start; gap: 7px; min-width: 0; line-height: 1.35; }
  .wf-label span { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
  .wf-label .ic { color: var(--muted); margin-top: 2px; }
  .wf-track { position: relative; height: 10px; border-radius: 99px; background: var(--soft); background-image: linear-gradient(var(--line), var(--line)); background-size: 1px 100%; background-position: 50% 0; background-repeat: no-repeat; overflow: hidden; }
  .wf-track i { position: absolute; top: 0; bottom: 0; border-radius: 99px; background: var(--neutral); opacity: .55; }
  .wf-row.pos .wf-track i { background: var(--ok); opacity: 1; }
  .wf-row.neg .wf-track i { background: var(--bad); opacity: 1; }
  .wf-row.total .wf-track i { background: var(--accent); opacity: 1; }
  .wf-row.pos .ic { color: var(--ok); } .wf-row.neg .ic { color: var(--bad); } .wf-row.total .ic { color: var(--accent); }
  .wf-val { text-align: right; font-variant-numeric: tabular-nums; }
  .wf-row.pos .wf-val { color: var(--ok); } .wf-row.neg .wf-val { color: var(--bad); }
  .wf-row.total { margin-top: 4px; padding-top: 8px; border-top: 1px dashed var(--line); font-weight: 700; }
  .calc { margin-top: 10px; font-size: 12px; color: var(--muted); }
  .unknowns { margin: 12px 0 0; padding: 8px 10px 8px 26px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); font-size: 13px; }
  .pr-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  a.btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); }
  a.btn:hover { background: var(--soft); text-decoration: none; }
  a.btn.accent { background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 600; }
  a.btn.ok { background: var(--ok-bg); border-color: transparent; color: var(--ok); font-weight: 600; }
  .ic { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .ic.fill { fill: currentColor; stroke: none; }
  button.small .ic, a.btn .ic { width: 14px; height: 14px; }
  .empty { text-align: center; padding: 26px 8px; color: var(--muted); display: grid; gap: 10px; justify-items: center; }
  .empty-ic { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; background: var(--soft); color: var(--muted); }
  .empty-ic .ic { width: 24px; height: 24px; }
  .empty-ic.big { width: 64px; height: 64px; margin: 0 auto 10px; background: var(--accent-soft); color: var(--accent); }
  .empty-ic.big .ic { width: 30px; height: 30px; }
  .empty.ok .empty-ic { background: var(--ok-bg); color: var(--ok); }
  .empty.bad .empty-ic { background: var(--bad-bg); color: var(--bad); }

  /* overview tiles and proportion bar */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 8px; }
  .tile { --tone: var(--neutral); --tone-bg: var(--neutral-bg); justify-content: flex-start; gap: 10px; padding: 10px 12px; border-radius: 12px; text-align: left; opacity: .85; }
  .tile.ok { --tone: var(--ok); --tone-bg: var(--ok-bg); } .tile.warn { --tone: var(--warn); --tone-bg: var(--warn-bg); }
  .tile.bad { --tone: var(--bad); --tone-bg: var(--bad-bg); } .tile.info { --tone: var(--info); --tone-bg: var(--info-bg); }
  .tile:hover { opacity: 1; }
  .tile.on { opacity: 1; border-color: var(--tone); box-shadow: 0 0 0 1px var(--tone); }
  .tile-ic { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--tone-bg); color: var(--tone); }
  .tile-ic .ic { width: 18px; height: 18px; }
  .tile-txt { display: grid; line-height: 1.2; }
  .tile-txt b { font-size: 20px; }
  .tile-txt span { font-size: 12px; color: var(--muted); }
  .stack { display: flex; height: 10px; border-radius: 99px; overflow: hidden; background: var(--soft); }
  .stack i { display: block; height: 100%; background: var(--neutral); opacity: .6; min-width: 4px; }
  .stack i.ok { background: var(--ok); opacity: 1; } .stack i.warn { background: var(--warn); opacity: 1; }
  .stack i.bad { background: var(--bad); opacity: 1; } .stack i.info { background: var(--info); opacity: 1; }
  .stack i + i { border-left: 2px solid var(--panel); }

  /* confidence meter and author */
  .conf { display: inline-flex; align-items: flex-end; gap: 2px; font-size: 12px; color: var(--muted); }
  .conf i { width: 4px; border-radius: 1px; background: var(--neutral-bg); }
  .conf i:nth-child(1) { height: 6px; } .conf i:nth-child(2) { height: 10px; } .conf i:nth-child(3) { height: 14px; }
  .conf i.on { background: var(--ok); }
  .conf.medium i.on { background: var(--warn); } .conf.low i.on { background: var(--bad); }
  .conf span { margin-left: 5px; line-height: 14px; }
  .by { display: inline-flex; align-items: center; gap: 4px; }
  .by .ic { width: 13px; height: 13px; }

  /* approval life-cycle diagram */
  .flow { list-style: none; display: flex; align-items: center; margin: 4px 0 12px; padding: 0; }
  .flow .step { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .flow .dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; border: 2px solid var(--line); background: var(--panel); color: var(--muted); }
  .flow .dot .ic { width: 12px; height: 12px; stroke-width: 3; }
  .flow .step.done .dot { background: var(--ok); border-color: var(--ok); color: var(--bg); }
  .flow .step.done .lbl { color: var(--fg); }
  .flow .step.now .dot { border-color: var(--warn); color: var(--warn); box-shadow: 0 0 0 4px var(--warn-bg); }
  .flow .step.now .lbl { color: var(--warn); font-weight: 600; }
  .flow .step.fail .dot { background: var(--bad); border-color: var(--bad); color: var(--bg); }
  .flow .step.fail .lbl { color: var(--bad); font-weight: 600; }
  .flow .link { flex: 1; min-width: 14px; height: 2px; margin: 0 8px; background: var(--line); border-radius: 2px; }
  .flow .link.on { background: var(--ok); }

  /* chat avatars */
  .msg { display: flex; gap: 8px; align-items: flex-end; }
  .msg.me { flex-direction: row-reverse; }
  .avatar { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
  .msg.me .avatar { background: var(--me); color: var(--me-fg); }
  .avatar .ic { width: 15px; height: 15px; }

  /* login features */
  .features { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 12px; }
  .features li { display: flex; gap: 12px; align-items: flex-start; font-size: 13px; color: var(--muted); }
  .features b { display: block; color: var(--fg); font-size: 14px; }
  .fi { flex: none; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
  .fi .ic { width: 16px; height: 16px; }
  .logo .ic { width: 17px; height: 17px; }
  .logo.big { width: 44px; height: 44px; border-radius: 12px; }
  .logo.big .ic { width: 24px; height: 24px; }
  .sec-head h2 { display: flex; align-items: center; gap: 8px; }
  .sec-head h2 .ic, .drawer-head h2 .ic { color: var(--accent); }
  .drawer-head h2 { display: flex; align-items: center; gap: 8px; }
  .chip .ic { width: 13px; height: 13px; }
  .budget .ic { width: 14px; height: 14px; }
  .skeleton { height: 78px; border-radius: 12px; margin-bottom: 10px; background: linear-gradient(90deg, var(--soft), var(--line), var(--soft)); background-size: 200% 100%; animation: shimmer 1.2s infinite linear; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

  /* chat */
  /* Floating button + slide-over drawer: the queue stays visible and usable while you chat. */
  .fab { position: fixed; right: 22px; bottom: 22px; z-index: 20; display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-radius: 999px; background: var(--accent); color: var(--accent-fg); border: 0; font-weight: 600; box-shadow: 0 6px 22px rgba(79,70,229,.45); }
  .fab:hover:not(:disabled) { background: var(--accent); filter: brightness(1.1); }
  .fab .ic { width: 20px; height: 20px; }
  .fab .dot { position: absolute; top: -2px; right: -2px; width: 14px; height: 14px; border-radius: 50%; background: var(--bad); border: 2px solid var(--bg); }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 30; width: min(440px, 100vw); display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--line); box-shadow: -10px 0 30px rgba(15,23,42,.18); transform: translateX(105%); visibility: hidden; transition: transform .22s ease, visibility 0s linear .22s; }
  .drawer.open { transform: none; visibility: visible; transition: transform .22s ease; }
  .drawer-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .drawer-head h2 { margin: 0; font-size: 16px; }
  .drawer-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px 16px; }
  .drawer-foot { padding: 12px 16px 14px; border-top: 1px solid var(--line); }
  /* A click anywhere outside the open chat closes it. On a wide screen the page stays undimmed and readable. */
  .backdrop { display: none; position: fixed; inset: 0; z-index: 25; background: transparent; }
  .backdrop.open { display: block; }
  @media (max-width: 960px) { .backdrop.open { background: rgba(15,23,42,.45); } }
  #chat { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px; }
  .chat-empty { margin: auto; text-align: center; color: var(--muted); font-size: 14px; padding: 12px; }
  .chat-empty b { display: block; color: var(--fg); font-size: 16px; margin-bottom: 4px; }
  #chat { gap: 14px; padding: 4px 2px 8px; scroll-behavior: smooth; }
  .msgcol { display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: calc(100% - 42px); }
  .msg.me .msgcol { align-items: flex-end; }
  .bubble { padding: 10px 14px; border-radius: 16px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14.5px; line-height: 1.6; }
  .bubble.me { background: var(--me); color: var(--me-fg); border-bottom-right-radius: 5px; }
  .bubble.bot { background: var(--soft); border: 1px solid var(--line); border-bottom-left-radius: 5px; white-space: normal; }
  .bubble.err { background: var(--bad-bg); border-color: transparent; color: var(--bad); }
  .msg-meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); padding: 0 4px; }
  .msg-meta button { padding: 2px 6px; font-size: 11.5px; border-color: transparent; background: transparent; color: var(--muted); }
  .msg-meta button:hover:not(:disabled) { background: var(--soft); color: var(--fg); }
  .msg-meta .ic { width: 13px; height: 13px; }

  /* formatted answer: paragraphs, lists, key/value rows, link chips */
  .rich > :first-child { margin-top: 0; }
  .rich > :last-child { margin-bottom: 0; }
  .rich p { margin: 0 0 10px; }
  .rich ul, .rich ol { margin: 4px 0 12px; padding-left: 20px; }
  .rich li { margin: 6px 0; padding-left: 2px; }
  .rich li::marker { color: var(--accent); }
  .rich ul ul { margin: 6px 0 4px; padding-left: 0; list-style: none; display: grid; gap: 5px; }
  .rich ul ul li { margin: 0; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; font-size: 13.5px; }
  .rich ul ul li.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 16px; row-gap: 2px; align-items: baseline; }
  .rich ul ul li.kv > .chip { justify-self: start; }
  .rich .k { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; padding-inline-end: 2px; }
  .rich strong { font-weight: 650; }
  .rich code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 1px 6px; border-radius: 6px; background: var(--neutral-bg); }
  .rich .prref { font-weight: 650; color: var(--accent); }
  .rich a.lnk { display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12.5px; font-weight: 600; vertical-align: baseline; }
  .rich a.lnk:hover { text-decoration: none; filter: brightness(1.15); }
  .rich a.lnk .ic { width: 12px; height: 12px; }
  .rich button.more-prs { margin: -2px 0 10px 20px; padding: 5px 12px; font-size: 12.5px; border-radius: 999px; background: var(--accent-soft); border-color: transparent; color: var(--accent); }
  .rich button.more-prs:hover:not(:disabled) { filter: brightness(1.12); }
  .typing::after { content: ""; display: inline-block; width: 1.4em; text-align: left; animation: dots 1.2s steps(4) infinite; }
  @keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75%, 100% { content: "..."; } }
  .suggest { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .suggest button { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--accent-soft); border-color: transparent; color: var(--accent); }
  .prompt-bank { max-height: 220px; overflow: auto; margin-bottom: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); }
  .prompt-bank h4 { margin: 8px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .prompt-bank h4:first-child { margin-top: 0; }
  .prompt-bank button { display: block; width: 100%; text-align: start; font-size: 12.5px; padding: 5px 8px; margin: 2px 0; border-color: transparent; background: var(--panel); }
  .composer { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
  .composer textarea { flex: 1; }
  .composer-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; }
  #textCount.warn { color: var(--warn); font-weight: 600; }

  /* approvals */
  .tabs { display: flex; gap: 4px; padding: 3px; border-radius: 10px; background: var(--soft); width: fit-content; margin-bottom: 12px; }
  .tabs button { border: 0; background: transparent; padding: 5px 12px; font-size: 13px; color: var(--muted); }
  .tabs button.on { background: var(--panel); color: var(--fg); font-weight: 600; box-shadow: var(--shadow); }
  .act { --tone: var(--neutral); border: 1px solid var(--line); border-left: 4px solid var(--tone); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  .act.t-ok { --tone: var(--ok); } .act.t-warn { --tone: var(--warn); } .act.t-bad { --tone: var(--bad); } .act.t-info { --tone: var(--info); }
  .act { padding: 0; overflow: hidden; }
  .act-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; }
  .act-head:hover { background: var(--soft); }
  .act.open .chev::before { transform: rotate(45deg); }
  .act-main { flex: 1; min-width: 0; }
  .act-title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act-preview { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act.open .act-preview { display: none; }
  .act.open .act-title { white-space: normal; word-break: break-word; }
  .act-when { flex: none; font-size: 12px; color: var(--muted); }
  .act-body { padding: 4px 14px 14px; border-top: 1px solid var(--line); }
  .act-body > :first-child { margin-top: 10px; }
  a.btn.plain { max-width: 100%; margin-bottom: 4px; }
  a.btn.plain span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button.more { width: 100%; justify-content: center; margin-top: 2px; }
  @media (max-width: 420px) { .act-when { display: none; } }
  .act-meta { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .quote { margin: 0 0 10px; padding: 8px 12px; border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; background: var(--soft); white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .quote small { display: block; margin-bottom: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .why { font-size: 13px; margin-bottom: 10px; }
  .why b { color: var(--muted); font-weight: 600; }
  details.raw { margin-top: 10px; }
  details.raw summary { cursor: pointer; font-size: 12px; color: var(--muted); }
  details.raw pre { margin-top: 6px; }
  .note { margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 13px; background: var(--warn-bg); color: var(--warn); }
  button.confirm { background: var(--ok); border-color: var(--ok); color: var(--bg); font-weight: 600; }
  button.confirm:hover:not(:disabled) { background: var(--ok); filter: brightness(1.1); }
  .pw { position: relative; }
  .pw input { padding-right: 78px; }
  .pw button { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); }
  .toasts { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 50; display: grid; gap: 8px; justify-items: center; pointer-events: none; width: min(92vw, 460px); }
  .toast { pointer-events: auto; padding: 10px 14px; border-radius: 10px; background: var(--fg); color: var(--bg); font-size: 14px; box-shadow: var(--shadow); animation: toast-in .18s ease-out; max-width: 100%; word-break: break-word; }
  .toast.ok { background: var(--ok); color: var(--bg); }
  .toast.bad { background: var(--bad); color: var(--bg); }
  .toast.out { opacity: 0; transition: opacity .25s; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  kbd { font: 11px ui-monospace, Menlo, Consolas, monospace; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); background: var(--soft); color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 10px; border-radius: 8px; background: var(--soft); font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }

  /* guide popup: what this key may and may not do, centred over the page */
  .modal-back { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(15,23,42,.55); }
  .modal { width: min(640px, 100%); max-height: min(86vh, 800px); display: flex; flex-direction: column; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.35); animation: modal-in .16s ease-out; }
  @keyframes modal-in { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
  .modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
  .modal-head h2 { margin: 0; font-size: 17px; display: flex; align-items: center; gap: 8px; }
  .modal-head h2 .ic { color: var(--accent); }
  .modal-body { padding: 14px 18px 20px; overflow-y: auto; }
  .guide-you { padding: 9px 12px; border-radius: 8px; background: var(--info-bg); color: var(--info); font-weight: 600; font-size: 14px; }
  .guide-you.ok { background: var(--ok-bg); color: var(--ok); }
  .guide-sec { margin-top: 14px; }
  .guide-sec h3 { margin: 0 0 6px; font-size: 13px; display: flex; align-items: center; gap: 7px; }
  .guide-sec.can h3 { color: var(--ok); } .guide-sec.cannot h3 { color: var(--bad); } .guide-sec.rule h3 { color: var(--info); }
  .guide-sec ul { margin: 0; padding-left: 20px; display: grid; gap: 5px; font-size: 13.5px; }
</style>
</head>
<body>

<header class="bar">
  <div class="bar-in">
    <div class="brand"><span class="logo" data-icon="pr"></span> <span data-i18n="brand">PR Triage Agent</span></div>
    <span class="muted" id="repo"></span>
    <span class="spacer"></span>
    <button class="ghost" id="theme" title="Switch between light and dark">Dark mode</button>
    <div id="userbar" class="hidden" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span class="budget" id="budget"></span>
      <span class="chip" id="who"></span>
      <button class="ghost" id="guideBtn" title="What you can and cannot do here">Guide</button>
      <button class="ghost" id="logout">Sign out</button>
    </div>
  </div>
</header>

<div id="login">
  <div class="panel login-card">
    <div class="logo big" data-icon="pr"></div>
    <h1 data-i18n="brand">PR Triage Agent</h1>
    <div class="muted" data-i18n="tagline">Know which pull request to review next, and why.</div>
    <ul class="features">
      <li><span class="fi" data-icon="github"></span><span><b data-i18n="feat.live">Live GitHub data</b> <span data-i18n="feat.live.body">Answers come from your repository, never from memory.</span></span></li>
      <li><span class="fi" data-icon="trend"></span><span><b data-i18n="feat.rank">Explainable ranking</b> <span data-i18n="feat.rank.body">Every score shows the signals behind it.</span></span></li>
      <li><span class="fi" data-icon="shield"></span><span><b data-i18n="feat.human">Human in the loop</b> <span data-i18n="feat.human.body">A comment is only posted after an approver says yes.</span></span></li>
    </ul>
    <label for="key" data-i18n="key.label">Your key</label>
    <div class="pw">
      <input id="key" type="password" autocomplete="off" placeholder="Paste the key you were given" data-i18n-placeholder="key.placeholder">
      <button type="button" class="ghost small" id="showKey" aria-label="Show or hide the key">Show</button>
    </div>
    <div class="row">
      <button class="primary" id="loginBtn">Sign in</button>
      <span id="loginMsg" class="muted" role="alert"></span>
    </div>
  </div>
</div>

<main id="main" class="hidden">
  <div class="col">
    <section class="panel">
      <div class="sec-head">
        <h2 data-icon="pr"><span data-i18n="queue.title">Review queue</span></h2>
        <span class="muted" id="queueMeta"></span>
        <span class="spacer"></span>
        <button id="refresh">Refresh</button>
      </div>
      <div class="sec-body">
        <div class="toolbar">
          <div class="tiles" id="stateChips" role="group" aria-label="Filter by state"></div>
          <div class="stack hidden" id="stack" role="img" aria-label="Share of open pull requests by state"></div>
          <div class="tool-row">
            <input class="search" id="search" type="search" placeholder="Search title, number or author  (press / to focus)" aria-label="Search pull requests">
            <select id="fConf" aria-label="Confidence"></select>
            <select id="fAuthor" aria-label="Author"></select>
            <select id="fSort" aria-label="Sort"></select>
          </div>
          <div class="tool-row">
            <label class="switch"><input type="checkbox" id="fWarn"> <span data-i18n="queue.warn">Only with warnings</span></label>
            <label class="switch"><input type="checkbox" id="fHideDrafts"> <span data-i18n="queue.hideDrafts">Hide drafts</span></label>
          </div>
        </div>
        <div class="result-bar">
          <span class="muted" id="resultCount"></span>
          <span class="spacer"></span>
          <button class="small ghost hidden" id="clearFilters">Clear filters</button>
          <button class="small" id="toggleAll">Expand all</button>
        </div>
        <div id="queue"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
      </div>
    </section>
  </div>

  <div class="col">
    <section class="panel hidden" id="digestPanel">
      <div class="sec-head">
        <h2 data-icon="clock"><span data-i18n="digest.title">Scheduled digest</span></h2>
        <span class="chip" id="digestChip"></span>
        <span class="spacer"></span>
        <button class="small" id="digestToggle">Show last message</button>
      </div>
      <div class="sec-body">
        <div class="muted" id="digestMeta"></div>
        <pre class="hidden" id="digestText" style="margin-top:10px;max-height:260px;overflow:auto"></pre>
        <div id="digestRuns" style="margin-top:10px"></div>
      </div>
    </section>
    <section class="panel">
      <div class="sec-head">
        <h2 data-icon="shield"><span data-i18n="approvals.title">Approvals</span></h2>
        <span class="chip warn hidden" id="pendingCount"></span>
        <span class="spacer"></span>
        <button class="small" id="toggleActs">Expand all</button>
        <button class="ghost" id="refreshActions">Reload</button>
      </div>
      <div class="sec-body">
        <div class="muted" style="margin-bottom:10px" data-i18n="approvals.note">Nothing is posted to GitHub until an approver approves the exact text shown.</div>
        <div class="tabs" id="actTabs" role="tablist"></div>
        <div id="actions"></div>
      </div>
    </section>
  </div>
</main>

<button class="fab hidden" id="fab" aria-controls="drawer" aria-expanded="false">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm4 6v2h8V9H8zm0 4v2h5v-2H8z"/></svg>
  <span data-i18n="chat.ask">Ask the agent</span>
  <i class="dot hidden" id="fabDot"></i>
</button>
<div class="backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer" role="dialog" aria-label="Ask the agent" aria-hidden="true">
  <div class="drawer-head">
    <h2 data-icon="bot"><span data-i18n="chat.ask">Ask the agent</span></h2>
    <span class="spacer"></span>
    <button class="ghost small" id="newChat" title="Start a fresh conversation">New chat</button>
    <button class="ghost small" id="closeChat" aria-label="Close chat">Close</button>
  </div>
  <div class="drawer-body">
    <div id="chat" aria-live="polite"></div>
  </div>
  <div class="drawer-foot">
    <div class="suggest" id="suggest"></div>
    <button type="button" class="ghost small" id="morePrompts">More prompts</button>
    <div id="promptBank" class="prompt-bank hidden"></div>
    <div class="composer">
      <textarea id="text" rows="2" maxlength="2000" placeholder="What should we review first?" data-i18n-placeholder="chat.placeholder"></textarea>
      <button class="primary" id="send">Send</button>
    </div>
    <div class="composer-meta muted"><span id="textCount">0 / 2000</span><span data-i18n="chat.hint">Enter to send, Shift+Enter for a new line, Esc to close.</span></div>
  </div>
</aside>
<div class="modal-back hidden" id="guideModal">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="guideTitle">
    <div class="modal-head">
      <h2 id="guideTitle" data-icon="help"><span data-i18n="guide.title">What can I do here?</span></h2>
      <span class="spacer"></span>
      <button class="ghost small" id="guideClose" aria-label="Close the guide">Close</button>
    </div>
    <div class="modal-body" id="guideBody"><div class="muted">Loading...</div></div>
  </div>
</div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script src="/app.js"></script>
</body>
</html>`;

export const APP_JS = `
(function () {
  var I18N = ${JSON.stringify(EN)};
  var PROMPT_GROUPS = ${JSON.stringify(webPromptGroups())};
  var LIST_PREVIEW = ${LIST_PREVIEW};
  var LIST_STEP = ${LIST_STEP};
  function t(key, vars) {
    var s = I18N[key] || key;
    if (!vars) return s;
    return s.replace(/\{([a-zA-Z0-9_]+)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole;
    });
  }
  var $ = function (id) { return document.getElementById(id); };
  /* No key is kept in the page: signing in sets an HttpOnly session cookie that scripts cannot read. */
  var signedIn = false;
  var role = "";
  var youLogin = "";
  var actorId = "";
  var meName = "";
  var queueData = null;
  var conv = sessionStorage.getItem("conv");
  if (!conv) { conv = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); sessionStorage.setItem("conv", conv); }

  var STATES = {
    needs_review: { label: "Needs review", cls: "info", icon: "eye", hint: "Reviewers can act now" },
    ready_to_merge: { label: "Ready to merge", cls: "ok", icon: "merge", hint: "Approved, nothing blocking" },
    waiting_on_author: { label: "Waiting on author", cls: "warn", icon: "clock", hint: "Failing CI, conflicts or requested changes" },
    draft: { label: "Draft", cls: "", icon: "draft", hint: "Author has not asked for review" },
    unclear: { label: "Unclear", cls: "bad", icon: "help", hint: "Not enough data to say" }
  };
  /* Which icon represents each ranking signal (codes come from triage/analyze.ts). */
  var SIGNAL_ICON = {
    draft: "draft", ci_failing: "ci", ci_green: "ci", ci_pending: "clock", changes_requested: "user", conflicts: "merge",
    behind: "merge", approved: "check", no_approval: "user", long_wait: "clock", stale: "clock", small: "layers",
    large: "layers", review_requested: "eye", stale_approval: "check", merge_blocked: "merge",
    state_review: "eye", state_merge: "check", state_unclear: "help", state_blocked: "clock"
  };
  var STATE_ORDER = ["needs_review", "ready_to_merge", "unclear", "waiting_on_author", "draft"];
  var SUGGESTIONS = ["What should we review first?", "Which PRs are blocked and why?", "What is ready to merge?", "Which PRs have gone stale?"];

  /* Small DOM helper. Text is only ever written with textContent. */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function safeUrl(u) { return typeof u === "string" && u.indexOf("https://") === 0 ? u : ""; }

  /* ---------- icons (inline SVG built with the DOM, no markup strings) ---------- */
  var ICONS = {
    github: "M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z",
    external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3",
    check: "M20 6L9 17l-5-5",
    x: "M18 6L6 18 M6 6l12 12",
    refresh: "M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
    chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    send: "M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z",
    plus: "M12 5v14 M5 12h14",
    sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M12 1v2 M12 21v2 M4.22 4.22l1.42 1.42 M18.36 18.36l1.42 1.42 M1 12h2 M21 12h2 M4.22 19.78l1.42-1.42 M18.36 5.64l1.42-1.42",
    moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z",
    expand: "M7 13l5 5 5-5 M7 6l5 5 5-5",
    collapse: "M17 11l-5-5-5 5 M17 18l-5-5-5 5",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
    eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    clear: "M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6",
    merge: "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21V9a9 9 0 0 0 9 9",
    pr: "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12",
    clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 6v6l4 2",
    draft: "M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z",
    help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01",
    checkCircle: "M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3",
    ci: "M22 12h-4l-3 9L9 3l-3 9H2",
    user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
    bot: "M12 8V4H8 M4 8h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z M2 14h2 M20 14h2 M15 13v2 M9 13v2",
    alert: "M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
    layers: "M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5",
    inbox: "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    search: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.35-4.35",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
    trend: "M3 3v18h18 M7 14l4-4 4 4 5-6",
    coin: "M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
    copy: "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    dot: "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"
  };
  function icon(name) {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", name === "github" ? "ic fill" : "ic");
    s.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", ICONS[name] || "");
    s.appendChild(p);
    return s;
  }
  /* Replace a button's content with an icon and an optional label. */
  function setBtn(node, name, label) {
    clear(node);
    node.appendChild(icon(name));
    if (label) node.appendChild(el("span", "", label));
  }
  function iconBtn(cls, name, label) {
    var b = el("button", cls); b.type = "button"; setBtn(b, name, label); return b;
  }
  /* A coloured badge with the state's icon. */
  function stateChip(state) {
    var st = STATES[state] || { label: state, cls: "", icon: "dot" };
    var c = el("span", "chip " + st.cls);
    c.title = st.hint || "";
    c.appendChild(icon(st.icon));
    c.appendChild(el("span", "", st.label));
    return c;
  }
  /* Empty / error placeholder with a large icon. */
  function emptyState(name, text, tone) {
    var d = el("div", "empty" + (tone ? " " + tone : ""));
    var i = el("div", "empty-ic"); i.appendChild(icon(name));
    d.appendChild(i);
    d.appendChild(el("div", "", text));
    return d;
  }
  function linkBtn(href, name, label, cls) {
    var a = el("a", "btn" + (cls ? " " + cls : ""));
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.appendChild(icon(name));
    a.appendChild(el("span", "", label));
    return a;
  }

  /* ---------- small helpers: toasts and relative time ---------- */
  function toast(msg, tone) {
    var t = el("div", "toast" + (tone ? " " + tone : ""), msg);
    $("toasts").appendChild(t);
    setTimeout(function () {
      t.classList.add("out");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, 4200);
  }
  function span(iso) {
    var s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    var abs = Math.abs(s), txt;
    if (abs < 60) txt = "moments";
    else if (abs < 3600) txt = Math.round(abs / 60) + " min";
    else if (abs < 172800) txt = Math.round(abs / 3600) + " h";
    else txt = Math.round(abs / 86400) + " days";
    return { future: s > 0, text: txt, moments: abs < 60 };
  }
  function ago(iso) { var d = span(iso); return d.moments ? "just now" : d.text + " ago"; }
  function inFuture(iso) { var d = span(iso); return d.future ? (d.moments ? "in moments" : "in " + d.text) : "expired"; }

  function api(path, opts) {
    opts = opts || {};
    /* The browser sends the session cookie by itself; the extra header proves a change came from this page. */
    opts.credentials = "same-origin";
    opts.headers = Object.assign({ "Content-Type": "application/json", "X-Requested-With": "pr-triage" }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (r.status === 401) {
          if (path !== "/api/login") {
            signedIn = false;
            $("main").classList.add("hidden"); $("userbar").classList.add("hidden"); $("login").classList.remove("hidden");
            $("fab").classList.add("hidden"); $("guideModal").classList.add("hidden");
            if (chatIsOpen()) closeChat();
            toast(t("session.expired"), "warn");
          }
          throw new Error(body.error || t("chat.signedOut"));
        }
        if (!r.ok && !body.text) throw new Error(body.error || ("HTTP " + r.status));
        return body;
      });
    });
  }

  /* ---------- chat ---------- */
  function chatIsOpen() { return $("drawer").classList.contains("open"); }

  function openChat() {
    $("drawer").classList.add("open"); $("backdrop").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false"); $("fab").setAttribute("aria-expanded", "true");
    $("fabDot").classList.add("hidden");
    $("chat").scrollTop = $("chat").scrollHeight;
    setTimeout(function () { $("text").focus(); }, 60);
  }

  function closeChat() {
    $("drawer").classList.remove("open"); $("backdrop").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true"); $("fab").setAttribute("aria-expanded", "false");
    $("fab").focus();
  }

  function renderChatEmpty() {
    var box = $("chat"); clear(box);
    var e = el("div", "chat-empty");
    var big = el("div", "empty-ic big"); big.appendChild(icon("bot")); e.appendChild(big);
    e.appendChild(el("b", "", t("chat.emptyTitle")));
    e.appendChild(document.createTextNode(t("chat.emptyBody")));
    box.appendChild(e);
  }

  function newChat() {
    conv = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    sessionStorage.setItem("conv", conv);
    renderChatEmpty();
  }

  function bubble(cls, text) {
    var empty = $("chat").querySelector(".chat-empty");
    if (empty) empty.parentNode.removeChild(empty);
    var mine = cls.indexOf("me") === 0;
    var row = el("div", "msg " + (mine ? "me" : "bot"));
    var av = el("div", "avatar"); av.appendChild(icon(mine ? "user" : "bot"));
    var d = el("div", "bubble " + cls, text);
    var col = el("div", "msgcol");
    col.appendChild(d);
    row.appendChild(av); row.appendChild(col);
    $("chat").appendChild(row);
    row.scrollIntoView({ block: "nearest" });
    return d;
  }

  /* ---------- readable answers ----------
     The agent writes plain text (lists with "-", links on their own line). Turn that into clean
     paragraphs, lists, key/value rows and link chips. It only ever builds DOM nodes from text. */
  var NL = String.fromCharCode(10);
  var TICK = String.fromCharCode(96);
  var repoSlug = "";
  function isDigit(c) { return c >= "0" && c <= "9"; }
  function isSpace(c) { return c === " " || c === NL || c === String.fromCharCode(9) || c === String.fromCharCode(13); }
  function endsWith(s, suffix) { return s.length >= suffix.length && s.slice(s.length - suffix.length) === suffix; }

  function linkChip(url) {
    var rest = url.slice(8);
    var host = rest.split("/")[0];
    var label = host;
    var m = url.indexOf("/pull/");
    var kind = "PR #";
    if (m === -1) { m = url.indexOf("/issues/"); kind = "Issue #"; }
    if (m > -1) {
      var d = url.slice(m).split("/")[2] || "", n = "";
      for (var k = 0; k < d.length && isDigit(d.charAt(k)); k++) n += d.charAt(k);
      if (n) label = kind + n;
    }
    var a = el("a", "lnk");
    a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = url;
    a.appendChild(icon(host === "github.com" ? "github" : "external"));
    a.appendChild(document.createTextNode(label));
    return a;
  }

  function prRef(num) {
    if (!repoSlug) return el("span", "prref", "#" + num);
    var a = el("a", "prref", "#" + num);
    a.href = "https://github.com/" + repoSlug + "/pull/" + num;
    a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = "Open pull request " + num + " on GitHub";
    return a;
  }

  /* **bold**, code in backticks, https links (also "(https://...)") and #123 references. */
  function inline(parent, text) {
    var buf = "";
    var flush = function () { if (buf) { parent.appendChild(document.createTextNode(buf)); buf = ""; } };
    var LABELS = ["View PR ", "View pull request ", "PR link: ", "Link: ", "Source: "];
    var i = 0;
    while (i < text.length) {
      var c = text.charAt(i);
      if (c === "*" && text.charAt(i + 1) === "*") {
        var endB = text.indexOf("**", i + 2);
        if (endB > i + 2) { flush(); parent.appendChild(el("strong", "", text.slice(i + 2, endB))); i = endB + 2; continue; }
      }
      if (c === TICK) {
        var endC = text.indexOf(TICK, i + 1);
        if (endC > i + 1) { flush(); parent.appendChild(el("code", "", text.slice(i + 1, endC))); i = endC + 1; continue; }
      }
      var wrapped = c === "(" && text.indexOf("https://", i + 1) === i + 1;
      if (wrapped || text.indexOf("https://", i) === i) {
        var start = wrapped ? i + 1 : i, j = start;
        while (j < text.length && !isSpace(text.charAt(j)) && text.charAt(j) !== ")") j++;
        var stop = j;
        while (stop > start && ".,;:".indexOf(text.charAt(stop - 1)) > -1) stop--;
        var url = text.slice(start, stop);
        if (url.length > 8) {
          if (wrapped && text.charAt(stop) === ")") stop++;
          LABELS.forEach(function (l) { if (endsWith(buf, l)) buf = buf.slice(0, buf.length - l.length); });
          flush(); parent.appendChild(linkChip(url)); i = stop; continue;
        }
      }
      if (c === "#" && isDigit(text.charAt(i + 1)) && (i === 0 || isSpace(text.charAt(i - 1)) || text.charAt(i - 1) === "(")) {
        var e = i + 1;
        while (e < text.length && isDigit(text.charAt(e))) e++;
        if (e - i - 1 <= 6) { flush(); parent.appendChild(prRef(text.slice(i + 1, e))); i = e; continue; }
      }
      buf += c; i++;
    }
    flush();
  }

  /* "State: Needs review" style sub-lines become a small label plus a value; known values get a badge. */
  function detailRow(li, text) {
    var k = text.indexOf(": ");
    if (k < 1 || k > 26 || text.charAt(0) === "#" || text.slice(0, k).indexOf("http") > -1) { inline(li, text); return; }
    var key = text.slice(0, k), value = text.slice(k + 2);
    li.classList.add("kv");
    li.appendChild(el("span", "k", key));
    var lower = value.toLowerCase(), badge = null, s;
    for (s in STATES) { if (Object.prototype.hasOwnProperty.call(STATES, s) && STATES[s].label.toLowerCase() === lower) badge = stateChip(s); }
    if (!badge && key.toLowerCase().indexOf("ci") === 0) {
      var tone = lower.indexOf("fail") > -1 ? "bad" : lower.indexOf("pass") > -1 || lower.indexOf("green") > -1 ? "ok" : lower.indexOf("pend") > -1 || lower.indexOf("running") > -1 ? "warn" : "";
      if (tone) {
        badge = el("span", "chip " + tone);
        badge.appendChild(icon(tone === "ok" ? "checkCircle" : tone === "bad" ? "x" : "clock"));
        badge.appendChild(el("span", "", value));
      }
    }
    if (badge) li.appendChild(badge);
    else { var v = el("span"); inline(v, value); li.appendChild(v); }
  }

  function renderRich(box, text) {
    clear(box);
    box.classList.add("rich");
    var lines = text.split(NL);
    var para = [], list = null, ordered = false, lastLi = null, sub = null;
    var endList = function () { list = null; lastLi = null; sub = null; };
    var flushPara = function () {
      if (!para.length) return;
      var p = el("p");
      para.forEach(function (line, n) { if (n) p.appendChild(el("br")); inline(p, line); });
      box.appendChild(p); para = [];
    };
    lines.forEach(function (raw) {
      var line = raw.split(String.fromCharCode(13)).join("");
      /* A blank line inside a ranked list must not start a new <ol> (every item would show as 1.). */
      if (line.trim() === "") { if (list) return; flushPara(); return; }
      var indent = 0;
      while (indent < line.length && line.charAt(indent) === " ") indent++;
      var rest = line.slice(indent);
      var marker = rest.slice(0, 2);
      var isBullet = marker === "- " || marker === "* " || rest.slice(0, 2) === String.fromCharCode(8226) + " ";
      var d = 0;
      while (d < rest.length && isDigit(rest.charAt(d))) d++;
      var isNumbered = d > 0 && d < 4 && (rest.charAt(d) === "." || rest.charAt(d) === ")") && rest.charAt(d + 1) === " ";
      if (isBullet || isNumbered) {
        flushPara();
        var body = isBullet ? rest.slice(2) : rest.slice(d + 2);
        /* Nest details under the last ranked item even when the model did not indent the dashes. */
        if (isBullet && lastLi && (indent >= 2 || ordered)) {
          if (!sub) { sub = el("ul"); lastLi.appendChild(sub); }
          var sli = el("li"); detailRow(sli, body.trim()); sub.appendChild(sli);
        } else {
          if (isNumbered) {
            if (!list || !ordered) { ordered = true; list = el("ol"); box.appendChild(list); }
          } else if (!list || ordered) { ordered = false; list = el("ul"); box.appendChild(list); }
          var li = el("li"); inline(li, body.trim()); list.appendChild(li); lastLi = li; sub = null;
        }
        return;
      }
      endList();
      para.push(line.trim());
    });
    flushPara();
    foldLists(box);
  }

  /* Long ranked lists: show 3, then a button that reveals the rest in chunks. */
  function foldLists(box) {
    var ols = box.querySelectorAll("ol");
    var i;
    for (i = 0; i < ols.length; i++) foldOl(ols[i]);
  }
  function foldOl(ol) {
    var items = [];
    var i;
    for (i = 0; i < ol.children.length; i++) {
      if (ol.children[i].tagName === "LI") items.push(ol.children[i]);
    }
    if (items.length <= LIST_PREVIEW) return;
    var shown = LIST_PREVIEW;
    var btn = el("button", "more-prs");
    btn.type = "button";
    var paint = function () {
      var j, left, n;
      for (j = 0; j < items.length; j++) items[j].style.display = j < shown ? "" : "none";
      left = items.length - shown;
      if (left <= 0) {
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        return;
      }
      n = Math.min(LIST_STEP, left);
      btn.textContent = "Show " + n + " more (" + left + " hidden)";
      btn.setAttribute("aria-label", btn.textContent);
    };
    btn.onclick = function () {
      shown = Math.min(items.length, shown + LIST_STEP);
      paint();
    };
    ol.parentNode.insertBefore(btn, ol.nextSibling);
    paint();
  }

  /* Finish a bot message: formatted text, then a small footer with the time and a copy button. */
  function finishBot(bubbleEl, text) {
    bubbleEl.className = "bubble bot";
    renderRich(bubbleEl, text);
    var col = bubbleEl.parentNode;
    var meta = el("div", "msg-meta");
    meta.appendChild(el("span", "", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
    var copy = iconBtn("", "copy", "Copy");
    copy.onclick = function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast("Answer copied.", "ok"); }, function () { toast("Could not copy.", "bad"); });
      } else toast("Copy is not available in this browser.", "bad");
    };
    meta.appendChild(copy);
    col.appendChild(meta);
    col.parentNode.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function usePrompt(s) { $("text").value = s; send(); }

  function renderSuggestions() {
    var box = $("suggest"); clear(box);
    SUGGESTIONS.forEach(function (s) {
      var b = el("button", "", s);
      b.onclick = function () { usePrompt(s); };
      box.appendChild(b);
    });
  }

  function renderPromptBank() {
    var box = $("promptBank"); if (!box) return; clear(box);
    PROMPT_GROUPS.forEach(function (g) {
      box.appendChild(el("h4", "", g.title));
      g.items.forEach(function (s) {
        var b = el("button", "", s);
        b.type = "button";
        b.onclick = function () { usePrompt(s); };
        box.appendChild(b);
      });
    });
  }

  var CHAT_MAX = 2000;
  function updateTextCount() {
    var n = $("text").value.length;
    $("textCount").textContent = n + " / " + CHAT_MAX;
    $("textCount").classList.toggle("warn", n >= CHAT_MAX - 100);
  }

  function send() {
    var msg = $("text").value.trim();
    if (!msg || $("send").disabled) return;
    if (msg.length > CHAT_MAX) { toast(t("chat.tooLong", { limit: CHAT_MAX }), "bad"); return; }
    if (!chatIsOpen()) openChat();
    $("send").disabled = true;
    bubble("me", msg); $("text").value = ""; updateTextCount();
    var wait = bubble("bot typing", t("chat.checking"));
    api("/api/chat", { method: "POST", body: JSON.stringify({ text: msg, conversationId: conv }) })
      .then(function (r) { finishBot(wait, r.text); loadActions(); loadBudget(); })
      .catch(function (e) { wait.className = "bubble bot err"; wait.textContent = t("chat.sorry", { error: e.message }); })
      .then(function () {
        $("send").disabled = false;
        if (chatIsOpen()) $("text").focus(); else $("fabDot").classList.remove("hidden");
      });
  }

  /* ---------- guide popup: what this key may and may not do (text comes from the server, written as text only) ---------- */
  function guideIsOpen() { return !$("guideModal").classList.contains("hidden"); }
  function openGuide() {
    $("guideModal").classList.remove("hidden");
    $("guideClose").focus();
  }
  function closeGuide() {
    $("guideModal").classList.add("hidden");
    $("guideBtn").focus();
  }

  function loadGuide() {
    return api("/api/guide").then(function (g) {
      var box = $("guideBody"); clear(box);
      box.appendChild(el("div", "guide-you" + (role === "approver" ? " ok" : ""), g.youAre));
      g.sections.forEach(function (s) {
        var sec = el("div", "guide-sec " + s.tone);
        var h = el("h3");
        h.appendChild(icon(s.tone === "can" ? "checkCircle" : s.tone === "cannot" ? "x" : "shield"));
        h.appendChild(document.createTextNode(s.title));
        sec.appendChild(h);
        var ul = el("ul");
        s.items.forEach(function (t) { ul.appendChild(el("li", "", t)); });
        sec.appendChild(ul);
        box.appendChild(sec);
      });
      /* Show it once to a new visitor, then leave it to the Guide button. */
      var first = false;
      try { first = !localStorage.getItem("guideSeen"); localStorage.setItem("guideSeen", "1"); } catch (e) {}
      if (first) openGuide();
    }).catch(function () {
      clear($("guideBody"));
      $("guideBody").appendChild(el("div", "muted", "The guide could not be loaded. Reload the page to try again."));
    });
  }

  /* ---------- budget ---------- */
  function loadBudget() {
    api("/api/budget").then(function (b) {
      var box = $("budget"); clear(box);
      var pct = Math.min(100, Math.round(b.ratio * 100));
      var tone = b.level === "blocked" ? "bad" : b.level === "economy" ? "warn" : "";
      box.title = "Monthly AI budget used. Normal, economy or blocked mode depends on this.";
      box.appendChild(icon("coin"));
      box.appendChild(el("span", "", "AI budget " + Math.round(b.ratio * 100) + "%"));
      var m = el("span", "meter " + tone); var i = el("i"); i.style.width = pct + "%"; m.appendChild(i);
      box.appendChild(m);
      if (b.level !== "normal") box.appendChild(el("span", "chip " + tone, b.level + " mode"));
    }).catch(function () {});
  }

  /* ---------- scheduled digest: read-only proof that the schedule ran ---------- */
  var digestRuns = [];
  /* "Friday 23 Oct, 08:30" in the schedule's own time zone, 24-hour clock, built from parts so the shape never varies by browser. */
  function when(iso, tz) {
    var d = new Date(iso);
    try {
      var o = { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
      if (tz) o.timeZone = tz;
      var p = {};
      new Intl.DateTimeFormat("en-GB", o).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
      return p.weekday + " " + p.day + " " + p.month + ", " + p.hour + ":" + p.minute;
    } catch (e) { return d.toLocaleString(); }
  }
  /* "in 15 hours" / "9 hours ago" / "in 1 day": whole words, no abbreviations. */
  function rel(iso) {
    var s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    var abs = Math.abs(s), n, unit;
    if (abs < 60) return "just now";
    if (abs < 3600) { n = Math.round(abs / 60); unit = "minute"; }
    else if (abs < 172800) { n = Math.round(abs / 3600); unit = "hour"; }
    else { n = Math.round(abs / 86400); unit = "day"; }
    var t = n + " " + unit + (n === 1 ? "" : "s");
    return s > 0 ? "in " + t : t + " ago";
  }
  function renderDigest(d) {
    var panel = $("digestPanel");
    if (!d || !d.enabled) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    digestRuns = d.runs || [];
    var last = digestRuns[0];
    var chip = $("digestChip");
    chip.className = "chip " + (last ? (last.ok ? "ok" : "bad") : "");
    chip.textContent = last ? (last.ok ? "Last run worked" : "Last run failed") : "No run yet";

    var meta = $("digestMeta"); clear(meta);
    var line = function (label, value, bad, hint) {
      var row = el("div", "");
      if (bad) row.style.color = "var(--bad)";
      if (hint) row.title = hint;
      row.appendChild(el("strong", "", label + ": "));
      row.appendChild(document.createTextNode(value));
      meta.appendChild(row);
    };
    /* Hover shows the raw cron expression, for anyone who wants the exact setting. */
    line("Runs", (d.schedule || d.cron) + ", " + d.timezone + " time", false, "Setting (DIGEST_CRON): " + d.cron);
    line("Next run", d.nextRun ? when(d.nextRun, d.timezone) + " (" + rel(d.nextRun) + ")" : "not scheduled");
    line("Sent to", d.target);
    if (last) {
      line("Last run", when(last.startedAt, d.timezone) + " (" + rel(last.startedAt) + ")");
      if (!last.ok) line("What went wrong", last.error || "unknown", true);
    } else {
      line("Last run", "none yet. Each run is recorded here after it happens.");
    }

    var pre = $("digestText");
    pre.textContent = last && last.text ? last.text : "Nothing was sent.";
    var btn = $("digestToggle");
    btn.classList.toggle("hidden", !last);
    if (!last) pre.classList.add("hidden");

    var list = $("digestRuns"); clear(list);
    if (digestRuns.length > 1) {
      list.appendChild(el("div", "muted", "Earlier runs (newest first)"));
      digestRuns.slice(1, 6).forEach(function (r) {
        var row = el("div", "", "");
        row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:4px";
        row.appendChild(el("span", "chip " + (r.ok ? "ok" : "bad"), r.ok ? "OK" : "Failed"));
        row.appendChild(el("span", "muted", when(r.startedAt, d.timezone) + (r.ok ? "" : " - " + (r.error || ""))));
        list.appendChild(row);
      });
    }
  }
  function loadDigest() {
    api("/api/digest").then(renderDigest).catch(function () {});
  }
  $("digestToggle").onclick = function () {
    var pre = $("digestText");
    var hide = !pre.classList.contains("hidden");
    pre.classList.toggle("hidden", hide);
    $("digestToggle").textContent = hide ? "Show last message" : "Hide last message";
  };

  /* ---------- queue: filters, sorting, expandable cards ---------- */
  var SORTS = [
    ["queue", "Sort: review order"],
    ["score_desc", "Sort: score, high first"],
    ["score_asc", "Sort: score, low first"],
    ["num_desc", "Sort: newest PR first"],
    ["num_asc", "Sort: oldest PR first"],
    ["signals", "Sort: most signals"]
  ];
  var CONFS = [["all", "Any confidence"], ["high", "High confidence"], ["medium", "Medium confidence"], ["low", "Low confidence"]];
  var open = {};

  function newFilters() { return { q: "", states: {}, conf: "all", author: "all", sort: "queue", warn: false, hideDrafts: false }; }
  var f = newFilters();

  function saveFilters() { try { sessionStorage.setItem("filters", JSON.stringify(f)); } catch (e) {} }
  function loadFilters() {
    try {
      var sv = JSON.parse(sessionStorage.getItem("filters") || "null");
      if (!sv || typeof sv !== "object") return;
      var d = newFilters();
      if (typeof sv.q === "string") d.q = sv.q.slice(0, 100);
      if (typeof sv.author === "string") d.author = sv.author;
      if (CONFS.some(function (c) { return c[0] === sv.conf; })) d.conf = sv.conf;
      if (SORTS.some(function (s) { return s[0] === sv.sort; })) d.sort = sv.sort;
      d.warn = sv.warn === true; d.hideDrafts = sv.hideDrafts === true;
      if (sv.states && typeof sv.states === "object") Object.keys(sv.states).forEach(function (s) { if (STATES[s]) d.states[s] = true; });
      f = d;
    } catch (e) {}
  }

  function scoreTone(n) { return n >= 70 ? "" : n >= 40 ? "warn" : "bad"; }

  function fillSelect(sel, options, value) {
    clear(sel);
    options.forEach(function (o) {
      var op = el("option", "", o[1]); op.value = o[0]; sel.appendChild(op);
    });
    sel.value = value;
  }

  function filtersActive() {
    return f.q !== "" || Object.keys(f.states).length > 0 || f.conf !== "all" || f.author !== "all" || f.warn || f.hideDrafts || f.sort !== "queue";
  }

  function matches(it) {
    if (Object.keys(f.states).length && !f.states[it.state]) return false;
    if (f.hideDrafts && it.state === "draft") return false;
    if (f.conf !== "all" && it.confidence !== f.conf) return false;
    if (f.author !== "all" && it.author !== f.author) return false;
    if (f.warn && !(it.unknowns && it.unknowns.length)) return false;
    if (f.q) {
      var hay = ("#" + it.number + " " + it.title + " " + it.author).toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) === -1) return false;
    }
    return true;
  }

  function sortItems(list, all) {
    var out = list.slice();
    var byQueue = function (a, b) { return all.indexOf(a) - all.indexOf(b); };
    var cmp = {
      queue: byQueue,
      score_desc: function (a, b) { return b.score - a.score || byQueue(a, b); },
      score_asc: function (a, b) { return a.score - b.score || byQueue(a, b); },
      num_desc: function (a, b) { return b.number - a.number; },
      num_asc: function (a, b) { return a.number - b.number; },
      signals: function (a, b) { return b.signals.length - a.signals.length || byQueue(a, b); }
    }[f.sort] || byQueue;
    return out.sort(cmp);
  }

  /* Waterfall diagram: starts at 50, each signal moves the running total up (green) or down (red). */
  function scoreChart(it) {
    var box = el("div", "wf");
    box.appendChild(el("h4", "", "How the score adds up"));
    var rows = el("div", "wf-rows");
    var run = 50;
    var clamp = function (n) { return Math.max(0, Math.min(100, n)); };
    var row = function (iconName, label, from, to, valueText, cls) {
      var r = el("div", "wf-row " + cls);
      var lab = el("div", "wf-label"); lab.title = label;
      lab.appendChild(icon(iconName)); lab.appendChild(el("span", "", label));
      var track = el("div", "wf-track");
      var lo = clamp(Math.min(from, to)), hi = clamp(Math.max(from, to));
      var bar = el("i"); bar.style.left = lo + "%"; bar.style.width = Math.max(1.5, hi - lo) + "%";
      track.appendChild(bar);
      r.appendChild(lab); r.appendChild(track); r.appendChild(el("b", "wf-val", valueText));
      rows.appendChild(r);
    };
    row("layers", "Starting point", 0, 50, "50", "base");
    it.signals.slice().sort(function (a, b) { return b.weight - a.weight; }).forEach(function (s) {
      var next = run + s.weight;
      row(SIGNAL_ICON[s.code] || "dot", s.text, run, next, (s.weight > 0 ? "+" : "") + s.weight, s.weight >= 0 ? "pos" : "neg");
      run = next;
    });
    row("trend", "Priority score", 0, it.score, String(it.score), "total");
    box.appendChild(rows);
    var cap = "Confidence: " + it.confidence + ".";
    if (run !== it.score && clamp(Math.round(run)) === it.score) cap = "Total " + run + " is kept within 0-100. " + cap;
    box.appendChild(el("div", "calc", cap));
    return box;
  }

  /* Three rising bars, like a signal-strength icon. */
  function confidenceMeter(level) {
    var n = level === "high" ? 3 : level === "medium" ? 2 : 1;
    var w = el("span", "conf " + level);
    w.title = level + " confidence: " + (level === "high" ? "all inputs were available" : level === "medium" ? "some inputs are pending or missing" : "key data could not be fetched");
    for (var i = 1; i <= 3; i++) w.appendChild(el("i", i <= n ? "on" : ""));
    w.appendChild(el("span", "", level));
    return w;
  }

  function setOpen(card, body, chev, isOpen, number) {
    card.classList.toggle("open", isOpen);
    body.classList.toggle("hidden", !isOpen);
    chev.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isOpen) open[number] = true; else delete open[number];
    updateToggleAll();
  }

  function prCard(it, idx) {
    var st = STATES[it.state] || { label: it.state, cls: "" };
    var card = el("article", "pr" + (st.cls ? " t-" + st.cls : ""));

    var head = el("div", "pr-head");
    var chev = el("button", "chev"); chev.type = "button";
    chev.setAttribute("aria-label", "Show or hide details for pull request " + it.number);
    head.appendChild(chev);

    var main = el("div", "pr-main");
    var title = el("div", "pr-title");
    title.appendChild(el("span", "pr-num", "#" + it.number));
    title.appendChild(document.createTextNode(it.title));
    title.title = it.title;
    main.appendChild(title);
    var sub = el("div", "pr-sub");
    sub.appendChild(stateChip(it.state));
    var by = el("span", "muted by"); by.appendChild(icon("user")); by.appendChild(document.createTextNode(it.author));
    sub.appendChild(by);
    sub.appendChild(el("span", "muted", "#" + (idx + 1) + " in queue"));
    sub.appendChild(confidenceMeter(it.confidence));
    main.appendChild(sub);
    main.appendChild(el("div", "pr-line", it.recommendation));
    head.appendChild(main);

    var ring = el("div", "ring " + scoreTone(it.score));
    ring.style.setProperty("--p", String(it.score));
    ring.title = "Review priority " + it.score + " of 100. Higher is reviewed sooner; the queue is sorted by it.";
    ring.appendChild(el("b", "", String(it.score)));
    head.appendChild(ring);
    card.appendChild(head);

    var body = el("div", "pr-body hidden");
    body.appendChild(el("div", "reco", it.recommendation));

    body.appendChild(scoreChart(it));

    if (it.unknowns && it.unknowns.length) {
      var ul = el("ul", "unknowns");
      it.unknowns.forEach(function (u) { ul.appendChild(el("li", "", u)); });
      body.appendChild(ul);
    }

    var actions = el("div", "pr-actions");
    var href = safeUrl(it.sourceUrl);
    if (href) actions.appendChild(linkBtn(href, "github", "Open on GitHub"));
    var ask = iconBtn("small", "chat", "Ask the agent about this");
    ask.onclick = function () { $("text").value = "Why is #" + it.number + " ranked where it is, and what should happen next?"; send(); };
    actions.appendChild(ask);
    body.appendChild(actions);
    card.appendChild(body);

    var toggle = function () { setOpen(card, body, chev, body.classList.contains("hidden"), it.number); };
    head.onclick = function (e) {
      if (e.target && e.target.closest && e.target.closest("a")) return;
      toggle();
    };
    setOpen(card, body, chev, Boolean(open[it.number]), it.number);
    return card;
  }

  function updateToggleAll() {
    var cards = document.querySelectorAll("#queue .pr");
    var allOpen = cards.length > 0 && document.querySelectorAll("#queue .pr.open").length === cards.length;
    setBtn($("toggleAll"), allOpen ? "collapse" : "expand", allOpen ? "Collapse all" : "Expand all");
    $("toggleAll").disabled = cards.length === 0;
  }

  function renderChips(q) {
    var box = $("stateChips"); clear(box);
    var counts = {};
    q.items.forEach(function (it) { counts[it.state] = (counts[it.state] || 0) + 1; });
    var total = q.items.length;
    var any = Object.keys(f.states).length > 0;

    /* Clickable overview tiles: one per state, plus "All". They are the state filter. */
    var tile = function (cls, iconName, count, label, on, hint, onclick) {
      var t = el("button", "tile " + cls + (on ? " on" : ""));
      t.type = "button"; t.title = hint; t.setAttribute("aria-pressed", on ? "true" : "false");
      var ic = el("span", "tile-ic"); ic.appendChild(icon(iconName));
      var txt = el("span", "tile-txt");
      txt.appendChild(el("b", "", String(count)));
      txt.appendChild(el("span", "", label));
      t.appendChild(ic); t.appendChild(txt);
      t.onclick = onclick;
      return t;
    };
    box.appendChild(tile("", "layers", total, "All open", !any, "Show every open pull request", function () { f.states = {}; renderQueue(); }));
    STATE_ORDER.forEach(function (s) {
      if (!counts[s]) return;
      box.appendChild(tile(STATES[s].cls, STATES[s].icon, counts[s], STATES[s].label, Boolean(f.states[s]), STATES[s].hint, function () {
        if (f.states[s]) delete f.states[s]; else f.states[s] = true;
        renderQueue();
      }));
    });

    /* Proportion bar: how the open PRs split across states. */
    var stack = $("stack"); clear(stack);
    if (!total) { stack.classList.add("hidden"); return; }
    stack.classList.remove("hidden");
    STATE_ORDER.forEach(function (s) {
      if (!counts[s]) return;
      var seg = el("i", STATES[s].cls);
      seg.style.width = (counts[s] / total * 100) + "%";
      seg.title = STATES[s].label + ": " + counts[s] + " of " + total + " (" + Math.round(counts[s] / total * 100) + "%)";
      stack.appendChild(seg);
    });
  }

  function renderQueue() {
    var q = queueData; if (!q) return;
    var box = $("queue"); clear(box);

    var authors = [];
    q.items.forEach(function (it) { if (authors.indexOf(it.author) === -1) authors.push(it.author); });
    authors.sort();
    if (f.author !== "all" && authors.indexOf(f.author) === -1) f.author = "all";
    fillSelect($("fAuthor"), [["all", "Any author"]].concat(authors.map(function (a) { return [a, a]; })), f.author);
    fillSelect($("fConf"), CONFS, f.conf);
    fillSelect($("fSort"), SORTS, f.sort);
    $("fWarn").checked = f.warn; $("fHideDrafts").checked = f.hideDrafts;
    renderChips(q);

    updateQueueMeta();
    saveFilters();

    var shown = sortItems(q.items.filter(matches), q.items);
    $("resultCount").textContent = t("queue.showing", { shown: shown.length, total: q.items.length });
    $("clearFilters").classList.toggle("hidden", !filtersActive());

    if (!shown.length) {
      box.appendChild(q.items.length
        ? emptyState("search", t("queue.noMatch"))
        : emptyState("checkCircle", t("queue.empty"), "ok"));
    }
    var groups;
    if (youLogin) {
      var forYou = [], yours = [], others = [];
      shown.forEach(function (it) {
        var me = youLogin.toLowerCase();
        if (it.author && it.author.toLowerCase() === me) yours.push(it);
        else if ((it.state === "needs_review" || it.state === "unclear") && (it.requestedReviewers || []).some(function (r) { return String(r).toLowerCase() === me; })) forYou.push(it);
        else others.push(it);
      });
      groups = [
        { title: t("queue.forYou"), items: forYou },
        { title: t("queue.yours"), items: yours },
        { title: t("queue.others"), items: others }
      ];
    } else {
      groups = [{ title: "", items: shown }];
    }
    groups.forEach(function (g) {
      if (!g.items.length) return;
      if (g.title) box.appendChild(el("div", "q-sec", g.title));
      g.items.forEach(function (it) { box.appendChild(prCard(it, q.items.indexOf(it))); });
    });

    if (q.failed && q.failed.length) {
      var ul = el("ul", "unknowns");
      q.failed.forEach(function (x) { ul.appendChild(el("li", "", "Could not analyse #" + x.number + " " + x.title + ": " + x.error)); });
      box.appendChild(ul);
    }
    if (q.truncated) box.appendChild(el("div", "muted", "More open pull requests exist than are shown here."));
    updateToggleAll();
  }

  /* "updated 3 min ago", turning amber when the data is old enough to deserve a refresh. */
  var STALE_MS = 5 * 60 * 1000;      // show the "may be outdated" hint
  var RETURN_REFRESH_MS = 2 * 60 * 1000; // coming back to the tab refreshes data older than this
  var queueLoading = false;
  function updateQueueMeta() {
    var meta = $("queueMeta");
    if (!queueData) { meta.textContent = ""; meta.classList.remove("stale"); return; }
    var age = Date.now() - new Date(queueData.generatedAt).getTime();
    var old = age > STALE_MS;
    meta.textContent = queueData.repo + " - updated " + ago(queueData.generatedAt) + (old ? " - may be outdated" : "");
    meta.classList.toggle("stale", old);
    meta.title = old ? "This list is more than 5 minutes old. Press Refresh to load the latest." : "";
  }

  /* opts.quiet: refresh in the background without placeholders (used when you return to the tab).
     opts.announce: confirm with a message (used by the Refresh button, which also asks for fresh data). */
  function loadQueue(opts) {
    opts = opts === true ? { announce: true } : (opts || {});
    if (queueLoading) return;
    queueLoading = true;
    var box = $("queue");
    if (!opts.quiet) {
      clear(box);
      for (var i = 0; i < 3; i++) box.appendChild(el("div", "skeleton"));
    }
    $("refresh").disabled = true;
    api(opts.announce ? "/api/queue?refresh=1" : "/api/queue")
      .then(function (r) {
        queueData = r.queue; renderQueue();
        if (opts.announce) toast(r.cached ? t("queue.cached") : t("queue.refreshed", { count: r.queue.items.length }), "ok");
      })
      .catch(function (e) {
        if (opts.quiet) return; // keep showing the last good list; the amber hint says it is old
        clear(box); box.appendChild(emptyState("alert", t("queue.loadFail", { error: e.message }), "bad"));
      })
      .then(function () { queueLoading = false; $("refresh").disabled = false; });
  }

  /* Back on the tab after a while: quietly bring the list up to date. */
  function refreshIfStale() {
    if (!signedIn || document.hidden || !queueData) return;
    if (Date.now() - new Date(queueData.generatedAt).getTime() > RETURN_REFRESH_MS) loadQueue({ quiet: true });
  }
  document.addEventListener("visibilitychange", refreshIfStale);
  window.addEventListener("focus", refreshIfStale);

  /* ---------- theme ---------- */
  function currentTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    setBtn($("theme"), t === "dark" ? "sun" : "moon", t === "dark" ? "Light mode" : "Dark mode");
  }

  /* ---------- approvals ---------- */
  var ACTION_TONE = { pending: "warn", executed: "ok", rejected: "bad", failed: "bad", uncertain: "bad", executing: "info", expired: "", superseded: "" };
  var ACTION_LABEL_KEYS = { pending: "status.pending", executed: "status.executed", rejected: "status.rejected", failed: "status.failed", uncertain: "status.uncertain", executing: "status.executing", expired: "status.expired", superseded: "status.superseded" };
  var ACTION_ICON = { pending: "clock", executed: "checkCircle", rejected: "x", failed: "alert", uncertain: "help", executing: "refresh", expired: "clock", superseded: "refresh" };

  /* Three-step diagram of the approval life cycle: Requested -> Decision -> Posted. */
  function flowChart(status) {
    // Each step is "done", "now", "fail" or "todo".
    var s2 = { pending: "now", executing: "done", executed: "done", failed: "done", uncertain: "done", rejected: "fail", expired: "fail", superseded: "fail" }[status] || "todo";
    var s3 = { executing: "now", executed: "done", failed: "fail", uncertain: "fail" }[status] || "todo";
    var l2 = { pending: t("flow.awaiting"), rejected: t("flow.rejected"), expired: t("flow.expired"), superseded: t("flow.superseded") }[status] || t("flow.approved");
    var l3 = { executing: t("flow.posting"), executed: t("flow.posted"), failed: t("flow.notPosted"), uncertain: t("flow.unconfirmed") }[status] || t("flow.post");
    var steps = [["done", t("flow.requested")], [s2, l2], [s3, l3]];
    var box = el("ol", "flow");
    steps.forEach(function (st, i) {
      var li = el("li", "step " + st[0]);
      var dot = el("span", "dot");
      if (st[0] === "done") dot.appendChild(icon("check"));
      else if (st[0] === "fail") dot.appendChild(icon("x"));
      else if (st[0] === "now") dot.appendChild(icon(status === "executing" ? "refresh" : "clock"));
      li.appendChild(dot);
      li.appendChild(el("span", "lbl", st[1]));
      box.appendChild(li);
      if (i < steps.length - 1) box.appendChild(el("li", "link " + (steps[i + 1][0] === "todo" ? "" : "on"), ""));
    });
    return box;
  }

  var actionList = [];
  var actTab = null;
  var busy = 0;
  var actOpen = {};       // id -> true/false once the user toggled a card
  var actDraft = {};      // id -> text an approver is editing, kept if the list is redrawn
  var HISTORY_LIMIT = 5;  // older decided requests stay behind "Show more"
  var actShowAll = false;

  /* Requests that need a decision start open; decided ones start collapsed to save space. */
  function isActOpen(a) { return Object.prototype.hasOwnProperty.call(actOpen, a.id) ? actOpen[a.id] : a.status === "pending"; }

  function updateActsToggle() {
    var cards = document.querySelectorAll("#actions .act");
    var allOpen = cards.length > 0 && document.querySelectorAll("#actions .act.open").length === cards.length;
    setBtn($("toggleActs"), allOpen ? "collapse" : "expand", allOpen ? "Collapse all" : "Expand all");
    $("toggleActs").disabled = cards.length === 0;
  }

  function actionCard(a) {
    var tone = ACTION_TONE[a.status] || "";
    var card = el("div", "act" + (tone ? " t-" + tone : ""));

    /* Compact header (always visible): click it to show or hide the details below. */
    var head = el("div", "act-head");
    var chev = el("button", "chev"); chev.type = "button";
    chev.setAttribute("aria-label", "Show or hide details of the request for pull request " + a.prNumber);
    head.appendChild(chev);
    var badge = el("span", "chip " + tone);
    badge.appendChild(icon(ACTION_ICON[a.status] || "dot"));
    badge.appendChild(el("span", "", t(ACTION_LABEL_KEYS[a.status] || "") || a.status));
    head.appendChild(badge);
    var prHref = safeUrl(a.prUrl);
    var hmain = el("div", "act-main");
    hmain.appendChild(el("div", "act-title", "Comment on #" + a.prNumber + " " + a.prTitle));
    hmain.appendChild(el("div", "act-preview", a.body));
    head.appendChild(hmain);
    head.appendChild(el("span", "act-when", ago(a.createdAt)));
    card.appendChild(head);

    var box = el("div", "act-body");
    card.appendChild(box);
    if (prHref) {
      var prLink = linkBtn(prHref, "github", "#" + a.prNumber + " " + a.prTitle, "plain");
      prLink.title = "Open the pull request on GitHub";
      box.appendChild(prLink);
    }
    box.appendChild(flowChart(a.status));

    var meta = "Requested by " + a.requestedBy + " via " + a.requestedVia + " - " + ago(a.createdAt);
    if (a.status === "pending") meta += " - expires " + inFuture(a.expiresAt);
    else if (a.decidedBy && a.decidedAt) meta += " - decided by " + a.decidedBy + " " + ago(a.decidedAt);
    box.appendChild(el("div", "act-meta", meta));

    var quote = el("blockquote", "quote");
    var quoteLabel = el("small", "", a.status === "executed" ? (a.originalBody ? "Posted comment (edited by the approver)" : "Posted comment") : "Exact comment text");
    quote.appendChild(quoteLabel);
    var quoteText = document.createTextNode(a.body);
    quote.appendChild(quoteText);
    box.appendChild(quote);
    if (a.originalBody) {
      var origBox = el("details", "raw");
      origBox.appendChild(el("summary", "", "Show the original draft that was edited"));
      origBox.appendChild(el("pre", "", a.originalBody));
      box.appendChild(origBox);
    }

    if (/@(?:[A-Za-z0-9])/.test(a.body) && /(^|[^A-Za-z0-9_])@[A-Za-z0-9]/.test(a.body)) {
      box.appendChild(el("div", "note", t("approvals.mentions")));
    }
    if (a.reason) {
      var why = el("div", "why");
      why.appendChild(el("b", "", t("approvals.why")));
      why.appendChild(document.createTextNode(a.reason));
      box.appendChild(why);
    }
    if (actorId && a.requestedBy === actorId) box.appendChild(el("div", "muted", t("approvals.youAsked")));

    var foot = el("div", "row");
    foot.style.marginTop = "0";

    if (a.status === "pending" && role === "approver") {
      var ok = iconBtn("primary", "check", t("approvals.approve"));
      var edit = iconBtn("ghost", "draft", t("approvals.edit"));
      edit.title = t("approvals.editTitle");
      var no = iconBtn("danger", "x", t("approvals.reject"));
      var cancel = iconBtn("ghost small hidden", "x", t("approvals.cancel"));
      var armed = false, armedKind = null, editor = null;
      var okLabel = function () { return editor ? t("approvals.approveEdited") : t("approvals.approve"); };
      var startEdit = function (text) {
        editor = document.createElement("textarea");
        editor.value = text; editor.rows = 5; editor.maxLength = 2000;
        editor.setAttribute("aria-label", t("approvals.editAria"));
        editor.oninput = function () { actDraft[a.id] = editor.value; };
        quote.replaceChild(editor, quoteText);
        quoteLabel.textContent = t("approvals.editing");
        actDraft[a.id] = text;
        setBtn(edit, "refresh", t("approvals.undo")); setBtn(ok, "check", okLabel());
      };
      var stopEdit = function () {
        if (!editor) return;
        quote.replaceChild(quoteText, editor); editor = null; delete actDraft[a.id];
        quoteLabel.textContent = t("approvals.exact");
        setBtn(edit, "draft", t("approvals.edit")); setBtn(ok, "check", okLabel());
      };
      var disarm = function () {
        armed = false; armedKind = null; cancel.classList.add("hidden");
        if (editor) editor.readOnly = false;
        ok.className = "primary"; setBtn(ok, "check", okLabel()); ok.classList.remove("hidden");
        no.className = "danger"; setBtn(no, "x", t("approvals.reject")); no.classList.remove("hidden");
        edit.classList.remove("hidden");
      };
      var decide = function (kind) {
        var payload = kind === "approve" && editor ? JSON.stringify({ body: editor.value }) : "{}";
        busy++; ok.disabled = true; no.disabled = true; edit.disabled = true; cancel.classList.add("hidden");
        setBtn(kind === "approve" ? ok : no, "refresh", t("approvals.working"));
        api("/api/actions/" + encodeURIComponent(a.id) + "/" + kind, { method: "POST", body: payload })
          .then(function (r) { toast(r.text, r.ok === false ? "bad" : "ok"); if (r.ok !== false) delete actDraft[a.id]; })
          .catch(function (e) { toast(e.message, "bad"); })
          .then(function () { busy--; loadActions(); });
      };
      ok.onclick = function () {
        if (!armed) {
          if (editor && !editor.value.trim()) { toast(t("approvals.emptyEdit"), "bad"); return; }
          // Posting is public and cannot be undone: stay armed until they confirm or Cancel.
          armed = true; armedKind = "approve"; if (editor) editor.readOnly = true;
          ok.className = "confirm"; setBtn(ok, "check", t("approvals.confirm"));
          no.classList.add("hidden"); edit.classList.add("hidden"); cancel.classList.remove("hidden");
          return;
        }
        if (armedKind === "approve") decide("approve");
      };
      edit.onclick = function () { if (editor) stopEdit(); else { startEdit(a.body); editor.focus(); } };
      no.onclick = function () {
        if (!armed) {
          armed = true; armedKind = "reject";
          no.className = "confirm danger"; setBtn(no, "x", t("approvals.confirmReject"));
          ok.classList.add("hidden"); edit.classList.add("hidden"); cancel.classList.remove("hidden");
          return;
        }
        if (armedKind === "reject") decide("reject");
      };
      cancel.onclick = disarm;
      foot.appendChild(ok); foot.appendChild(edit); foot.appendChild(no); foot.appendChild(cancel);
      if (Object.prototype.hasOwnProperty.call(actDraft, a.id)) startEdit(actDraft[a.id]);
    } else if (a.status === "pending") {
      foot.appendChild(el("span", "muted", t("approvals.waitApprover")));
    } else if (a.status === "executed") {
      var done = safeUrl(a.resultUrl) || prHref;
      if (done) foot.appendChild(linkBtn(done, "external", a.resultUrl ? "View comment on GitHub" : "Open pull request", "ok"));
    } else if (a.status === "failed" || a.status === "uncertain") {
      if (prHref) foot.appendChild(linkBtn(prHref, "github", "Open pull request", "accent"));
    }
    if (foot.childNodes.length) box.appendChild(foot);

    if ((a.status === "failed" || a.status === "uncertain") && a.error) box.appendChild(el("div", "note", a.error));

    var raw = el("details", "raw");
    raw.appendChild(el("summary", "", "Show full approval card (#" + a.id.slice(0, 8) + ")"));
    raw.appendChild(el("pre", "", a.card));
    box.appendChild(raw);

    var setOpenAct = function (isOpen) {
      card.classList.toggle("open", isOpen);
      box.classList.toggle("hidden", !isOpen);
      chev.setAttribute("aria-expanded", isOpen ? "true" : "false");
    };
    setOpenAct(isActOpen(a));
    head.onclick = function () {
      var next = box.classList.contains("hidden");
      actOpen[a.id] = next;
      setOpenAct(next);
      updateActsToggle();
    };
    return card;
  }

  function renderActions() {
    var box = $("actions"); clear(box);
    var tabs = $("actTabs"); clear(tabs);
    var pending = actionList.filter(function (a) { return a.status === "pending"; });
    var pc = $("pendingCount");
    pc.textContent = pending.length + " pending"; pc.classList.toggle("hidden", !pending.length);
    document.title = (pending.length ? "(" + pending.length + ") " : "") + "PR Triage Agent";

    if (actTab === null) actTab = pending.length ? "pending" : "all";
    [["pending", "Pending " + pending.length], ["all", "History " + actionList.length]].forEach(function (t) {
      var b = el("button", actTab === t[0] ? "on" : "", t[1]);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", actTab === t[0] ? "true" : "false");
      b.onclick = function () { actTab = t[0]; renderActions(); };
      tabs.appendChild(b);
    });

    var shown = actTab === "pending" ? pending : actionList;
    if (!shown.length) {
      box.appendChild(actTab === "pending"
        ? emptyState("shield", t("approvals.emptyPending"), "ok")
        : emptyState("inbox", t("approvals.emptyAll")));
      return;
    }
    var limited = actTab === "all" && !actShowAll && shown.length > HISTORY_LIMIT;
    (limited ? shown.slice(0, HISTORY_LIMIT) : shown).forEach(function (a) { box.appendChild(actionCard(a)); });
    if (limited) {
      var more = el("button", "small more", "Show " + (shown.length - HISTORY_LIMIT) + " older");
      more.type = "button";
      more.onclick = function () { actShowAll = true; renderActions(); };
      box.appendChild(more);
    } else if (actTab === "all" && actShowAll && shown.length > HISTORY_LIMIT) {
      var less = el("button", "small ghost more", "Show fewer");
      less.type = "button";
      less.onclick = function () { actShowAll = false; renderActions(); };
      box.appendChild(less);
    }
    updateActsToggle();
  }

  function loadActions() {
    return api("/api/actions").then(function (r) {
      actionList = r.actions; renderActions();
    }).catch(function (e) { var b = $("actions"); clear(b); b.appendChild(emptyState("alert", e.message, "bad")); });
  }

  /* Keep approvals and the "updated ... ago" label fresh without extra GitHub calls. */
  setInterval(function () {
    if (!signedIn || document.hidden) return;
    updateQueueMeta();
    loadDigest(); /* local database only, no GitHub call */
    refreshIfStale();
    if (!busy && !document.querySelector("#actions button.confirm") && !document.querySelector("#actions textarea")) loadActions();
  }, 30000);

  /* ---------- session ---------- */
  function signOut(endSession) {
    /* Logout asks the server to end the session, so a copied cookie stops working too. */
    if (endSession) { try { fetch("/api/logout", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "pr-triage" } }); } catch (e) {} }
    signedIn = false; $("key").value = ""; queueData = null; f = newFilters(); open = {}; $("search").value = ""; actionList = []; actTab = null; actOpen = {}; actDraft = {}; actShowAll = false;
    $("digestPanel").classList.add("hidden"); digestRuns = [];
    try { sessionStorage.removeItem("filters"); } catch (e) {}
    document.title = "PR Triage Agent";
    $("main").classList.add("hidden"); $("userbar").classList.add("hidden"); $("login").classList.remove("hidden");
    $("fab").classList.add("hidden"); $("fabDot").classList.add("hidden");
    $("guideModal").classList.add("hidden");
    if (chatIsOpen()) closeChat();
    renderChatEmpty();
    $("repo").textContent = "";
  }

  function signIn() {
    return api("/api/me").then(function (me) {
      role = me.role; signedIn = true;
      meName = me.name || "";
      youLogin = me.githubLogin || "";
      actorId = me.name && me.name.indexOf("shared") !== 0 ? "web:" + me.name : (role === "approver" ? "web:approver" : "web:reader");
      $("login").classList.add("hidden"); $("main").classList.remove("hidden"); $("userbar").classList.remove("hidden");
      $("fab").classList.remove("hidden");
      $("repo").textContent = me.repo;
      repoSlug = me.repo;
      var who = $("who");
      who.textContent = (role === "approver" ? t("who.approver") : t("who.reader")) + (me.name && me.name.indexOf("shared") !== 0 ? " - " + me.name : "");
      who.className = "chip " + (role === "approver" ? "ok" : "");
      loadQueue(); loadActions(); loadBudget(); loadGuide(); loadDigest();
    });
  }

  $("loginBtn").onclick = function () {
    var typed = $("key").value.trim(); $("loginMsg").textContent = "";
    if (!typed) { $("loginMsg").textContent = t("login.enterKey"); return; }
    api("/api/login", { method: "POST", body: JSON.stringify({ key: typed }) })
      .then(function () { $("key").value = ""; $("key").type = "password"; setBtn($("showKey"), "eye", t("key.show")); return signIn(); })
      .catch(function (e) { $("loginMsg").textContent = e.message; });
  };
  $("key").addEventListener("keydown", function (e) { if (e.key === "Enter") $("loginBtn").click(); });
  $("logout").onclick = function () { signOut(true); };
  $("send").onclick = send;
  $("fab").onclick = function () { if (chatIsOpen()) closeChat(); else openChat(); };
  $("closeChat").onclick = closeChat;
  $("backdrop").onclick = closeChat;
  $("newChat").onclick = newChat;
  renderPromptBank();
  $("morePrompts").onclick = function () {
    $("promptBank").classList.toggle("hidden");
    $("morePrompts").textContent = $("promptBank").classList.contains("hidden") ? "More prompts" : "Hide prompts";
  };
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (guideIsOpen()) closeGuide(); else if (chatIsOpen()) closeChat();
  });
  renderChatEmpty();
  $("text").addEventListener("input", updateTextCount);
  $("text").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault(); send();
  });
  updateTextCount();
  $("refresh").onclick = function () { loadQueue(true); };
  $("toggleActs").onclick = function () {
    var cards = document.querySelectorAll("#actions .act");
    var allOpen = cards.length > 0 && document.querySelectorAll("#actions .act.open").length === cards.length;
    var shown = actTab === "pending" ? actionList.filter(function (a) { return a.status === "pending"; }) : actionList;
    shown.forEach(function (a) { actOpen[a.id] = !allOpen; });
    renderActions();
  };
  $("refreshActions").onclick = function () { loadActions().then(function () { toast(t("approvals.reloaded")); }); };

  function paintChrome() {
    applyStates();
    SORTS = [
      ["queue", t("sort.queue")],
      ["score_desc", t("sort.score_desc")],
      ["score_asc", t("sort.score_asc")],
      ["num_desc", t("sort.num_desc")],
      ["num_asc", t("sort.num_asc")],
      ["signals", t("sort.signals")]
    ];
    CONFS = [["all", t("conf.all")], ["high", t("conf.high")], ["medium", t("conf.medium")], ["low", t("conf.low")]];
    SUGGESTIONS = [t("suggest.0"), t("suggest.1"), t("suggest.2"), t("suggest.3")];
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (n) {
      n.textContent = t(n.getAttribute("data-i18n"));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-placeholder]"), function (n) {
      n.setAttribute("placeholder", t(n.getAttribute("data-i18n-placeholder")));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-title]"), function (n) {
      n.setAttribute("title", t(n.getAttribute("data-i18n-title")));
    });
    setBtn($("refresh"), "refresh", t("queue.refresh"));
    setBtn($("refreshActions"), "refresh", t("approvals.reload"));
    setBtn($("logout"), "logout", t("logout"));
    setBtn($("guideBtn"), "help", t("guide.btn"));
    setBtn($("guideClose"), "x", t("guide.close"));
    setBtn($("send"), "send", t("chat.send"));
    setBtn($("newChat"), "plus", t("chat.new"));
    setBtn($("closeChat"), "x", t("chat.close"));
    setBtn($("clearFilters"), "clear", t("queue.clear"));
    $("loginBtn").textContent = t("login.signIn");
    $("theme").setAttribute("title", t("theme.title"));
    $("guideBtn").setAttribute("title", t("guide.btnTitle"));
    $("search").setAttribute("placeholder", t("queue.search"));
    $("search").setAttribute("aria-label", t("queue.searchAria"));
    $("drawer").setAttribute("aria-label", t("chat.ask"));
    $("stateChips").setAttribute("aria-label", t("queue.statesAria"));
    $("stack").setAttribute("aria-label", t("queue.stackAria"));
    applyTheme(currentTheme());
    if (signedIn && role) {
      $("who").textContent = (role === "approver" ? t("who.approver") : t("who.reader")) + (meName && meName.indexOf("shared") !== 0 ? " - " + meName : "");
    }
  }
  function applyStates() {
    STATES.needs_review.label = t("state.needs_review"); STATES.needs_review.hint = t("state.needs_review.hint");
    STATES.ready_to_merge.label = t("state.ready_to_merge"); STATES.ready_to_merge.hint = t("state.ready_to_merge.hint");
    STATES.waiting_on_author.label = t("state.waiting_on_author"); STATES.waiting_on_author.hint = t("state.waiting_on_author.hint");
    STATES.draft.label = t("state.draft"); STATES.draft.hint = t("state.draft.hint");
    STATES.unclear.label = t("state.unclear"); STATES.unclear.hint = t("state.unclear.hint");
  }
  function applyLang() {
    paintChrome();
    if (queueData) renderQueue();
    if (signedIn) renderActions();
    if (!$("chat").querySelector(".bubble")) renderChatEmpty();
    renderSuggestions();
  }
  $("guideBtn").onclick = openGuide;
  $("guideClose").onclick = closeGuide;
  /* Click on the dark area (not the card) closes it; Tab stays on the Close button, the only control inside. */
  $("guideModal").addEventListener("click", function (e) { if (e.target === $("guideModal")) closeGuide(); });
  $("guideModal").addEventListener("keydown", function (e) { if (e.key === "Tab") { e.preventDefault(); $("guideClose").focus(); } });
  setBtn($("showKey"), "eye", t("key.show"));
  var fabSvg = $("fab").querySelector("svg"); if (fabSvg) $("fab").replaceChild(icon("chat"), fabSvg);
  $("showKey").onclick = function () {
    var shown = $("key").type === "text";
    $("key").type = shown ? "password" : "text";
    setBtn($("showKey"), "eye", shown ? t("key.show") : t("key.hide"));
  };

  /* Keyboard: "/" jumps to the search box, like most developer tools. */
  document.addEventListener("keydown", function (e) {
    var tag = e.target && e.target.tagName;
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if ($("main").classList.contains("hidden")) return;
    e.preventDefault(); $("search").focus();
  });

  /* Static icons declared in the HTML with data-icon="name". */
  Array.prototype.forEach.call(document.querySelectorAll("[data-icon]"), function (n) {
    n.insertBefore(icon(n.getAttribute("data-icon")), n.firstChild);
  });
  loadFilters(); $("search").value = f.q;

  $("search").addEventListener("input", function (e) { f.q = e.target.value.trim(); renderQueue(); });
  $("fConf").onchange = function (e) { f.conf = e.target.value; renderQueue(); };
  $("fAuthor").onchange = function (e) { f.author = e.target.value; renderQueue(); };
  $("fSort").onchange = function (e) { f.sort = e.target.value; renderQueue(); };
  $("fWarn").onchange = function (e) { f.warn = e.target.checked; renderQueue(); };
  $("fHideDrafts").onchange = function (e) { f.hideDrafts = e.target.checked; renderQueue(); };
  $("clearFilters").onclick = function () { f = newFilters(); $("search").value = ""; renderQueue(); };
  $("toggleAll").onclick = function () {
    var cards = document.querySelectorAll("#queue .pr");
    var allOpen = cards.length > 0 && document.querySelectorAll("#queue .pr.open").length === cards.length;
    if (allOpen) open = {};
    else if (queueData) queueData.items.forEach(function (it) { open[it.number] = true; });
    renderQueue();
  };

  var savedTheme = null;
  try { savedTheme = localStorage.getItem("theme"); } catch (e) {}
  applyTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : currentTheme());
  $("theme").onclick = function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("theme", next); } catch (e) {}
  };
  applyLang();
  /* Already signed in (valid session cookie)? Go straight to the app; otherwise this just shows the login box. */
  signIn().catch(function () {});
})();
`;
