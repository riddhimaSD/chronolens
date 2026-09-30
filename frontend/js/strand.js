// The Trajectory Strand: one location's history as a picture.
//   expected seasonal band  ·  observed line  ·  amber break at the change point
// It appears on every marker, card, similarity result and suppressed candidate.
const f2 = (n) => Math.round(n * 100) / 100;

export function strandSVG(st, { w = 120, h = 40, pad = 3, band = true, cp = true, sw = 1.5, flat = false, color = null, id = "" } = {}) {
  if (!st) return "";
  const n = st.v.length;
  const X = (i) => pad + (i * (w - 2 * pad)) / (n - 1);
  const Y = (v) => h - pad - v * (h - 2 * pad);
  const path = (arr, from = 0, to = n - 1) => {
    let d = "";
    for (let i = from; i <= to; i++) d += (d ? "L" : "M") + f2(X(i)) + " " + f2(Y(arr[i]));
    return d;
  };
  let out = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="strand ${id}">`;
  if (band) {
    let d = path(st.hi);
    for (let i = n - 1; i >= 0; i--) d += "L" + f2(X(i)) + " " + f2(Y(st.lo[i]));
    out += `<path d="${d}Z" fill="rgba(140,168,204,.16)"/>`;
  }
  out += `<path d="${path(st.e)}" fill="none" stroke="rgba(170,190,215,.55)" stroke-width="1" stroke-dasharray="1.5 3" vector-effect="non-scaling-stroke"/>`;
  const c = st.cp;
  const base = color || "#8fa6c0";
  if (cp && c != null && !flat) {
    out += `<path d="${path(st.v, 0, c)}" fill="none" stroke="${base}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    out += `<path d="${path(st.v, c, n - 1)}" fill="none" stroke="#ffb020" stroke-width="${sw + 0.3}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    out += `<line x1="${f2(X(c))}" x2="${f2(X(c))}" y1="1" y2="${h - 1}" stroke="#ffb020" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke" opacity=".85"/>`;
  } else {
    out += `<path d="${path(st.v)}" fill="none" stroke="${base}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  }
  return out + "</svg>";
}

// compact glyph drawn inside map markers (22 x 12 box centred on 0,0)
export function miniStrand(st) {
  if (!st) return "";
  const n = st.v.length, w = 22, h = 12;
  const X = (i) => -w / 2 + (i * w) / (n - 1);
  const Y = (v) => h / 2 - v * h;
  const path = (arr, a = 0, b = n - 1) => {
    let d = "";
    for (let i = a; i <= b; i += 2) d += (d ? "L" : "M") + f2(X(i)) + " " + f2(Y(arr[i]));
    return d;
  };
  const c = st.cp;
  let o = `<path d="${path(st.e)}" fill="none" stroke="rgba(170,190,215,.5)" stroke-width=".8" stroke-dasharray="1 1.6"/>`;
  if (c != null) {
    const ce = c - (c % 2);
    o += `<path d="${path(st.v, 0, ce)}" fill="none" stroke="#9db2ca" stroke-width="1.3"/>`;
    o += `<path d="${path(st.v, ce, n - 1)}" fill="none" stroke="#ffb020" stroke-width="1.5"/>`;
  } else o += `<path d="${path(st.v)}" fill="none" stroke="#9db2ca" stroke-width="1.3"/>`;
  return o;
}
