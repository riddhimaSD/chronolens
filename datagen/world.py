"""
ChronoLens demo — synthetic world model + imagery renderer.

Everything here is SYNTHETIC. The AOI is a procedurally generated floodplain (river, parcels,
roads, villages, construction sites). Sentinel-2-like and Sentinel-1-like imagery are rendered from
one shared surface-state model, so the time series that the backend serves and the pictures that the
front end shows always agree with each other.
"""
from __future__ import annotations
import datetime as dt
import math
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

N = 2048                # world raster size (px)
PX_M = 6.25             # metres per world pixel  (2048 px * 6.25 m = 12.8 km)
AOI_KM = N * PX_M / 1000.0


# ----------------------------------------------------------------------------- helpers
def smoothstep(a, b, x):
    t = np.clip((x - a) / max(b - a, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


def fbm(n, scales, weights, seed):
    r = np.random.default_rng(seed)
    out = np.zeros((n, n), np.float32)
    for s, w in zip(scales, weights):
        k = max(2, n // s)
        g = r.standard_normal((k, k)).astype(np.float32)
        im = Image.fromarray(g, mode="F").resize((n, n), Image.BICUBIC)
        a = np.asarray(im, np.float32)
        out += w * a / (a.std() + 1e-6)
    return out / (out.std() + 1e-6)


def gauss(x, sig):
    return np.exp(-0.5 * (x / sig) ** 2)


def circ(d, mu):
    return ((d - mu + 182.5) % 365) - 182.5


def doy(date: dt.date) -> int:
    return date.timetuple().tm_yday


# ----------------------------------------------------------------------------- seasonal model
# crop classes: 0 double-crop cereal, 1 sugarcane/perennial, 2 fallow/scrub, 3 orchard, 4 floodplain veg
def ndvi_season(d, crop, phase=0.0, amp=1.0):
    """Expected NDVI for a tile on day-of-year d. `d` may be an array."""
    crop = np.asarray(crop)
    d = np.asarray(d, np.float32)
    dd = np.where(crop >= 0, d, d)
    rabi = gauss(circ(dd, 56 + phase), 33)
    kharif = gauss(circ(dd, 248 + phase), 36)
    v0 = 0.22 + amp * (0.42 * rabi + 0.36 * kharif)
    v1 = 0.34 + 0.30 * gauss(circ(dd, 205), 90)
    v2 = 0.19 + 0.11 * gauss(circ(dd, 232), 55)
    v3 = 0.41 + 0.10 * gauss(circ(dd, 215), 80)
    v4 = 0.30 + 0.24 * gauss(circ(dd, 236), 60)
    out = np.select([crop == 0, crop == 1, crop == 2, crop == 3, crop == 4], [v0, v1, v2, v3, v4], v0)
    return out.astype(np.float32)


def vv_from_ndvi(ndvi):
    """Expected S1 VV backscatter (dB) of vegetated ground as a function of greenness."""
    return -13.6 + 5.0 * (ndvi - 0.20)


# ----------------------------------------------------------------------------- world
class World:
    def __init__(self, seed=11):
        self.rng = np.random.default_rng(seed)
        self._build()

    # ..................................................................... construction
    def _build(self):
        r = self.rng
        yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
        self.xx, self.yy = xx, yy

        # --- river -----------------------------------------------------------
        ys = np.arange(N, dtype=np.float32)
        xc = 0.5 * N + 0.10 * N * np.sin(2 * np.pi * ys / N * 1.15 + 0.4) + 0.03 * N * np.sin(2 * np.pi * ys / N * 3.3 + 1.0)
        hw = 7.5 + 2.5 * np.sin(2 * np.pi * ys / N * 2.1 + 0.3)
        self.river_x, self.river_hw = xc, hw
        dxr = xx - xc[:, None]
        channel = np.abs(dxr) < hw[:, None]
        self.channel = channel
        self.dist_edge = ndi.distance_transform_edt(~channel).astype(np.float32)   # px to nearest water edge
        n_sand = fbm(N, [180, 70, 24], [0.5, 0.35, 0.15], 21)
        self.sand = channel & (n_sand > 0.55) & (np.abs(dxr) > hw[:, None] * 0.25)
        # a slightly widened flood-plain terrace
        self.floodplain = self.dist_edge < 58

        # --- parcels (domain-warped, two orientations) ------------------------
        w1 = fbm(N, [420, 160, 60], [0.5, 0.35, 0.15], 1) * 9
        w2 = fbm(N, [420, 160, 60], [0.5, 0.35, 0.15], 2) * 9
        blend = smoothstep(0.25 * N, 0.75 * N, xx)
        th = 0.16 * (1 - blend) + (-0.12) * blend
        u = xx * np.cos(th) + yy * np.sin(th) + w1
        v = -xx * np.sin(th) + yy * np.cos(th) + w2
        pi = np.floor(u / 52).astype(np.int32) + 200
        pj = np.floor(v / 38).astype(np.int32) + 200
        key = pi * 1000 + pj
        _, inv = np.unique(key.ravel(), return_inverse=True)
        self.parcel = inv.reshape(N, N).astype(np.int32)
        n_par = int(self.parcel.max()) + 1
        cnt = np.bincount(self.parcel.ravel(), minlength=n_par).astype(np.float32)
        fp_frac = np.bincount(self.parcel.ravel(), weights=self.floodplain.ravel().astype(np.float32), minlength=n_par) / cnt
        crop = r.choice([0, 0, 0, 0, 1, 2, 3], size=n_par).astype(np.int32)
        crop = np.where(fp_frac > 0.5, np.where(r.random(n_par) < 0.75, 4, 2), crop)
        self.p_crop = crop
        self.p_phase = r.normal(0, 9, n_par).astype(np.float32)
        self.p_amp = r.uniform(0.85, 1.12, n_par).astype(np.float32)
        self.p_soil = np.clip(np.array([0.60, 0.50, 0.38]) + r.normal(0, 0.035, (n_par, 3)), 0, 1).astype(np.float32)
        gvar = r.normal(0, 0.03, (n_par, 3))
        self.p_green = np.clip(np.array([0.22, 0.44, 0.17]) + gvar + np.array([0.0, r.uniform(-0.04, 0.05), 0.0]), 0, 1).astype(np.float32)
        self.p_db = r.normal(0, 0.7, n_par).astype(np.float32)   # parcel-level SAR offset (dB)
        # parcel boundaries (lighter field bunds)
        b = np.zeros((N, N), bool)
        b[:, 1:] |= self.parcel[:, 1:] != self.parcel[:, :-1]
        b[1:, :] |= self.parcel[1:, :] != self.parcel[:-1, :]
        self.bund = b

        # --- roads --------------------------------------------------------------
        hy = 0.30 * N + 0.022 * N * np.sin(2 * np.pi * xx / N * 1.7 + 0.5)
        road = np.abs(yy - hy) < 1.7
        rx = 0.21 * N + 0.02 * N * np.sin(2 * np.pi * yy / N * 2.2 + 1.3)
        road |= np.abs(xx - rx) < 1.25
        # diagonal district road
        x1, y1, x2, y2 = 0.04 * N, 0.86 * N, 0.97 * N, 0.62 * N
        dd = np.abs((y2 - y1) * xx - (x2 - x1) * yy + x2 * y1 - y2 * x1) / math.hypot(x2 - x1, y2 - y1)
        road |= dd < 1.1
        self.road = road & ~channel
        self.bridge = road & channel

        # --- villages / static built-up ------------------------------------------
        self.built_alpha = np.zeros((N, N), np.float32)
        self.built_rgb = np.zeros((N, N, 3), np.float32)
        self.built_db = np.full((N, N), -22.0, np.float32)
        self.villages = [
            (0.13, 0.12, 62), (0.83, 0.10, 54), (0.10, 0.66, 70), (0.90, 0.40, 58),
            (0.74, 0.90, 76), (0.30, 0.48, 46), (0.63, 0.34, 40),
        ]
        for (fx, fy, R) in self.villages:
            self._add_settlement(fx * N, fy * N, R, dens=0.85)
        # a small town in the SE corner
        self._add_settlement(0.86 * N, 0.78 * N, 120, dens=0.95, grid=True)

        # --- static ponds ----------------------------------------------------------
        self.pond = np.zeros((N, N), bool)
        for (fx, fy, a, b_) in [(0.30, 0.20, 16, 11), (0.72, 0.56, 12, 9), (0.18, 0.86, 18, 10), (0.91, 0.24, 11, 8), (0.42, 0.72, 13, 9)]:
            ell = ((xx - fx * N) / a) ** 2 + ((yy - fy * N) / b_) ** 2 < 1
            self.pond |= ell

        # low-frequency textures reused by the renderer
        self.tex_a = fbm(N, [64, 24, 9, 3], [0.25, 0.3, 0.3, 0.15], 31)
        self.tex_b = fbm(N, [40, 14, 5], [0.4, 0.4, 0.2], 32)

    def _add_settlement(self, cx, cy, R, dens=0.85, grid=False):
        r = self.rng
        pitch = 5
        # soft built-up ground under the settlement (compound walls, courtyards, lanes)
        gy, gx = np.ogrid[0:N, 0:N]
        disc = np.clip(1.15 - np.hypot(gx - cx, gy - cy) / R, 0, 1)
        base_a = (np.clip(disc * 1.6, 0, 0.62) * (0.75 + 0.25 * (self.tex_b if hasattr(self, "tex_b") else 0))).astype(np.float32)
        base_col = np.array([0.56, 0.50, 0.44], np.float32)
        upd = base_a > self.built_alpha
        self.built_rgb = np.where(upd[..., None], base_col, self.built_rgb)
        self.built_alpha = np.where(upd, base_a, self.built_alpha)
        self.built_db = np.where(base_a > 0.25, np.maximum(self.built_db, -9.0), self.built_db)
        xs = np.arange(int(cx - R), int(cx + R), pitch)
        ys = np.arange(int(cy - R), int(cy + R), pitch)
        roofs = [(0.66, 0.64, 0.62), (0.72, 0.56, 0.46), (0.78, 0.78, 0.80), (0.60, 0.42, 0.36), (0.70, 0.68, 0.60)]
        for y in ys:
            for x in xs:
                d = math.hypot(x - cx, y - cy) / R
                if d > 1:
                    continue
                if grid and ((int(x - cx) // 4) % 6 == 0 or (int(y - cy) // 4) % 6 == 0):
                    continue          # streets
                if r.random() > dens * (1 - d ** 2) + 0.05:
                    continue
                jx, jy = int(x + r.integers(-1, 2)), int(y + r.integers(-1, 2))
                w, h = int(r.integers(3, 5)), int(r.integers(3, 5))
                if 0 <= jx < N - w and 0 <= jy < N - h and not self.channel[jy, jx]:
                    col = np.array(roofs[r.integers(0, len(roofs))]) + r.normal(0, 0.03, 3)
                    self.built_alpha[jy:jy + h, jx:jx + w] = 1
                    self.built_rgb[jy:jy + h, jx:jx + w] = col
                    self.built_db[jy:jy + h, jx:jx + w] = r.uniform(-7, -2)
        # soft ground under the settlement
        self.built_alpha = np.maximum(self.built_alpha, 0)

    # ..................................................................... static decoy features
    def add_decoy_features(self, decoys):
        """Bake pre-existing (unchanging) look-alike sites into the static layers."""
        r = self.rng
        for d in decoys:
            cx, cy = d["px"]
            kind = d["kind"]
            if kind == "warehouse":              # old logistics yard: big roofs + apron
                for k in range(3):
                    x0, y0 = int(cx - 42 + k * 30), int(cy - 20 + (k % 2) * 8)
                    self._rect_static(x0 - 2, y0 - 2, 27, 26, (0.58, 0.58, 0.59), -13)
                    self._rect_static(x0, y0, 23, 22, (0.80, 0.82, 0.86), -3.5)
                    self._rect_static(x0 + 11, y0, 1, 22, (0.72, 0.74, 0.78), -3.0)
                self._rect_static(int(cx - 46), int(cy + 12), 100, 5, (0.52, 0.52, 0.53), -14)
            elif kind == "kiln":                 # brick kilns: red-brown blocks + chimney shadow
                for k in range(3):
                    x0, y0 = int(cx - 40 + k * 28), int(cy - 12 + (k % 2) * 14)
                    self._rect_static(x0, y0, 22, 13, (0.62, 0.36, 0.28), -5.5)
                    self._rect_static(x0 + 22, y0 + 3, 4, 4, (0.20, 0.18, 0.17), -9)
            elif kind == "village":
                self._add_settlement(cx, cy, 34, dens=0.95)
            elif kind == "quarry":               # pale excavated pit
                ell = ((self.xx - cx) / 22) ** 2 + ((self.yy - cy) / 15) ** 2
                self.built_alpha = np.where(ell < 1, 1.0, self.built_alpha)
                for c in range(3):
                    self.built_rgb[..., c] = np.where(ell < 1, (0.83, 0.79, 0.68)[c] - 0.06 * np.clip(ell, 0, 1), self.built_rgb[..., c])
                self.built_db = np.where(ell < 1, -15.5, self.built_db)
            elif kind == "estate":               # old industrial estate: many roof blocks
                for a_ in range(2):
                    for b_ in range(4):
                        x0, y0 = int(cx - 48 + b_ * 25), int(cy - 20 + a_ * 26)
                        self._rect_static(x0 - 1, y0 - 1, 22, 20, (0.58, 0.58, 0.59), -13)
                        self._rect_static(x0, y0, 20, 18, (0.76, 0.77, 0.80), -4)
            elif kind == "bare":                 # fallow field left bare (looks like a cleared plot)
                ell = np.maximum(np.abs(self.xx - cx) / 28, np.abs(self.yy - cy) / 18)
                self.built_alpha = np.where(ell < 1, 1.0, self.built_alpha)
                for c in range(3):
                    self.built_rgb[..., c] = np.where(ell < 1, (0.70, 0.60, 0.46)[c] + 0.02 * self.tex_b, self.built_rgb[..., c])
                self.built_db = np.where(ell < 1, -15.0, self.built_db)

    def _rect_static(self, x0, y0, w, h, rgb, db):
        x0, y0 = max(0, x0), max(0, y0)
        self.built_alpha[y0:y0 + h, x0:x0 + w] = 1
        self.built_rgb[y0:y0 + h, x0:x0 + w] = rgb
        self.built_db[y0:y0 + h, x0:x0 + w] = db

    # ..................................................................... distances
    def river_dist_m(self, px, py):
        return float(self.dist_edge[int(np.clip(py, 0, N - 1)), int(np.clip(px, 0, N - 1))]) * PX_M

    # ..................................................................... per-date fields
    def parcel_ndvi(self, date: dt.date):
        return ndvi_season(np.full(len(self.p_crop), doy(date), np.float32), self.p_crop, self.p_phase, self.p_amp)


# ----------------------------------------------------------------------------- sites
class Site:
    """A place where something happens. `state(date)` returns the surface composition."""

    def __init__(self, sid, cx, cy, w, h, ang, kind, sched, crop=0, sar_gain=1.0, seed=0, extra=None):
        self.id, self.cx, self.cy, self.w, self.h, self.ang = sid, cx, cy, w, h, ang
        self.kind, self.sched, self.crop, self.sar_gain = kind, sched, crop, sar_gain
        self.extra = extra or {}
        r = np.random.default_rng(1000 + seed)
        self.buildings = []
        if kind == "construction":
            nb = int(r.integers(2, 4))
            bw = w / (nb + 0.6)
            for k in range(nb):
                bx = -w / 2 + 0.25 * bw + k * (bw * 1.02)
                by = -h / 2 + h * (0.14 if k % 2 == 0 else 0.30)
                self.buildings.append((bx, by, bw * 0.86, h * (0.55 if k % 2 == 0 else 0.48)))
        self.bldg_area = sum(b[2] * b[3] for b in self.buildings)
        self.foot_area = w * h

    # simple linear ramps ------------------------------------------------------
    @staticmethod
    def ramp(date, t0, t1):
        if t0 is None:
            return 0.0
        a, b = t0.toordinal(), t1.toordinal()
        return float(np.clip((date.toordinal() - a) / max(b - a, 1), 0, 1))

    def state(self, date: dt.date, baseline=False):
        s = self.sched
        st = dict(veg=1.0, found=0.0, built=0.0, water=0.0, sand=0.0, road=0.0, plastic=0.0, dump=0.0, gain=0.0)
        k = self.kind
        if baseline:               # the no-change counterfactual the tile's baseline describes
            if k == "water":
                st["water"] = self.extra.get("water0", 0.0)
            elif k == "candidate":
                st.update(self.extra.get("base", {}))
            return st
        if k == "construction":
            st["veg"] = 1 - self.ramp(date, s["clear0"], s["clear1"])
            st["found"] = self.ramp(date, s["found0"], s["found1"])
            st["built"] = self.ramp(date, s["cons0"], s["cons1"])
        elif k == "clearance":
            st["veg"] = 1 - self.ramp(date, s["clear0"], s["clear1"])
        elif k == "water":
            base = self.extra.get("water0", 0.0)
            tgt = self.extra.get("water1", 1.0)
            p = self.ramp(date, s["t0"], s["t1"])
            st["water"] = base + (tgt - base) * p
            st["veg"] = 1.0
        elif k == "road":
            st["veg"] = 1 - self.ramp(date, s["clear0"], s["clear1"])
            st["road"] = self.ramp(date, s["pave0"], s["pave1"])
        elif k == "other":
            sub = self.extra["sub"]
            p = self.ramp(date, s["t0"], s["t1"])
            if sub == "plastic":
                st["plastic"] = p
            elif sub == "dump":
                st["veg"] = 1 - p
                st["dump"] = p
            elif sub == "orchard":
                st["gain"] = p
        elif k == "candidate":
            # candidates have hand-authored composition functions
            st.update(self.extra["fn"](date))
        return st

    # per-class fractions used by both the series model and the renderer ---------
    def composition(self, date, baseline=False):
        st = self.state(date, baseline)
        built_max = self.bldg_area / max(self.foot_area, 1) * 1.35 if self.kind == "construction" else 0.0
        built_f = st["built"] * built_max
        found_f = st["found"] * 0.5 * (1 - built_f) * (1 - st["built"]) if self.kind == "construction" else 0.0
        water_f = st["water"] * self.extra.get("water_frac", 0.85)
        sand_f = st["sand"] * 0.85
        road_f = st["road"] * 0.45
        plastic_f = st["plastic"] * 0.7
        dump_f = st["dump"] * 0.8
        occupied = built_f + found_f + water_f + sand_f + road_f + plastic_f + dump_f
        rest = max(0.0, 1 - occupied)
        veg_f = rest * st["veg"]
        bare_f = rest * (1 - st["veg"])
        return dict(veg=veg_f, bare=bare_f, built=built_f, found=found_f, water=water_f, sand=sand_f,
                    road=road_f, plastic=plastic_f, dump=dump_f, gain=st["gain"], raw=st)

    # observations -----------------------------------------------------------------
    def ndvi_expected(self, date, shift=0):
        d = doy(date) + shift
        return float(ndvi_season(np.array([d], np.float32), np.array([self.crop]), np.array([self.extra.get("phase", 0.0)], np.float32), np.array([1.0], np.float32))[0])

    def s2_value(self, date, baseline=False):
        c = self.composition(date, baseline)
        nd = self.ndvi_expected(date, 0 if baseline else self.extra.get("shift", 0))
        gain_boost = c["gain"] * 0.20
        nd_veg = min(0.85, nd + gain_boost)
        val = (c["veg"] * nd_veg + c["bare"] * 0.13 + c["built"] * 0.07 + c["found"] * 0.09 + c["water"] * -0.28
               + c["sand"] * 0.06 + c["road"] * 0.05 + c["plastic"] * 0.16 + c["dump"] * 0.10)
        return float(val)

    def s1_value(self, date, baseline=False):
        c = self.composition(date, baseline)
        nd = self.ndvi_expected(date, 0 if baseline else self.extra.get("shift", 0)) + c["gain"] * 0.20
        vv_veg = vv_from_ndvi(nd)
        g = self.sar_gain

        def lin(db):
            return 10 ** (db / 10)
        built_db = -15.2 + (-3.6 + 15.2) * g
        found_db = -15.2 + (-5.5 + 15.2) * g
        p = (c["veg"] * lin(vv_veg) + c["bare"] * lin(-15.2) + c["built"] * lin(built_db) + c["found"] * lin(found_db)
             + c["water"] * lin(-21.0) + c["sand"] * lin(-17.5) + c["road"] * lin(-16.5)
             + c["plastic"] * lin(-8.5) + c["dump"] * lin(-9.5))
        return float(10 * math.log10(max(p, 1e-6)))


# ----------------------------------------------------------------------------- rendering
BARE = np.array([0.68, 0.57, 0.43], np.float32)
WATER_RIVER = np.array([0.17, 0.25, 0.27], np.float32)
WATER_POND = np.array([0.10, 0.20, 0.25], np.float32)
SAND = np.array([0.80, 0.74, 0.60], np.float32)
ASPHALT = np.array([0.36, 0.36, 0.37], np.float32)
ROOF = np.array([0.80, 0.82, 0.86], np.float32)
CONCRETE = np.array([0.76, 0.74, 0.70], np.float32)


def _local(site: Site, xs, ys):
    c, s = math.cos(site.ang), math.sin(site.ang)
    dx, dy = xs - site.cx, ys - site.cy
    return dx * c + dy * s, -dx * s + dy * c


def _rect(u, v, x0, y0, w, h):
    return (u >= x0) & (u <= x0 + w) & (v >= y0) & (v <= y0 + h)


class Renderer:
    def __init__(self, world: World, sites: list[Site], scenes: dict):
        self.w, self.sites, self.scenes = world, sites, scenes
        self._pn_cache = {}

    # -- per-date parcel greenness cache
    def _pn(self, date):
        k = date.toordinal()
        if k not in self._pn_cache:
            self._pn_cache = {k: self.w.parcel_ndvi(date)}
        return self._pn_cache[k]

    # ------------------------------------------------------------------ S2
    def s2(self, x0, y0, size, date, cloud=None, haze=0.0, misreg=(0.0, 0.0), seed=0, out=None):
        w = self.w
        x0, y0 = int(np.clip(x0, 0, N - size)), int(np.clip(y0, 0, N - size))
        sl = (slice(y0, y0 + size), slice(x0, x0 + size))
        idx = w.parcel[sl]
        ndv = self._pn(date)[idx]
        g = np.clip((ndv - 0.10) / 0.52, 0, 1)[..., None]
        col = w.p_soil[idx] * (1 - g) + w.p_green[idx] * g
        tex = w.tex_a[sl][..., None]
        col = col * (1 + 0.035 * tex)
        # bunds
        col = np.where(w.bund[sl][..., None], col * 0.90 + 0.06, col)
        fp = w.floodplain[sl][..., None]
        col = np.where(fp, col * np.array([0.94, 0.98, 0.94], np.float32), col)
        # static built-up (villages, decoys)
        ba = w.built_alpha[sl][..., None]
        col = col * (1 - ba) + w.built_rgb[sl] * ba
        # ponds
        col = np.where(w.pond[sl][..., None], WATER_POND + 0.02 * tex, col)
        # river, sandbars, roads
        ch = w.channel[sl][..., None]
        col = np.where(ch, WATER_RIVER + 0.025 * tex + 0.02 * w.tex_b[sl][..., None], col)
        col = np.where(w.sand[sl][..., None], SAND + 0.02 * w.tex_b[sl][..., None], col)
        rd = w.road[sl][..., None]
        col = np.where(rd, ASPHALT, col)
        col = np.where(w.bridge[sl][..., None], ASPHALT * 1.15, col)
        # sites
        yy, xx = w.yy[sl], w.xx[sl]
        for st in self.sites:
            self._paint_s2(st, date, col, xx, yy, x0, y0, size)
        # seasonal atmosphere
        d = doy(date)
        winter = smoothstep(340, 365, d) + (1 - smoothstep(0, 40, d))   # Dec–Jan fog
        dust = gauss(circ(d, 150), 25)                                   # May–Jun dust
        col = col * (1 - 0.10 * winter) + 0.10 * winter * np.array([0.72, 0.74, 0.78], np.float32)
        col = col * (1 - 0.07 * dust) + 0.07 * dust * np.array([0.82, 0.72, 0.55], np.float32)
        if haze > 0:
            col = col * (1 - haze) + haze * np.array([0.78, 0.80, 0.84], np.float32)
        # clouds + shadows
        if cloud is not None:
            ca = cloud[y0:y0 + size, x0:x0 + size]
            sh = np.roll(np.roll(cloud, 20, 0), 26, 1)[y0:y0 + size, x0:x0 + size]
            sh = np.clip(sh - ca, 0, 1) * 0.42
            col = col * (1 - sh[..., None])
            cc = np.array([0.96, 0.96, 0.97], np.float32)
            col = col * (1 - ca[..., None]) + cc * ca[..., None]
        if misreg != (0.0, 0.0):
            col = ndi.shift(col, (misreg[1], misreg[0], 0), order=1, mode="nearest")
        rr = np.random.default_rng(seed)
        col = col + rr.normal(0, 0.008, col.shape).astype(np.float32)
        return np.clip(col, 0, 1)

    def _paint_s2(self, st: Site, date, col, xx, yy, x0, y0, size):
        R = max(st.w, st.h) * 0.9 + 30
        if abs(st.cx - (x0 + size / 2)) > R + size / 2 or abs(st.cy - (y0 + size / 2)) > R + size / 2:
            return
        u, v = _local(st, xx, yy)
        c = st.composition(date)
        raw = c["raw"]
        k = st.kind
        foot = _rect(u, v, -st.w / 2, -st.h / 2, st.w, st.h)
        if k in ("construction", "clearance", "road") or (k == "other" and st.extra["sub"] == "dump"):
            clear = (1 - raw["veg"])
            if k == "road":
                strip = _rect(u, v, -st.w / 2, -st.h / 2, st.w, st.h)
                foot = strip
            if clear > 0.01:
                soil = BARE + 0.03 * np.sin(v * 1.1)[..., None] + 0.02 * np.sin(u * 0.7)[..., None]
                m = (foot * clear)[..., None]
                col[:] = col * (1 - m) + soil * m
        if k == "construction":
            for j, (bx, by, bw, bh) in enumerate(st.buildings):
                slab = _rect(u, v, bx - 2, by - 2, bw + 4, bh + 4)
                if raw["found"] > 0.01 and raw["built"] < 0.999:
                    part = slab & (u < bx - 2 + (bw + 4) * min(1.0, raw["found"] * 1.05))
                    trench = part & (~_rect(u, v, bx, by, bw, bh))
                    col[:] = np.where(part[..., None], col * 0.35 + CONCRETE * 0.65, col)
                    col[:] = np.where(trench[..., None], col * 0.72, col)
                nb = len(st.buildings)
                p_b = float(np.clip(raw["built"] * nb - j, 0, 1))
                if p_b > 0:
                    roof = _rect(u, v, bx, by, bw * p_b, bh)
                    shadow = _rect(u, v, bx, by - 2.2, bw * p_b, 2.2) & (~roof)
                    col[:] = np.where(shadow[..., None], col * 0.5, col)
                    ridge = roof & (np.abs(v - (by + bh / 2)) < 0.8)
                    rc = ROOF + (0.03 * np.sin(u * 0.9))[..., None]
                    col[:] = np.where(roof[..., None], rc, col)
                    col[:] = np.where(ridge[..., None], col * 0.93, col)
            if raw["built"] > 0.15:
                yard = _rect(u, v, -st.w / 2, -st.h / 2, st.w, st.h) & (~np.any([_rect(u, v, b[0], b[1], b[2], b[3]) for b in st.buildings], axis=0))
                a = np.clip((raw["built"] - 0.15) / 0.6, 0, 1) * 0.85
                col[:] = np.where(yard[..., None], col * (1 - a) + np.array([0.60, 0.60, 0.60], np.float32) * a, col)
            if raw["built"] > 0.92:
                green = _rect(u, v, -st.w / 2 + 1, st.h / 2 - 4, st.w - 2, 3)
                col[:] = np.where(green[..., None], np.array([0.28, 0.44, 0.24], np.float32), col)
            # access track from the site toward the nearest road, appears with clearing
            if raw["veg"] < 0.9:
                tr = _rect(u, v, -3 - st.w * 0.6, -1.0, st.w * 0.6 + 3, 2.0)
                col[:] = np.where(tr[..., None], col * 0.3 + np.array([0.70, 0.64, 0.52], np.float32) * 0.7, col)
        elif k == "road":
            if raw["road"] > 0.01:
                paved = _rect(u, v, -st.w / 2, -2.6, st.w * raw["road"], 5.2)
                col[:] = np.where(paved[..., None], ASPHALT * 1.05, col)
        elif k == "water":
            ell = ((u / (st.w / 2)) ** 2 + (v / (st.h / 2)) ** 2)
            base_r = self.sites_water_radius(st, c["raw"]["water"])
            wet = ell < base_r ** 2
            ring = (ell < (base_r * 1.22) ** 2) & ~wet
            col[:] = np.where(ring[..., None], col * 0.72 + np.array([0.28, 0.26, 0.22], np.float32) * 0.28, col)
            col[:] = np.where(wet[..., None], WATER_POND * (1 + 0.05 * np.sin(u * 0.6)[..., None]), col)
        elif k == "other":
            sub = st.extra["sub"]
            if sub == "plastic" and raw["plastic"] > 0.01:
                rows = (np.sin(v * 1.8) > -0.2) & foot & (u < -st.w / 2 + st.w * raw["plastic"])
                col[:] = np.where(rows[..., None], np.array([0.90, 0.92, 0.94], np.float32), col)
            elif sub == "dump" and raw["dump"] > 0.01:
                mott = foot & (np.sin(u * 0.4) * np.cos(v * 0.5) > -0.3)
                col[:] = np.where(mott[..., None], col * (1 - 0.7 * raw["dump"]) + np.array([0.30, 0.28, 0.26], np.float32) * 0.7 * raw["dump"], col)
            elif sub == "orchard" and raw["gain"] > 0.01:
                dots = foot & ((np.mod(u, 5) < 1.6) & (np.mod(v, 5) < 1.6))
                col[:] = np.where(foot[..., None], col * (1 - 0.25 * raw["gain"]) + np.array([0.13, 0.30, 0.12], np.float32) * 0.25 * raw["gain"], col)
                col[:] = np.where(dots[..., None], np.array([0.10, 0.26, 0.10], np.float32), col)
        elif k == "candidate":
            fn = st.extra["paint"]
            fn(st, date, col, u, v, c["raw"], "s2")

    @staticmethod
    def sites_water_radius(st: Site, wfrac):
        return 0.15 + 0.85 * wfrac if wfrac > 0 else 0.0

    # ------------------------------------------------------------------ S1
    def s1(self, x0, y0, size, date, seed=0, tint=True):
        w = self.w
        x0, y0 = int(np.clip(x0, 0, N - size)), int(np.clip(y0, 0, N - size))
        sl = (slice(y0, y0 + size), slice(x0, x0 + size))
        idx = w.parcel[sl]
        ndv = self._pn(date)[idx]
        db = vv_from_ndvi(ndv) + w.p_db[idx] + 0.6 * w.tex_b[sl]
        db = np.where(w.bund[sl], db - 1.2, db)
        db = np.where(w.built_alpha[sl] > 0.5, w.built_db[sl] + 0.7 * w.tex_b[sl], db)
        db = np.where(w.pond[sl], -21.0 + 0.4 * w.tex_b[sl], db)
        db = np.where(w.channel[sl], -20.5 + 0.5 * w.tex_b[sl], db)
        db = np.where(w.sand[sl], -17.5, db)
        db = np.where(w.road[sl], -16.5, db)
        db = np.where(w.bridge[sl], -6.0, db)
        yy, xx = w.yy[sl], w.xx[sl]
        for st in self.sites:
            self._paint_s1(st, date, db, xx, yy, x0, y0, size)
        rr = np.random.default_rng(seed)
        L = 3.2
        sp = rr.gamma(L, 1.0 / L, db.shape).astype(np.float32)
        sp = ndi.gaussian_filter(sp, 0.55)
        db = db + 10 * np.log10(np.maximum(sp, 1e-3))
        g = np.clip((db + 24) / 22.0, 0, 1) ** 0.9
        if tint:
            rgb = np.stack([g * 0.88 + 0.03, g * 0.82 + 0.02, g * 1.0 + 0.06], -1)
        else:
            rgb = np.stack([g, g, g], -1)
        return np.clip(rgb, 0, 1)

    def _paint_s1(self, st: Site, date, db, xx, yy, x0, y0, size):
        R = max(st.w, st.h) * 0.9 + 30
        if abs(st.cx - (x0 + size / 2)) > R + size / 2 or abs(st.cy - (y0 + size / 2)) > R + size / 2:
            return
        u, v = _local(st, xx, yy)
        c = st.composition(date)
        raw = c["raw"]
        k = st.kind
        g = st.sar_gain
        foot = _rect(u, v, -st.w / 2, -st.h / 2, st.w, st.h)
        if k in ("construction", "clearance", "road") or (k == "other" and st.extra["sub"] == "dump"):
            clear = 1 - raw["veg"]
            if clear > 0.01:
                m = foot * clear
                db[:] = db * (1 - m) + (-15.2) * m
        if k == "construction":
            for j, (bx, by, bw, bh) in enumerate(st.buildings):
                slab = _rect(u, v, bx - 2, by - 2, bw + 4, bh + 4)
                if raw["found"] > 0.01 and raw["built"] < 0.999:
                    part = slab & (u < bx - 2 + (bw + 4) * min(1.0, raw["found"] * 1.05))
                    edge = part & ~_rect(u, v, bx + 1.5, by + 1.5, bw - 3, bh - 3)
                    db[:] = np.where(part, -12.0, db)
                    db[:] = np.where(edge, -15.2 + 9.0 * g, db)
                nb = len(st.buildings)
                p_b = float(np.clip(raw["built"] * nb - j, 0, 1))
                if p_b > 0:
                    roof = _rect(u, v, bx, by, bw * p_b, bh)
                    corner = roof & ((u < bx + 2) | (u > bx + bw * p_b - 2) | (v < by + 2) | (v > by + bh - 2))
                    db[:] = np.where(roof, -15.2 + 12.0 * g, db)
                    db[:] = np.where(corner, -15.2 + 16.5 * g, db)
                    sh = _rect(u, v, bx, by + bh, bw * p_b, 3.0)
                    db[:] = np.where(sh, -21.0, db)
            if raw["built"] > 0.15:
                yard = foot & (~np.any([_rect(u, v, b[0], b[1], b[2], b[3]) for b in st.buildings], axis=0))
                db[:] = np.where(yard, -13.5 + 4 * g * np.clip(raw["built"], 0, 1), db)
        elif k == "road":
            if raw["road"] > 0.01:
                paved = _rect(u, v, -st.w / 2, -2.6, st.w * raw["road"], 5.2)
                db[:] = np.where(paved, -16.8, db)
        elif k == "water":
            ell = ((u / (st.w / 2)) ** 2 + (v / (st.h / 2)) ** 2)
            r_ = self.sites_water_radius(st, raw["water"])
            db[:] = np.where(ell < r_ ** 2, -21.0, db)
        elif k == "other":
            sub = st.extra["sub"]
            if sub == "plastic" and raw["plastic"] > 0.01:
                rows = (np.sin(v * 1.8) > -0.2) & foot & (u < -st.w / 2 + st.w * raw["plastic"])
                db[:] = np.where(rows, -7.5, db)
            elif sub == "dump" and raw["dump"] > 0.01:
                mott = foot & (np.sin(u * 0.4) * np.cos(v * 0.5) > -0.3)
                db[:] = np.where(mott, -9.5, db)
        elif k == "candidate":
            st.extra["paint"](st, date, db, u, v, raw, "s1")


# ----------------------------------------------------------------------------- clouds
def cloud_field(seed, coverage, n=N):
    """Large-scale cloud alpha field (0..1) with the requested approximate coverage."""
    if coverage <= 0.01:
        return None
    f = fbm(256, [96, 40, 16, 6], [0.5, 0.3, 0.15, 0.05], seed)
    thr = np.quantile(f, 1 - coverage)
    a = smoothstep(thr, thr + 0.55, f)
    im = Image.fromarray(a.astype(np.float32), mode="F").resize((n, n), Image.BICUBIC)
    return np.clip(np.asarray(im, np.float32), 0, 1)


def to_jpeg(arr, path, out=320, q=82, sharpen=True):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    if out != arr.shape[0]:
        im = im.resize((out, out), Image.BICUBIC)
    if sharpen:
        im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=70, threshold=2))
    im.save(path, "JPEG", quality=q, optimize=True)
