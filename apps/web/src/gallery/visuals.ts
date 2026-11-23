// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Visuals for the sample, written as a bot is told to write them: one
 * self-contained page each, drawn with the theme's variables, nothing from
 * the network. Development only.
 */
import type { Visual } from "@j3-bots/contracts";

const chartPage = `<!doctype html>
<style>
  h1 { margin: 0 0 4px; font-size: 14px; font-weight: 600 }
  p { margin: 0 0 12px; font-size: 12px; color: var(--muted-foreground) }
  svg { display: block; width: 100%; height: auto; overflow: visible }
  .grid { stroke: var(--border) }
  .axis { fill: var(--muted-foreground); font: 11px var(--font-sans) }
  .value { fill: var(--foreground); font: 600 11px var(--font-sans) }
  rect { fill: var(--chart-1) }
  rect.peak { fill: var(--chart-2) }
</style>
<h1>Household spending, 2026</h1>
<p>Monthly total, in euros</p>
<svg id="chart" viewBox="0 0 360 170" role="img" aria-label="Spending by month, March highest"></svg>
<script>
  const months = [["Jan", 1840], ["Feb", 1620], ["Mar", 2410], ["Apr", 1930], ["May", 1760], ["Jun", 1880]];
  const svg = document.getElementById("chart");
  const ns = "http://www.w3.org/2000/svg";
  const max = 2500, height = 140, width = 360, gap = 14;
  const bar = (width - gap * (months.length + 1)) / months.length;
  const add = (name, attributes, text) => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
  };
  for (const step of [0, 1000, 2000]) {
    const y = height - (step / max) * height;
    add("line", { class: "grid", x1: 0, x2: width, y1: y, y2: y });
  }
  months.forEach(([month, total], index) => {
    const x = gap + index * (bar + gap);
    const h = (total / max) * height;
    add("rect", { x, y: height - h, width: bar, height: h, rx: 4, class: total === 2410 ? "peak" : "" });
    add("text", { class: "value", x: x + bar / 2, y: height - h - 5, "text-anchor": "middle" }, total.toLocaleString("en"));
    add("text", { class: "axis", x: x + bar / 2, y: height + 16, "text-anchor": "middle" }, month);
  });
</script>`;

const tablePage = `<!doctype html>
<style>
  table { width: 100%; border-collapse: collapse; font-size: 13px }
  th { text-align: start; font-weight: 600; color: var(--muted-foreground); font-size: 12px }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--border) }
  tr:last-child td { border-bottom: 0 }
  td.number { text-align: end; font-variant-numeric: tabular-nums }
  .best { color: var(--success); font-weight: 600 }
  caption { caption-side: bottom; padding-top: 10px; font-size: 12px; color: var(--muted-foreground); text-align: start }
</style>
<table>
  <thead><tr><th>Model</th><th>Motor</th><th class="number">Range</th><th class="number">Price</th></tr></thead>
  <tbody>
    <tr><td>Torra C2</td><td>Mid-drive, 85 Nm</td><td class="number best">78 km</td><td class="number">€3,450</td></tr>
    <tr><td>Velomo Trek</td><td>Mid-drive, 75 Nm</td><td class="number">64 km</td><td class="number">€2,980</td></tr>
    <tr><td>Aro City S</td><td>Mid-drive, 65 Nm</td><td class="number">41 km</td><td class="number best">€2,390</td></tr>
  </tbody>
  <caption>Range as owners report it, with a 625 Wh battery.</caption>
</table>`;

const diagramPage = `<!doctype html>
<style>
  svg { display: block; width: 100%; height: auto }
  rect { fill: var(--muted); stroke: var(--border) }
  rect.done { fill: var(--success); stroke: none }
  rect.next { fill: var(--accent); stroke: none }
  text { fill: var(--foreground); font: 12px var(--font-sans) }
  text.on { fill: var(--accent-foreground); font-weight: 600 }
  path { stroke: var(--muted-foreground); stroke-width: 1.5; fill: none; marker-end: url(#arrow) }
  #arrow path { fill: var(--muted-foreground); stroke: none }
</style>
<svg viewBox="0 0 380 150" role="img" aria-label="The staging migration: backup, check, migrate, verify, then production">
  <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" /></marker></defs>
  <rect class="done" x="4" y="20" width="104" height="36" rx="8" /><text class="on" x="56" y="42" text-anchor="middle">Backup</text>
  <rect class="done" x="138" y="20" width="104" height="36" rx="8" /><text class="on" x="190" y="42" text-anchor="middle">Check</text>
  <rect class="next" x="272" y="20" width="104" height="36" rx="8" /><text class="on" x="324" y="42" text-anchor="middle">Migrate</text>
  <rect x="272" y="96" width="104" height="36" rx="8" /><text x="324" y="118" text-anchor="middle">Verify</text>
  <rect x="138" y="96" width="104" height="36" rx="8" /><text x="190" y="118" text-anchor="middle">Production</text>
  <path d="M108 38H136" /><path d="M242 38H270" /><path d="M324 56V94" /><path d="M272 114H244" />
</svg>`;

