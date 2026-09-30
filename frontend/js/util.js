// Small helpers shared by every module.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const sleep = (t) => new Promise((r) => setTimeout(r, t));
export const pct = (x) => Math.round(x * 100);
export const raf = () => new Promise((r) => requestAnimationFrame(r));

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const ms = (iso) => Date.parse(iso + "T00:00:00Z");
export const isoOf = (t) => new Date(t).toISOString().slice(0, 10);
export const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(ms(iso));
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
export const fmtMs = (t) => fmtDate(isoOf(t));
export const fmtMon = (t) => {
  const d = new Date(t);
  return `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
};
export const DAY = 86400000;

export const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  lin: (t) => t,
};
export function tween(dur, fn, easing = ease.out) {
  return new Promise((res) => {
    const t0 = performance.now();
    const step = (n) => {
      const p = Math.max(0, Math.min(1, (n - t0) / dur));
      fn(easing(p), p);
      p < 1 ? requestAnimationFrame(step) : res();
    };
    requestAnimationFrame(step);
  });
}

export const STAGES = ["Vegetation", "Clearing", "Foundation", "Construction", "Completed"];
export const stageAt = (seq, isoOrMs) => {
  if (!seq || !seq.length) return null;
  const iso = typeof isoOrMs === "number" ? isoOf(isoOrMs) : isoOrMs;
  let st = seq[0].state;
  for (const s of seq) if (s.start <= iso) st = s.state;
  return st;
};

export const TYPE_UP = {
  construction: "New construction",
  clearance: "Vegetation clearance",
  water_extent: "Water-extent variation",
  road: "Road development",
  other: "Surface change",
};
export const SENSOR_STATE = { supports: "✓", ambiguous: "~", contradicts: "✕", unavailable: "–" };

export function toast(msg, kind = "", sub = "") {
  const host = $("#toasts");
  const d = document.createElement("div");
  d.className = "toast " + kind;
  d.innerHTML = esc(msg) + (sub ? `<small>${esc(sub)}</small>` : "");
  host.appendChild(d);
  setTimeout(() => {
    d.style.transition = "opacity .3s, transform .3s";
    d.style.opacity = "0";
    d.style.transform = "translateY(8px)";
    setTimeout(() => d.remove(), 320);
  }, 3400);
}

// FLIP reorder: call with the container and a function that mutates it.
export function flip(container, mutate, sel = "[data-id]", dur = 420) {
  const first = new Map();
  $$(sel, container).forEach((n) => first.set(n.dataset.id, n.getBoundingClientRect()));
  mutate();
  $$(sel, container).forEach((n) => {
    const a = first.get(n.dataset.id);
    if (!a) {
      n.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: dur, easing: "ease-out" });
      return;
    }
    const b = n.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (dx || dy) n.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: dur, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
}

export function download(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
