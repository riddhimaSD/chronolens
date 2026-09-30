// The temporal instrument: normal seasonal behaviour → persistent deviation → change point → new state.
// Two evidence panels (Sentinel-2 / Sentinel-1) and an agreement lane share one time axis and one cursor.
import { S } from "./store.js";
import { setCursor, stopPlay } from "./chrono.js";
import { $, ms, fmtDate, fmtMon, fmtMs, esc, clamp, DAY, tween, ease } from "./util.js";

const COL = { s2: "#3fd0e8", s1: "#a98bff" };
const RIB = ["#22392b", "#5a3e16", "#3a414c", "#4a5564", "#1f4f47"];
const PL = 58, PR = 16;

export function mountInstrument(host, ctx) {
  const T = ctx.traj;
  const isEv = ctx.kind === "event";
  const opts = { view: "value", baseline: true };
  const cp = T.change_point;
  const cpIdx = cp && cp.index != null ? cp.index : null;
  const t2 = T.s2.map((o) => ms(o.date));
  const t1 = T.s1.map((o) => ms(o.date));
  const cpT = isEv && cp?.first_supporting ? ms(cp.first_supporting) : null;
  const lcT = isEv && cp?.last_clean_pre ? ms(cp.last_clean_pre) : null;
  const shiftDays = (() => {
    const m = (ctx.cand?.flags || []).join(" ").match(/phase shift\s*([+\-−]?\d+)/i);
    return m ? parseInt(m[1].replace("−", "-"), 10) : null;
  })();

  // deviating observation counters (for tooltip)
  const devSoFar = (t) => {
    if (cpT == null) return 0;
    let n = 0;
    for (const o of [...T.s2, ...T.s1]) if (o.usable && ms(o.date) >= cpT && ms(o.date) <= t && Math.abs(o.z) >= 3) n++;
    return n;
  };

  let W = 0, geom = null, dead = false;

  function build() {
    W = Math.max(520, host.clientWidth);
    const top = isEv ? 52 : 74;
    const g = {
      W,
      ribbon: { y: 8, h: 24 },
      s2: { top, h: 218 },
      s1: { top: top + 218 + 40, h: 122 },
    };
    g.lane = { top: g.s1.top + g.s1.h + 26, h: 16 };
    g.H = g.lane.top + g.lane.h + 30;
    geom = g;
    const xOf = (t) => PL + ((t - S.t0) / (S.t1 - S.t0)) * (W - PL - PR);
    g.xOf = xOf;
    const dom = (key) => {
      const O = T[key];
      if (opts.view === "dev") return [-15, 15];
      const vals = [];
      O.forEach((o) => { if (o.usable) vals.push(o.value); vals.push(o.lo, o.hi); });
      let lo = Math.min(...vals), hi = Math.max(...vals);
      const p = (hi - lo) * 0.07;
      return [lo - p, hi + p];
    };
    g.s2.dom = dom("s2"); g.s1.dom = dom("s1");
    for (const k of ["s2", "s1"]) {
      const [a, b] = g[k].dom;
      g[k].y = (v) => g[k].top + g[k].h - ((clamp(v, a, b) - a) / (b - a)) * g[k].h;
    }
    host.innerHTML = draw(g);
    bind(g);
  }

  const val = (o) => (opts.view === "dev" ? o.z : o.value);
  const exv = (o) => (opts.view === "dev" ? 0 : o.expected);

  function draw(g) {
    const { xOf } = g;
    let s = `<svg class="inst" viewBox="0 0 ${g.W} ${g.H}" width="${g.W}" height="${g.H}">`;
    s += `<defs>
      <clipPath id="rv"><rect id="rv-r" x="0" y="0" width="0" height="${g.H}"/></clipPath>
      <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="rgba(169,139,255,.28)"/><line x1="0" y1="0" x2="0" y2="5" stroke="#a98bff" stroke-width="2"/></pattern>
    </defs>`;
    // ---- state ribbon (events) / rejection banner (candidates)
    if (isEv && T.stage_track) {
      const segs = [];
      T.stage_track.forEach((st, i) => {
        const a = i === 0 ? S.t0 : (t2[i - 1] + t2[i]) / 2, b = i === 47 ? S.t1 : (t2[i] + t2[i + 1]) / 2;
        if (segs.length && segs[segs.length - 1].st === st) segs[segs.length - 1].b = b;
        else segs.push({ st, a, b });
      });
      segs.forEach((sg, k) => {
        const x0 = xOf(sg.a), x1 = xOf(sg.b), w = x1 - x0;
        const ci = Math.min(RIB.length - 1, k === segs.length - 1 && segs.length > 2 ? RIB.length - 1 : k === 0 ? 0 : Math.min(3, k));
        s += `<rect x="${x0}" y="${g.ribbon.y}" width="${Math.max(0, w - 1)}" height="${g.ribbon.h}" fill="${RIB[ci]}"/>`;
        if (w > 58) s += `<text class="ribbon-t" x="${x0 + 7}" y="${g.ribbon.y + 15.5}">${esc(sg.st)}</text>`;
      });
      s += `<text class="lbl" x="${PL - 8}" y="${g.ribbon.y + 16}" text-anchor="end" style="font:600 8.5px Inter;letter-spacing:.14em;fill:#66768a">STATE</text>`;
    } else if (!isEv && ctx.cand) {
      const step = ctx.cand.checks.find((c) => c.status === "fail" || c.status === "warn");
      s += `<rect x="${PL}" y="${g.ribbon.y}" width="${g.W - PL - PR}" height="${g.ribbon.h + 4}" fill="rgba(255,107,107,.10)" stroke="rgba(255,107,107,.45)"/>
            <text x="${PL + 10}" y="${g.ribbon.y + 17}" style="font:700 9.5px Inter;letter-spacing:.14em;fill:#ff6b6b">${ctx.cand.status === "downgraded" ? "DOWNGRADED AT" : "STOPPED AT"} · ${esc((step?.label || "").toUpperCase())}</text>`;
    }
    // ---- panels
    s += panel(g, "s2", "SENTINEL-2 · OPTICAL EVIDENCE", T.metrics.s2.label);
    s += panel(g, "s1", "SENTINEL-1 · SAR EVIDENCE", T.metrics.s1.label);
    // ---- agreement lane
    const L = g.lane;
    s += `<text class="panel-t" x="${PL - 8}" y="${L.top + 12}" text-anchor="end" style="font-size:8.5px">AGREEMENT</text>
          <rect x="${PL}" y="${L.top}" width="${g.W - PL - PR}" height="${L.h}" fill="rgba(150,172,196,.06)"/>`;
    T.agreement.forEach((a, i) => {
      if (a === "none") return;
      const x0 = xOf(t2[i]), x1 = xOf(t2[i] + 15 * DAY);
      const fill = a === "both" ? "#4fe3b0" : a === "s2" ? "#3fd0e8" : a === "s1" ? "#a98bff" : "url(#hatch)";
      s += `<rect x="${x0}" y="${L.top}" width="${Math.max(1, x1 - x0 - 0.6)}" height="${L.h}" fill="${fill}" opacity="${a === "both" ? 0.9 : 0.75}"/>`;
    });
    // legend
    const lx = g.W - PR - 296, ly = L.top + L.h + 24;
    s += `<g style="font:500 9px 'JetBrains Mono';fill:#66768a">
      <rect x="${lx}" y="${ly - 7}" width="8" height="8" fill="#4fe3b0"/><text x="${lx + 12}" y="${ly}">both</text>
      <rect x="${lx + 52}" y="${ly - 7}" width="8" height="8" fill="#3fd0e8"/><text x="${lx + 64}" y="${ly}">S2 only</text>
      <rect x="${lx + 122}" y="${ly - 7}" width="8" height="8" fill="#a98bff"/><text x="${lx + 134}" y="${ly}">S1 only</text>
      <rect x="${lx + 190}" y="${ly - 7}" width="8" height="8" fill="url(#hatch)"/><text x="${lx + 202}" y="${ly}">SAR continuity</text></g>`;
    // ---- x axis labels
    const d0 = new Date(S.t0);
    let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
    for (let k = 0; k < 30; k++) {
      const t = Date.UTC(y, m, 1);
      if (t > S.t1) break;
      if (t >= S.t0 && m % 3 === 0) {
        const x = xOf(t);
        s += `<line class="grid" x1="${x}" x2="${x}" y1="${g.s2.top}" y2="${L.top + L.h}" opacity=".55"/><text x="${x + 3}" y="${g.H - 8}">${fmtMon(t)}</text>`;
      }
      m++; if (m > 11) { m = 0; y++; }
    }
    // ---- change point overlay
    if (cpT != null) {
      const x = xOf(cpT);
      const xa = lcT != null ? xOf(lcT) : x - 4;
      s += `<g clip-path="url(#rv)"><rect class="win" x="${xa}" y="${g.ribbon.y + 30}" width="${Math.max(5, x - xa)}" height="${L.top + L.h - g.ribbon.y - 30}"/>
        <line class="cp pulse" x1="${x}" x2="${x}" y1="${g.ribbon.y + 30}" y2="${L.top + L.h}"/></g>`;
    }
    // persistence bracket under S2 panel
    if (cpT != null && cp.duration_days) {
      const x0 = xOf(cpT), x1 = xOf(Math.min(S.t1, cpT + cp.duration_days * DAY));
      const yb = g.s2.top + g.s2.h + 12;
      s += `<g clip-path="url(#rv)"><path class="persist" d="M${x0} ${yb - 4}V${yb}H${x1}V${yb - 4}"/>
        <text class="plabel" x="${(x0 + x1) / 2}" y="${yb + 13}" text-anchor="middle">PERSISTS ${cp.duration_days} D · ${cp.persistence_obs} DEVIATING OBS</text></g>`;
    }
    // conventional pair (candidates)
    if (ctx.cand?.conventional) {
      const cv = ctx.cand.conventional;
      [["A", cv.ia], ["B", cv.ib]].forEach(([n, i]) => {
        const x = xOf(t2[i]);
        s += `<line x1="${x}" x2="${x}" y1="${g.s2.top}" y2="${g.s2.top + g.s2.h}" stroke="#ff6b6b" stroke-dasharray="2 3" opacity=".8"/>
              <rect x="${x - 9}" y="${g.s2.top - 15}" width="18" height="14" fill="#ff6b6b"/><text x="${x}" y="${g.s2.top - 5}" text-anchor="middle" style="fill:#1a0505;font:700 9.5px 'JetBrains Mono'">${n}</text>`;
      });
      s += `<text x="${PL + 4}" y="${g.s2.top - 6}" style="font:600 8.5px Inter;letter-spacing:.14em;fill:#ff8f8f">CONVENTIONAL TWO-DATE PAIR</text>`;
    }
    // flag label for events
    if (cpT != null) {
      const x = xOf(cpT);
      const lab = `FIRST SUPPORTING OBS · ${fmtMs(cpT)}`;
      const w = lab.length * 5.8 + 14;
      const fx = Math.min(x, g.W - PR - w);
      s += `<g clip-path="url(#rv)"><rect class="flag" x="${fx}" y="${g.ribbon.y + 30 - 15}" width="${w}" height="15"/><text class="flag-t" x="${fx + 7}" y="${g.ribbon.y + 30 - 4.5}">${lab}</text></g>`;
    }
    // cursor + readouts (positions updated live)
    s += `<g id="i-cur"><line class="cur" x1="0" x2="0" y1="${g.ribbon.y}" y2="${L.top + L.h}"/><path id="i-cur-h" d="" fill="#dde5ee"/>
      <text id="i-ro2" x="${g.W - PR - 4}" y="${g.s2.top + 13}" text-anchor="end" style="fill:#3fd0e8;font:500 10.5px 'JetBrains Mono'"></text>
      <text id="i-ro1" x="${g.W - PR - 4}" y="${g.s1.top + 13}" text-anchor="end" style="fill:#a98bff;font:500 10.5px 'JetBrains Mono'"></text></g>`;
    s += `<rect id="i-hit" x="${PL}" y="${g.ribbon.y}" width="${g.W - PL - PR}" height="${L.top + L.h - g.ribbon.y}" fill="transparent" style="cursor:ew-resize"/>`;
    return s + "</svg>";
  }

  function panel(g, key, title, ylabel) {
    const P = g[key], { xOf } = g;
    const O = T[key];
    const tt = key === "s2" ? t2 : t1;
    const col = COL[key];
    let s = "";
    const [a, b] = P.dom;
    // horizontal grid + y labels
    for (let k = 0; k <= 3; k++) {
      const v = a + ((b - a) * k) / 3, yy = P.y(v);
      s += `<line class="grid" x1="${PL}" x2="${g.W - PR}" y1="${yy}" y2="${yy}"/><text x="${PL - 8}" y="${yy + 3}" text-anchor="end">${opts.view === "dev" ? v.toFixed(0) + "σ" : key === "s2" ? v.toFixed(2) : v.toFixed(0)}</text>`;
    }
    s += `<text class="panel-t" x="${PL}" y="${P.top - 9}">${title}</text>`;
    s += `<text x="${PL + 6 + title.length * 6.6}" y="${P.top - 9}" style="font:400 9.5px JetBrains Mono;fill:#66768a">${opts.view === "dev" ? "deviation (σ)" : esc(ylabel)}</text>`;
    const useBase = opts.baseline;
    const pts = O.map((o, i) => ({ i, o, x: xOf(tt[i]), y: P.y(val(o)), e: P.y(exv(o)) }));
    // baseline layers
    if (useBase) {
      if (opts.view === "value") {
        let d = "M" + pts.map((p) => `${p.x} ${P.y(p.o.hi)}`).join("L");
        d += "L" + [...pts].reverse().map((p) => `${p.x} ${P.y(p.o.lo)}`).join("L") + "Z";
        s += `<path class="band" d="${d}"/>`;
        s += `<path class="band-e" d="M${pts.map((p) => `${p.x} ${P.y(p.o.hi)}`).join("L")}"/><path class="band-e" d="M${pts.map((p) => `${p.x} ${P.y(p.o.lo)}`).join("L")}"/>`;
        s += `<path class="exp" d="M${pts.map((p) => `${p.x} ${p.e}`).join("L")}"/>`;
        // last year's observations (makes seasonality legible)
        const pr = pts.filter((p) => p.i >= 24 && O[p.i - 24].usable);
        if (pr.length > 1) s += `<path class="prior" d="M${pr.map((p) => `${p.x} ${P.y(O[p.i - 24].value)}`).join("L")}"/>`;
        // candidate: phase-shifted baseline fits the observations
        if (shiftDays != null && key === "s2") {
          const sh = pts.map((p) => {
            const tq = tt[p.i] - shiftDays * DAY;
            let j = 0;
            while (j < 47 && tt[j + 1] <= tq) j++;
            const f = clamp((tq - tt[j]) / (tt[Math.min(47, j + 1)] - tt[j] || 1), 0, 1);
            const v = O[j].expected * (1 - f) + O[Math.min(47, j + 1)].expected * f;
            return `${p.x} ${P.y(v)}`;
          });
          s += `<path class="shift" d="M${sh.join("L")}"/><text x="${PL + 4}" y="${P.top + P.h - 8}" style="fill:#4fe3b0;font:600 9px Inter;letter-spacing:.1em">BASELINE SHIFTED ${shiftDays > 0 ? "+" : ""}${shiftDays} D FITS THE OBSERVATIONS</text>`;
        }
      } else {
        const yt = P.y(3), yb = P.y(-3);
        s += `<rect class="band" x="${PL}" y="${yt}" width="${g.W - PL - PR}" height="${yb - yt}"/><line class="thr" x1="${PL}" x2="${g.W - PR}" y1="${yt}" y2="${yt}"/><line class="thr" x1="${PL}" x2="${g.W - PR}" y1="${yb}" y2="${yb}"/>
              <text x="${g.W - PR - 4}" y="${yt - 4}" text-anchor="end" style="fill:#ffb020">+3σ</text>`;
      }
    }
    // revealed group
    s += `<g clip-path="url(#rv)">`;
    // counterfactual gap after the change point
    if (useBase && opts.view === "value" && cpIdx != null && isEv) {
      const post = pts.filter((p) => tt[p.i] >= (cpT ?? 0) - (key === "s1" ? 7 * DAY : 0) && p.o.usable);
      if (post.length > 1) {
        const top = post.map((p) => `${p.x} ${p.y}`).join("L");
        const bot = [...post].reverse().map((p) => `${p.x} ${p.e}`).join("L");
        s += `<path class="gap" d="M${top}L${bot}Z"/>`;
        s += `<path class="cf" d="M${post.map((p) => `${p.x} ${p.e}`).join("L")}"/>`;
      }
    }
    // observed line (dashed where masked observations interrupt)
    let prev = null;
    for (const p of pts) {
      if (!p.o.usable) continue;
      if (prev) s += `<path class="obs${p.i - prev.i > 1 ? " dash" : ""}" stroke="${col}" d="M${prev.x} ${prev.y}L${p.x} ${p.y}"/>`;
      prev = p;
    }
    // points
    for (const p of pts) {
      const dev = p.o.usable && Math.abs(p.o.z) >= 3 && (isEv ? cpT != null && tt[p.i] >= cpT - 1 : false);
      const cd = !isEv && Math.abs(p.o.z) >= 3 && (ctx.cand?.checks || []).some((c) => c.status === "fail");
      if (p.o.usable) {
        s += `<circle cx="${p.x}" cy="${p.y}" r="${dev ? 3.6 : 3}" fill="${col}" ${dev ? 'stroke="#ffb020" stroke-width="1.6"' : cd ? 'stroke="#ff6b6b" stroke-width="1.6"' : ""}/>`;
      } else {
        s += `<circle cx="${p.x}" cy="${p.y}" r="3.4" fill="#06080b" stroke="${cd ? "#ff6b6b" : "#66768a"}" stroke-width="1.3"/>`;
        if (key === "s2" && p.o.mask_reason === "cloud") s += `<path d="M${p.x - 3} ${p.y - 8}h6" stroke="#66768a" stroke-width="1" opacity=".7"/>`;
      }
      s += `<circle class="pt" data-k="${key}" data-i="${p.i}" cx="${p.x}" cy="${p.y}" r="8" fill="transparent"/>`;
    }
    s += `</g>`;
    return s;
  }

  // ---------------------------------------------------------------- interaction
  function nearest(tt, t) {
    let best = 0, bd = Infinity;
    tt.forEach((x, i) => { const d = Math.abs(x - t); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function tipHTML(key, i) {
    const o = T[key][i];
    const dv = Math.abs(o.z);
    const st = T.stage_track ? T.stage_track[i] : null;
    const stateLine = st ? `<div class="r"><span>State</span><b>${esc(st)}</b></div>` : "";
    const head = o.usable ? `<span class="good">USABLE</span>` : `<span class="bad">MASKED · ${esc((o.mask_reason || "").replace("_", " ").toUpperCase())}</span>`;
    const unit = key === "s2" ? "NDVI" : "VV dB";
    return `<div class="th"><span style="color:${COL[key]}">${key === "s2" ? "SENTINEL-2" : "SENTINEL-1"} · ${fmtDate(o.date)}</span>${head}</div>
      <div class="r"><span>${unit}</span><b>${o.value.toFixed(key === "s2" ? 3 : 1)}</b></div>
      <div class="r"><span>Expected</span><b>${o.expected.toFixed(key === "s2" ? 3 : 1)} <span style="color:#66768a">[${o.lo.toFixed(key === "s2" ? 2 : 1)}, ${o.hi.toFixed(key === "s2" ? 2 : 1)}]</span></b></div>
      <div class="r"><span>Deviation</span><b class="${dv >= 3 && o.usable ? "" : ""}" style="color:${dv >= 3 && o.usable ? "#ffb020" : "#dde5ee"}">${o.z > 0 ? "+" : ""}${o.z.toFixed(1)}σ</b></div>
      <div class="r"><span>Quality</span><b>${Math.round(o.quality * 100)}%${o.cloud_frac > 0.02 && key === "s2" ? " · cloud " + Math.round(o.cloud_frac * 100) + "%" : ""}</b></div>
      ${stateLine}
      ${isEv && cpT != null ? `<div class="r"><span>Deviating obs so far</span><b>${devSoFar(ms(o.date))}</b></div>` : ""}
      <div class="r"><span>Scene</span><b style="color:#66768a;font-size:9px">${esc(o.scene_id.replace("SYN_", "").slice(0, 34))}</b></div>`;
  }
  const tip = () => $("#tip");
  function showTip(html, ev) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const r = t.getBoundingClientRect();
    let x = ev.clientX + 16, y = ev.clientY + 14;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 16;
    if (y + r.height > innerHeight - 8) y = innerHeight - r.height - 8;
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  const hideTip = () => (tip().hidden = true);

  function bind(g) {
    const svg = host.querySelector("svg");
    const hit = host.querySelector("#i-hit");
    let drag = false;
    const tFrom = (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * g.W;
      return S.t0 + ((x - PL) / (g.W - PL - PR)) * (S.t1 - S.t0);
    };
    const scrub = (e) => { ctx.onInteract && ctx.onInteract(); stopPlay(); setCursor(clamp(tFrom(e), S.t0, S.t1), "instrument"); };
    hit.addEventListener("pointerdown", (e) => { drag = true; hit.setPointerCapture(e.pointerId); scrub(e); hideTip(); });
    hit.addEventListener("pointermove", (e) => { if (drag) scrub(e); else hover(e); });
    hit.addEventListener("pointerup", () => (drag = false));
    hit.addEventListener("pointerleave", () => { if (!drag) hideTip(); });
    const hover = (e) => {
      const r = svg.getBoundingClientRect();
      const y = ((e.clientY - r.top) / r.height) * g.H;
      const t = tFrom(e);
      let key = y < g.s1.top - 14 ? "s2" : y < g.lane.top - 8 ? "s1" : null;
      if (!key) return hideTip();
      const tt = key === "s2" ? t2 : t1;
      const i = nearest(tt, t);
      if (Math.abs(tt[i] - t) > 12 * DAY) return hideTip();
      showTip(tipHTML(key, i), e);
    };
    updateCursor();
    // reveal animation
    const rv = host.querySelector("#rv-r");
    if (ctx.animate !== false) {
      tween(1100, (t) => rv.setAttribute("width", (g.W + 2) * t), ease.inOut);
      host.querySelectorAll(".band,.band-e,.exp").forEach((n) => { n.style.opacity = 0; n.style.transition = "opacity .7s"; requestAnimationFrame(() => (n.style.opacity = "")); });
    } else rv.setAttribute("width", g.W + 2);
  }

  function updateCursor() {
    const g = geom;
    if (!g || !host.querySelector("#i-cur")) return;
    const x = g.xOf(S.cursor);
    const line = host.querySelector("#i-cur .cur");
    line.setAttribute("x1", x); line.setAttribute("x2", x);
    host.querySelector("#i-cur-h").setAttribute("d", `M${x - 6} ${g.ribbon.y - 7}h12l-6 8z`);
    const i2 = nearest(t2, S.cursor), i1 = nearest(t1, S.cursor);
    const o2 = T.s2[i2], o1 = T.s1[i1];
    const f = (o, d) => `${o.value.toFixed(d)}  exp ${o.expected.toFixed(d)}  ${o.z > 0 ? "+" : ""}${o.z.toFixed(1)}σ${o.usable ? "" : "  MASKED"}`;
    host.querySelector("#i-ro2").textContent = f(o2, 2);
    host.querySelector("#i-ro1").textContent = f(o1, 1);
    host.querySelector("#i-ro2").style.fill = o2.usable ? (Math.abs(o2.z) >= 3 ? "#ffb020" : "#3fd0e8") : "#66768a";
    host.querySelector("#i-ro1").style.fill = Math.abs(o1.z) >= 3 ? "#ffb020" : "#a98bff";
  }

  build();
  const ro = new ResizeObserver(() => { if (!dead && Math.abs(host.clientWidth - W) > 6) { ctx.animate = false; build(); } });
  ro.observe(host);
  return {
    setCursor: updateCursor,
    setOptions(o) { Object.assign(opts, o); ctx.animate = false; build(); },
    destroy() { dead = true; ro.disconnect(); hideTip(); host.innerHTML = ""; },
  };
}