/**
 * A page that tries every way out of its frame and lists what each attempt
 * got: the client's cookies and storage, its API, the window around it, a
 * popup, the network, a peer connection, a frame of its own, and messages
 * the client could mistake for its own.
 * Leave takes the frame itself elsewhere, by script and by a refresh; Hang
 * runs a script that never ends, which the app around it outlasts.
 */
const escapePage = `<!doctype html>
<style>
  ol { margin: 0; padding-inline-start: 20px; font-size: 13px }
  li { margin: 2px 0 }
  code { font-size: 12px }
  button { margin-top: 10px; font: inherit; font-size: 13px }
</style>
<ol id="results"></ol>
<button id="leave" type="button">Leave</button>
<button id="hang" type="button">Hang</button>
<img id="pixel" alt="" width="1" height="1">
<script>
  const list = document.getElementById("results");
  const show = (attempt, outcome) => {
    const item = document.createElement("li");
    item.innerHTML = "<code></code>: <span></span>";
    item.firstChild.textContent = attempt;
    item.lastChild.textContent = outcome;
    item.dataset.attempt = attempt;
    list.append(item);
  };
  const tried = (attempt, run) => {
    try { show(attempt, run()); } catch (error) { show(attempt, "refused, " + error.name); }
  };
  tried("document.cookie", () => "read " + JSON.stringify(document.cookie));
  tried("localStorage", () => "read " + JSON.stringify(Object.keys(localStorage)));
  tried("sessionStorage", () => "read " + JSON.stringify(Object.keys(sessionStorage)));
  tried("indexedDB", () => { indexedDB.open("j3"); return "opened"; });
  tried("top.location", () => { top.location.href = "https://example.com/j3-visual/top"; return "navigated"; });
  tried("window.open", () => window.open("https://example.com/j3-visual/popup") === null ? "refused, no window" : "opened");
  tried("parent.document", () => "read " + parent.document.title);
  tried("RTCPeerConnection", () => {
    new RTCPeerConnection({ iceServers: [{ urls: "stun:example.com:3478" }] }).createDataChannel("out");
    return "opened";
  });
  tried("nested frame", () => {
    const nested = document.createElement("iframe");
    nested.srcdoc = "<p>A realm of its own</p>";
    document.body.append(nested);
    setTimeout(() => show("nested frame, a moment later", nested.isConnected ? "kept" : "removed"));
    return "added";
  });
  tried("postMessage, spoofed", () => {
    parent.postMessage({ type: "j3-visual-height", height: "9999" }, "*");
    parent.postMessage({ type: "j3-visual-open", url: "https://example.com/j3-visual/open" }, "*");
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 9999 } }, "*");
    for (let index = 0; index < parent.frames.length; index++) {
      parent.frames[index].postMessage({ type: "j3-visual-height", height: 1999 }, "*");
    }
    return "sent; the app's frames keep their heights";
  });
  fetch("/api/server", { credentials: "include" }).then(
    (response) => show("fetch J3 API", "answered " + response.status),
    (error) => show("fetch J3 API", "refused, " + error.name),
  );
  fetch("https://example.com/j3-visual/fetch").then(
    () => show("fetch remote", "answered"),
    (error) => show("fetch remote", "refused, " + error.name),
  );
  const pixel = document.getElementById("pixel");
  pixel.onload = () => show("remote image", "loaded");
  pixel.onerror = () => show("remote image", "refused");
  pixel.src = "https://example.com/j3-visual/pixel.png";
  const form = document.createElement("form");
  form.action = "https://example.com/j3-visual/form";
  form.method = "get";
  document.body.append(form);
  tried("form submit", () => { form.submit(); return "submitted"; });
  document.getElementById("leave").onclick = () => {
    document.head.insertAdjacentHTML("beforeend", '<meta http-equiv="refresh" content="0;url=https://example.com/j3-visual/refresh">');
    location.href = "https://example.com/j3-visual/leave";
  };
  document.getElementById("hang").onclick = () => {
    for (;;) {}
  };
</script>`;

export const sampleVisuals = {
  chart: { title: "Household spending by month", html: chartPage, height: 250 },
  table: { title: "Three e-bikes for a hilly commute", html: tablePage, height: 210 },
  diagram: { title: "Staging migration plan", html: diagramPage, height: 180 },
  escape: { title: "A page that tries to get out", html: escapePage, height: 420 },
} satisfies Record<string, Visual>;
