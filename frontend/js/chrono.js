// Chrono-rail: the persistent time spine. Time is a first-class dimension — one shared cursor drives
// the map, the imagery, the trajectory instrument and the construction stage.
import { S, on, emit } from "./store.js";
import { $, ms, fmtMs, fmtMon, clamp, stageAt, DAY, tween, ease } from "./util.js";

let W = 0, H = 70, playing = null;
const L = 14, R = 18;

export function initChrono() {
  const root = $("#chrono");
  root.innerHTML = `
    <div class="cr-left">
      <button class="cr-play" id="cr-play" title="Play history (Space)"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg></button>
      <div class="cr-date"><b id="cr-date" class="mono">—</b><span class="stg" id="cr-stg">AOI HISTORY</span></div>
    </div>
    <div class="cr-track" id="cr-track">
      <div class="cr-lbl">CHRONO-RAIL · <b>SHARED TIME CURSOR</b> · drag to scrub the archive</div>
      <svg id="cr-svg"></svg>
    </div>`;
  const track = $("#cr-track");
  const ro = new ResizeObserver(() => { W = track.clientWidth; H = track.clientHeight; draw(); });
  ro.observe(track);
  let drag = false;
  const setFromEvent = (e) => {
    const r = track.getBoundingClientRect();
    const t = S.t0 + ((e.clientX - r.left - L) / (r.width - L - R)) * (S.t1 - S.t0);
    setCursor(clamp(t, S.t0, S.t1), "rail");
  };
  track.addEventListener("pointerdown", (e) => { stopPlay(); drag = true; track.setPointerCapture(e.pointerId); setFromEvent(e); });
  track.addEventListener("pointermove", (e) => { if (drag) setFromEvent(e); });
  track.addEventListener("pointerup", () => (drag = false));
  $("#cr-play").addEventListener("click", () => (playing ? stopPlay() : play()));
  on("cursor", () => { drawCursor(); updateText(); });
  on("markers", draw);
  on("view", draw);
  updateText();
}

export function setCursor(t, source = "") {
  S.cursor = clamp(t, S.t0, S.t1);
  emit("cursor", { t: S.cursor, source });
}

export function play(from = null, dur = 7000, onDone, to = null) {
  stopPlay();
  const b = to ?? S.t1;
  const a = from ?? (S.cursor >= b - DAY * 3 ? S.t0 : S.cursor);
  const svg = $("#cr-play svg path");
  svg.setAttribute("d", "M3 2.5h3.5v11H3zM9.5 2.5H13v11H9.5z");
  const token = {};
  playing = token;
  tween(Math.max(600, (b - a) / (S.t1 - S.t0) * dur), (t) => { if (playing === token) setCursor(a + (b - a) * t, "play"); }, ease.lin).then(() => { if (playing === token) stopPlay(); onDone && onDone(); });
}
export function stopPlay() {
  playing = null;
  const p = $("#cr-play svg path");
  if (p) p.setAttribute("d", "M4 2.5v11l9-5.5z");
}
export const isPlaying = () => !!playing;

const xOf = (t) => L + ((t - S.t0) / (S.t1 - S.t0)) * (W - L - R);

function draw() {
  if (!W || !S.aoi) return;
  const svg = $("#cr-svg");
  const base = 46;
  let o = "";
  // month ticks
  const d0 = new Date(S.t0);
  let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
  for (let k = 0; k < 30; k++) {
    const t = Date.UTC(y, m, 1);
    if (t > S.t1) break;
    if (t >= S.t0) {
      const x = xOf(t);
      const q = m % 3 === 0;
      o += `<line x1="${x}" x2="${x}" y1="${base}" y2="${base + (q ? 7 : 3)}" stroke="rgba(150,172,196,${q ? 0.5 : 0.25})"/>`;
      if (q) o += `<text x="${x + 3}" y="${H - 5}" fill="#66768a" font-size="9" font-family="JetBrains Mono">${fmtMon(t)}</text>`;
    }
    m++; if (m > 11) { m = 0; y++; }
  }
  o += `<line x1="${L}" x2="${W - R}" y1="${base}" y2="${base}" stroke="rgba(150,172,196,.35)"/>`;
  // acquisition cadence
  for (const d of S.aoi.time.s2_dates) o += `<circle cx="${xOf(ms(d))}" cy="${base + 8}" r="1.5" fill="#3fd0e8" opacity=".7"/>`;
  for (const d of S.aoi.time.s1_dates) o += `<circle cx="${xOf(ms(d))}" cy="${base + 13}" r="1.5" fill="#a98bff" opacity=".7"/>`;
  // event onsets
  const res = new Set((S.query?.results || []).map((r) => r.id));
  const focus = S.dossier?.id || S.selectedId;
  const evs = [...S.events].sort((a, b) => a.confidence.score - b.confidence.score);
  for (const e of evs) {
    const x = xOf(ms(e.onset.estimate));
    const h = 9 + e.confidence.score * 20;
    const hi = res.has(e.id), sel = e.id === focus;
    const col = sel ? "#ffffff" : hi ? "#ffb020" : "#66768a";
    const op = sel ? 1 : hi ? 0.95 : res.size ? 0.28 : 0.6;
    o += `<line x1="${x}" x2="${x}" y1="${base}" y2="${base - h}" stroke="${col}" stroke-width="${sel ? 2.4 : 1.6}" opacity="${op}"/>`;
    if (sel || hi) o += `<circle cx="${x}" cy="${base - h}" r="${sel ? 3 : 2.2}" fill="${col}"/>`;
  }
  if (S.view === "dossier" && S.dossier?.window) {
    const [a, b] = S.dossier.window;
    o += `<rect x="${xOf(a)}" y="${base - 34}" width="${Math.max(4, xOf(b) - xOf(a))}" height="34" fill="rgba(255,176,32,.18)" stroke="rgba(255,176,32,.6)" stroke-dasharray="2 2"/>`;
  }
  o += `<g id="cr-cur"></g>`;
  svg.innerHTML = o;
  drawCursor();
}

function drawCursor() {
  const g = $("#cr-cur");
  if (!g) return;
  const x = xOf(S.cursor);
  g.innerHTML = `<line x1="${x}" x2="${x}" y1="12" y2="${H - 14}" stroke="#dde5ee" stroke-width="1.2"/>
    <path d="M${x - 6} 12h12l-6 8z" fill="#dde5ee"/>`;
}

function updateText() {
  $("#cr-date").textContent = fmtMs(S.cursor);
  const stg = $("#cr-stg");
  if (S.view === "dossier" && S.dossier?.seq) stg.textContent = (stageAt(S.dossier.seq, S.cursor) || "").toUpperCase() + " · " + S.dossier.id;
  else {
    const n = S.events.filter((e) => ms(e.onset.first_supporting) <= S.cursor).length;
    stg.textContent = `${n} OF ${S.events.length} CHANGE EVENTS UNDER WAY`;
  }
}
export const redrawChrono = () => { draw(); updateText(); };
