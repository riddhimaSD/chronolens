"""
ChronoLens demo — dataset builder.

Builds ONE coherent synthetic archive:
  * a procedural AOI (river, parcels, roads, villages) — world.py
  * 26 Change Events, 9 suppressed candidates, 6 stable look-alike sites
  * 48 observations per sensor per entity (Sentinel-2-like and Sentinel-1-like)
  * imagery chips rendered from the same surface-state model as the series
  * a tiny CCDC-style detector run over the generated series to derive onset windows,
    persistence, sensor evidence states and confidence components

Everything is deterministic and SYNTHETIC. Nothing here is real Sentinel data.

Run:  python datagen/build.py            (full: data + imagery)
      python datagen/build.py --no-chips (data only, fast)
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from world import (N, PX_M, AOI_KM, World, Site, Renderer, cloud_field, to_jpeg, doy, vv_from_ndvi, ndvi_season, smoothstep)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "backend" / "data"
ASSETS = ROOT / "assets"
D = dt.date

# ----------------------------------------------------------------------------- time grid
T0 = D(2024, 7, 4)
STEPS = 48
S2_DATES = [T0 + dt.timedelta(days=15 * i) for i in range(STEPS)]
S1_DATES = [d + dt.timedelta(days=7) for d in S2_DATES]
DATA_END = S1_DATES[-1]
PROC_TS = "2026-06-17T04:12:09Z"
CHIP = 176            # world px per chip window (≈ 1.1 km)
CHIP_OUT = 320

# geo frame ------------------------------------------------------------------
CENTER = (77.560, 28.200)
D_LAT = AOI_KM / 111.0
D_LON = AOI_KM / (111.32 * math.cos(math.radians(CENTER[1])))
LON0, LAT0 = CENTER[0] - D_LON / 2, CENTER[1] + D_LAT / 2       # top-left
TR = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
X0_UTM, Y0_UTM = TR.transform(LON0, LAT0)


def px2ll(x, y):
    return (LON0 + x / N * D_LON, LAT0 - y / N * D_LAT)


def cloud_cov(d: dt.date) -> float:
    return {7: .60, 8: .68, 9: .50, 10: .16, 11: .05, 12: .05, 1: .06, 2: .07, 3: .10, 4: .09, 5: .13, 6: .30}[d.month]


def i_of(date: dt.date) -> int:
    return min(range(STEPS), key=lambda i: abs((S2_DATES[i] - date).days))


HAZE_IDX = [i for i in range(STEPS) if S2_DATES[i].year == 2026 and S2_DATES[i].month == 1][:2]
MISREG_IDX = [26, 28, 30]
SHADOW_IDX = 20

TYPE_LABEL = {"construction": "New construction", "clearance": "Vegetation clearance", "water_extent": "Water-extent variation",
              "road": "Road development", "other": "Surface change · unclassified"}
STAGE_ORDER = ["Vegetation", "Clearing", "Foundation", "Construction", "Completed"]


def d(s):
    return dt.date.fromisoformat(s)


# ----------------------------------------------------------------------------- site catalogue
def build_sites(w: World):
    r = np.random.default_rng(5)
    xs = w.river_x
    hw = w.river_hw
    sites: list[Site] = []
    meta: dict[str, dict] = {}

    def near(y_frac, dist_m, side):
        y = int(y_frac * N)
        tgt = dist_m / PX_M
        x = xs[y] + side * hw[y]
        step = 1
        while True:
            x += side * step
            if w.dist_edge[y, int(np.clip(x, 0, N - 1))] >= tgt:
                break
        return float(x), float(y)

    def add(sid, kind, pos, w_, h_, ang, sched, crop=0, sar_gain=1.0, extra=None, **m):
        i = len(sites)
        s = Site(sid, pos[0], pos[1], w_, h_, ang, kind, sched, crop=crop, sar_gain=sar_gain, seed=i, extra=extra)
        sites.append(s)
        meta[sid] = dict(kind=kind, **m)
        return s

    # ---- construction family (12) -------------------------------------------------
    def cons(sid, pos, onset, clear_d, found_lag, found_d, cons_lag, cons_d, **kw):
        o = d(onset)
        sched = dict(clear0=o, clear1=o + dt.timedelta(days=clear_d), found0=o + dt.timedelta(days=found_lag),
                     found1=o + dt.timedelta(days=found_lag + found_d), cons0=o + dt.timedelta(days=cons_lag),
                     cons1=o + dt.timedelta(days=cons_lag + cons_d))
        sz = (float(r.integers(64, 84)), float(r.integers(48, 60)))
        return add(sid, "construction", pos, sz[0], sz[1], float(r.uniform(-0.15, 0.15)), sched, **kw)

    E = {}
    E["E-0531"] = cons("E-0531", near(.06, 120, -1), "2025-02-24", 20, 50, 55, 115, 450, tier="near", hero=False, group="construction")
    E["E-0489"] = cons("E-0489", near(.19, 260, -1), "2025-01-14", 18, 55, 60, 125, 440, hero=True, group="construction")
    E["E-0472"] = cons("E-0472", near(.36, 180, -1), "2025-03-17", 8, 62, 60, 140, 170, hero=True, group="construction")
    E["E-0517"] = cons("E-0517", near(.48, 340, -1), "2024-10-05", 20, 50, 45, 100, 140, hero=False, group="construction")
    E["E-0503"] = cons("E-0503", near(.66, 430, +1), "2025-02-05", 22, 58, 60, 130, 460, sar_gain=0.65, hero=True, group="construction")
    E["E-0577"] = cons("E-0577", near(.78, 420, +1), "2025-10-08", 20, 60, 150, 300, 300, hero=False, group="construction")
    E["E-0591"] = cons("E-0591", near(.91, 260, +1), "2026-03-10", 30, 160, 60, 240, 300, hero=False, group="construction")
    E["E-0445"] = cons("E-0445", (0.14 * N, 0.20 * N), "2024-08-20", 20, 48, 45, 95, 150, hero=False, group="construction")
    E["E-0538"] = cons("E-0538", (0.86 * N, 0.55 * N), "2024-09-15", 22, 52, 50, 105, 165, hero=False, group="construction")
    E["E-0562"] = cons("E-0562", (0.30 * N, 0.72 * N), "2025-08-28", 20, 50, 50, 110, 280, hero=False, group="construction")
    E["E-0584"] = cons("E-0584", (0.72 * N, 0.16 * N), "2025-10-15", 22, 75, 110, 290, 300, hero=False, group="construction")
    E["E-0598"] = cons("E-0598", (0.20 * N, 0.42 * N), "2026-02-02", 28, 180, 60, 260, 300, hero=False, group="construction")

    # ---- clearance (4) -----------------------------------------------------------
    def clr(sid, pos, onset, days, crop=0, **m):
        o = d(onset)
        return add(sid, "clearance", pos, float(r.integers(52, 72)), float(r.integers(40, 54)), float(r.uniform(-.2, .2)),
                   dict(clear0=o, clear1=o + dt.timedelta(days=days)), crop=crop, **m)
    clr("E-0602", (0.08 * N, 0.37 * N), "2025-01-20", 12, crop=3, note="Orchard block felled")
    clr("E-0609", (0.80 * N, 0.66 * N), "2025-11-05", 18, crop=0, note="Field levelled and stripped")
    clr("E-0616", (0.40 * N, 0.90 * N), "2024-12-10", 30, crop=0, note="Fallow parcel stripped")
    clr("E-0623", (0.68 * N, 0.10 * N), "2026-02-18", 15, crop=3, note="Grove cleared")

    # ---- water (4) ------------------------------------------------------------------
    def wat(sid, pos, t0, t1, w0, w1, **m):
        return add(sid, "water", pos, 70.0, 54.0, 0.1, dict(t0=d(t0), t1=d(t1)), crop=4, extra=dict(water0=w0, water1=w1, water_frac=0.9), **m)
    wat("E-0410", (0.62 * N, 0.78 * N), "2025-08-25", "2025-09-20", 0.30, 1.0, note="Pond enlarged and embanked", direction="expansion")
    wat("E-0426", (0.24 * N, 0.58 * N), "2024-11-12", "2024-12-05", 1.0, 0.10, note="Pond drained", direction="contraction")
    wat("E-0433", (0.70 * N, 0.44 * N), "2025-02-08", "2025-03-10", 0.0, 1.0, note="New excavation filling with water", direction="expansion")
    wat("E-0451", (0.86 * N, 0.70 * N), "2025-12-03", "2026-01-05", 1.0, 0.20, note="Channel bend silting up", direction="contraction")

    # ---- roads (3) ---------------------------------------------------------------------
    def rd(sid, pos, ang, clear, pave, **m):
        return add(sid, "road", pos, 96.0, 15.0, ang, dict(clear0=d(clear[0]), clear1=d(clear[1]), pave0=d(pave[0]), pave1=d(pave[1])), **m)
    rd("E-0620", (0.68 * N, 0.23 * N), 0.10, ("2025-05-25", "2025-06-10"), ("2025-06-15", "2025-08-20"), note="New access road")
    rd("E-0627", (0.30 * N, 0.56 * N), -0.35, ("2025-10-08", "2025-10-25"), ("2025-10-30", "2025-12-20"), note="Bypass alignment")
    rd("E-0634", (0.86 * N, 0.48 * N), 0.70, ("2026-01-12", "2026-01-28"), ("2026-02-05", "2026-03-30"), note="Lane extension")

    # ---- other (3) -----------------------------------------------------------------------
    def oth(sid, pos, sub, t0, t1, **m):
        return add(sid, "other", pos, 60.0, 44.0, 0.05, dict(t0=d(t0), t1=d(t1)), extra=dict(sub=sub), **m)
    oth("E-0640", (0.18 * N, 0.74 * N), "plastic", "2025-02-25", "2025-03-30", note="Polytunnel field")
    oth("E-0647", (0.66 * N, 0.62 * N), "dump", "2025-09-30", "2025-11-15", note="Unclassified dumping ground")
    oth("E-0655", (0.78 * N, 0.945 * N), "orchard", "2025-07-10", "2025-08-25", note="New orchard planting", direction="appearance")

    # ---- suppressed candidates (9) -----------------------------------------------------------
    def cand(cid, pos, ang, w_, h_, fn=None, base=None, shift=0, paint=None, crop=0, **m):
        return add(cid, "candidate", pos, w_, h_, ang, {}, crop=crop,
                   extra=dict(fn=fn or (lambda dd: {}), base=base or {}, shift=shift, paint=paint or (lambda *a: None)), **m)

    def paint_shift(st, date, arr, u, v, raw, band):
        if band != "s2":
            return
        foot = (np.abs(u) < st.w / 2) & (np.abs(v) < st.h / 2)
        nd = st.ndvi_expected(date, st.extra["shift"])
        g = float(np.clip((nd - 0.10) / 0.52, 0, 1))
        colr = np.array([0.62, 0.52, 0.40], np.float32) * (1 - g) + np.array([0.22, 0.44, 0.17], np.float32) * g
        arr[:] = np.where(foot[..., None], colr, arr)

    def paint_shadow(st, date, arr, u, v, raw, band):
        if band == "s2" and date == S2_DATES[SHADOW_IDX]:
            e = ((u / (st.w * 0.9)) ** 2 + ((v + 6) / (st.h * 0.7)) ** 2) < 1
            arr[:] = np.where(e[..., None], arr * 0.42, arr)

    def paint_flood(st, date, arr, u, v, raw, band):
        e = ((u / (st.w / 2)) ** 2 + (v / (st.h / 2)) ** 2) < (0.25 + 0.9 * raw["water"]) ** 2
        if raw["water"] > 0.02:
            if band == "s2":
                arr[:] = np.where(e[..., None], np.array([0.16, 0.22, 0.24], np.float32), arr)
            else:
                arr[:] = np.where(e, -21.0, arr)

    def paint_bar(st, date, arr, u, v, raw, band):
        # sandbar on the river: the world's sand layer already exists; add a bright new bar
        if raw["sand"] > 0.02:
            e = ((u / (st.w / 2)) ** 2 + (v / (st.h / 2)) ** 2) < 1
            e = e & (np.sin(u * 0.15) * 0.25 + 0.45 > (1 - raw["sand"]) * 0.9 * 0.0 + np.abs(v) / (st.h / 2) * 0.5)
            if band == "s2":
                arr[:] = np.where(e[..., None], np.array([0.82, 0.76, 0.62], np.float32), arr)
            else:
                arr[:] = np.where(e, -17.5, arr)

    def paint_bare(st, date, arr, u, v, raw, band):
        foot = (np.abs(u) < st.w / 2) & (np.abs(v) < st.h / 2)
        veg = 1 - (raw["veg"] < 0.5) * 1.0
        if raw["veg"] < 0.98:
            m = foot * (1 - raw["veg"])
            if band == "s2":
                soil = np.array([0.70, 0.63, 0.53], np.float32)
                arr[:] = arr * (1 - m[..., None]) + soil * m[..., None]
                if raw["dump"] > 0.05:
                    gr = foot & (np.sin(u * 0.5) * np.cos(v * 0.6) > 0.1)
                    arr[:] = np.where(gr[..., None], arr * 0.75 + np.array([0.55, 0.55, 0.56], np.float32) * 0.25, arr)
            else:
                flat = -11.9 + 0.4 * np.sin(u * 0.3) * np.cos(v * 0.4)
                arr[:] = np.where(foot * (1 - raw["veg"]) > 0.5, flat, arr)

    def fn_flood(dd):
        a = Site.ramp(dd, D(2025, 8, 10), D(2025, 8, 25)) - Site.ramp(dd, D(2025, 9, 5), D(2025, 9, 28))
        return dict(water=max(0.0, a) * 0.95, veg=1.0)

    def fn_bar(dd):
        s = Site.ramp(dd, D(2025, 11, 10), D(2025, 12, 15))
        return dict(veg=0.0, water=1 - s, sand=s)

    def fn_clear70(dd):
        return dict(veg=1 - Site.ramp(dd, D(2026, 5, 18), D(2026, 5, 28)))

    def fn_sar(dd):
        p = Site.ramp(dd, D(2025, 11, 25), D(2025, 12, 12))
        return dict(veg=1 - p, dump=0.5625 * p)

    cand("C-0047", near(.125, 320, +1), 0.1, 60, 44, paint=paint_shadow, m_label="Cloud shadow")
    cand("C-0054", near(.25, 410, +1), -0.1, 62, 46, shift=+21, paint=paint_shift, crop=0)
    cand("C-0058", near(.42, 270, +1), 0.0, 60, 44)
    cand("C-0061", near(.46, 1600, +1), 0.2, 64, 46, shift=-35, paint=paint_shift, crop=0)
    cand("C-0063", near(.54, 60, +1), 0.0, 74, 56, fn=fn_flood, paint=paint_flood, crop=4)
    xr = float(xs[int(.60 * N)] + 0.3 * hw[int(.60 * N)])
    cand("C-0066", (xr, 0.60 * N), 0.05, 60, 26, fn=fn_bar, base=dict(veg=0.0, water=1.0), paint=paint_bar, crop=2)
    cand("C-0070", near(.72, 380, -1), 0.1, 60, 44, fn=fn_clear70, paint=paint_bare)
    cand("C-0072", near(.84, 450, -1), -0.1, 64, 48, fn=fn_sar, paint=paint_bare)
    cand("C-0075", near(.965, 900, -1), 0.0, 60, 44)

    # ---- stable look-alike sites (6) --------------------------------------------------------
    decoys = [
        dict(id="D-01", kind="warehouse", label="Established logistics yard", px=(0.26 * N, 0.335 * N)),
        dict(id="D-02", kind="kiln", label="Brick-kiln cluster", px=(0.78 * N, 0.20 * N)),
        dict(id="D-03", kind="village", label="Village block", px=(0.06 * N, 0.52 * N)),
        dict(id="D-04", kind="quarry", label="Gravel quarry pit", px=(0.92 * N, 0.90 * N)),
        dict(id="D-05", kind="estate", label="Old industrial estate", px=(0.90 * N, 0.62 * N)),
        dict(id="D-06", kind="bare", label="Fallow plot (bare, unchanged)", px=(0.12 * N, 0.92 * N)),
    ]
    return sites, meta, decoys


# ----------------------------------------------------------------------------- series + detection
def series_for(site: Site, cloud_frac, shadow_frac, seed):
    """Return (s2_obs, s1_obs) lists of dicts for a site."""
    rr = np.random.default_rng(seed)
    s2, s1 = [], []
    bias2 = rr.normal(0, 0.008)
    bias1 = rr.normal(0, 0.15)
    sig2, sig1 = 0.045, 0.8
    for i in range(STEPS):
        dd = S2_DATES[i]
        exp = site.s2_value(dd, baseline=True) + bias2
        val = site.s2_value(dd) + rr.normal(0, 0.024)
        cf = float(cloud_frac[i])
        reason = None
        usable = True
        if site.id == "C-0047" and i == SHADOW_IDX:
            reason, usable = "cloud_shadow", False
            val = val - 0.32
        elif site.id == "C-0058" and i in MISREG_IDX:
            reason, usable = "registration", False
            val = val - 0.14 - 0.03 * MISREG_IDX.index(i)
        elif i in HAZE_IDX:
            reason, usable = "haze", False
            val = val - 0.10 + rr.normal(0, 0.01)
        elif cf > 0.18:
            reason, usable = "cloud", False
            val = val * (1 - cf) + cf * 0.06
        q = 0.98 - 0.9 * cf if usable else 0.3 - 0.2 * cf
        s2.append(dict(i=i, date=dd.isoformat(), value=round(val, 4), expected=round(exp, 4), lo=round(exp - 3 * sig2, 4), hi=round(exp + 3 * sig2, 4),
                       z=round((val - exp) / sig2, 2), usable=usable, mask_reason=reason, cloud_frac=round(cf, 3), quality=round(max(q, 0.02), 3),
                       sigma=sig2, sensor="S2"))
        d1 = S1_DATES[i]
        exp1 = site.s1_value(d1, baseline=True) + bias1
        v1 = site.s1_value(d1) + rr.normal(0, 0.5)
        s1.append(dict(i=i, date=d1.isoformat(), value=round(v1, 3), expected=round(exp1, 3), lo=round(exp1 - 3 * sig1, 3), hi=round(exp1 + 3 * sig1, 3),
                       z=round((v1 - exp1) / sig1, 2), usable=True, mask_reason=None, cloud_frac=0.0, quality=0.96, sigma=sig1, orbit="ASC-034", sensor="S1"))
    return s2, s1


def fused(s2, s1):
    o = [dict(o, sensor="S2") for o in s2] + [dict(o, sensor="S1") for o in s1]
    o.sort(key=lambda x: x["date"])
    return o


def detect(s2, s1, true_onset: dt.date | None, k=3.0):
    """CCDC-style, run per sensor then merged: a sustained run of >=3 deviating usable observations
    spanning >=30 days, tolerating up to two consecutive in-band observations (seasonal flicker)."""
    if true_onset is None:
        return None
    iso = true_onset.isoformat()
    days = lambda a_, b_: (dt.date.fromisoformat(b_["date"]) - dt.date.fromisoformat(a_["date"])).days
    u2 = [o for o in s2 if o["usable"]]
    u1 = list(s1)

    def first_run(us):
        dev = [abs(o["z"]) >= k for o in us]
        for j, o in enumerate(us):
            if o["date"] < iso or not dev[j]:
                continue
            run, gap, last = 0, 0, j
            for q in range(j, len(us)):
                if dev[q]:
                    run += 1
                    gap = 0
                    last = q
                else:
                    gap += 1
                    if gap > 2:
                        break
            if run >= 3 and days(us[j], us[last]) >= 30:
                return j, last, run
        return None

    r2, r1 = first_run(u2), first_run(u1)
    if not r2 and not r1:
        return None
    runs = []
    if r2:
        runs.append((u2[r2[0]], u2[r2[1]], [o for o in u2[r2[0]:r2[1] + 1] if abs(o["z"]) >= k]))
    if r1:
        runs.append((u1[r1[0]], u1[r1[1]], [o for o in u1[r1[0]:r1[1] + 1] if abs(o["z"]) >= k]))
    first = min((r[0] for r in runs), key=lambda o: o["date"])
    last_dev = max((r[1] for r in runs), key=lambda o: o["date"])
    run_obs = sorted([o for r in runs for o in r[2]], key=lambda o: o["date"])
    fo = [o for o in fused(s2, s1) if o["usable"] and o["date"] < first["date"] and abs(o["z"]) < k]
    lc = fo[-1] if fo else None
    span = days(first, last_dev)
    return dict(first=first, last_clean=lc, run=len(run_obs), span=span, run_obs=run_obs, last_dev=last_dev)


def analyse(site: Site, s2, s1, true_onset):
    det = detect(s2, s1, true_onset)
    if not det:
        return None
    first, lc = det["first"], det["last_clean"]
    D1 = dt.date.fromisoformat(first["date"])
    Dl = dt.date.fromisoformat(lc["date"]) if lc else D1 - dt.timedelta(days=15)
    win = (D1 - Dl).days
    post2 = [o for o in s2 if o["date"] >= first["date"] and o["usable"]]
    post1 = [o for o in s1 if o["date"] >= first["date"] and o["usable"]]
    o_frac = float(np.mean([abs(o["z"]) >= 3 for o in post2])) if post2 else 0.0
    s_frac = float(np.mean([abs(o["z"]) >= 3 for o in post1])) if post1 else 0.0
    zs2 = [abs(o["z"]) for o in post2 if abs(o["z"]) >= 3]
    zs1 = [abs(o["z"]) for o in post1 if abs(o["z"]) >= 3]
    # sensor states
    if o_frac >= 0.7:
        st2 = "supports"
    elif o_frac >= 0.3:
        st2 = "ambiguous"
    else:
        st2 = "unavailable" if not post2 else "contradicts"
    if s_frac >= 0.7 and (np.mean(zs1) if zs1 else 0) >= 4.5:
        st1 = "supports"
    elif s_frac >= 0.15:
        st1 = "ambiguous"
    else:
        st1 = "contradicts" if o_frac >= 0.7 else "unavailable"
    n_s2_all = len([o for o in s2 if o["date"] >= first["date"]])
    usable_frac = len(post2) / max(n_s2_all, 1)
    peak = max([abs(o["z"]) for o in det["run_obs"]] or [3])
    persist_days = (dt.date.fromisoformat(det["last_dev"]["date"]) - D1).days
    return dict(det=det, first=first, last_clean=lc, first_date=D1, last_clean_date=Dl, window_days=win, o_frac=o_frac, s_frac=s_frac,
                st2=st2, st1=st1, usable_frac=usable_frac, peak=float(peak), persist_days=persist_days, persist_n=det["run"],
                mean_z1=float(np.mean(zs1)) if zs1 else 0.0, mean_z2=float(np.mean(zs2)) if zs2 else 0.0,
                n_post_s2=len(post2), n_post_s1=len(post1), n_masked_post=n_s2_all - len(post2))


def confidence(a, semantic):
    sar = {"supports": 1.0, "ambiguous": 0.45, "unavailable": 0.5, "contradicts": 0.1}[a["st1"]]
    opt = {"supports": min(1.0, a["o_frac"] + 0.05), "ambiguous": 0.55, "unavailable": 0.4, "contradicts": 0.1}[a["st2"]]
    comps = dict(
        persistence=min(1.0, a["persist_n"] / 12),
        deviation=min(1.0, a["peak"] / 10),
        optical=opt,
        sar=sar,
        quality=0.6 + 0.4 * a["usable_frac"],
        registration=0.95,
        semantic=semantic,
        onset=max(0.0, 1 - a["window_days"] / 60),
    )
    W = dict(persistence=.18, deviation=.12, optical=.14, sar=.16, quality=.10, registration=.06, semantic=.12, onset=.12)
    score = sum(comps[k] * W[k] for k in comps)
    return round(score, 3), {k: round(v, 3) for k, v in comps.items()}, W


def tier_of(sc):
    return "high" if sc >= 0.90 else "medium" if sc >= 0.65 else "low"


def stage_at(site: Site, date):
    if site.kind != "construction":
        return None
    st = site.state(date)
    if st["built"] >= 0.97:
        return "Completed"
    if st["built"] > 0:
        return "Construction"
    if st["found"] > 0:
        return "Foundation"
    if st["veg"] < 0.98:
        return "Clearing"
    return "Vegetation"


def state_sequence(site: Site, meta):
    """Ordered states with dates, only those reached before data end."""
    s = site.sched
    seq = []
    if site.kind == "construction":
        pts = [("Vegetation", T0, s["clear0"]), ("Clearing", s["clear0"], s["found0"]), ("Foundation", s["found0"], s["cons0"]),
               ("Construction", s["cons0"], s["cons1"]), ("Completed", s["cons1"], DATA_END)]
        for name, a, b in pts:
            if a <= DATA_END:
                seq.append(dict(state=name, start=a.isoformat(), end=min(b, DATA_END).isoformat()))
        return seq
    if site.kind == "clearance":
        return [dict(state="Vegetation", start=T0.isoformat(), end=s["clear0"].isoformat()), dict(state="Bare ground", start=s["clear0"].isoformat(), end=DATA_END.isoformat())]
    if site.kind == "water":
        a = "Water" if site.extra["water0"] > 0.5 else "Land"
        b = "Land" if site.extra["water1"] < site.extra["water0"] else "Water"
        if site.extra["water0"] < 0.5 and site.extra["water1"] > 0.5:
            a, b = "Dry ground", "Water body"
        if site.extra["water0"] > 0.5 and site.extra["water1"] < 0.5:
            a, b = "Water body", "Drying ground"
        if 0.2 < site.extra["water0"] < 0.5:
            a, b = "Small pond", "Enlarged pond"
        return [dict(state=a, start=T0.isoformat(), end=s["t0"].isoformat()), dict(state=b, start=s["t0"].isoformat(), end=DATA_END.isoformat())]
    if site.kind == "road":
        return [dict(state="Vegetation", start=T0.isoformat(), end=s["clear0"].isoformat()), dict(state="Cleared corridor", start=s["clear0"].isoformat(), end=s["pave0"].isoformat()),
                dict(state="Paved road", start=s["pave0"].isoformat(), end=DATA_END.isoformat())]
    sub = site.extra["sub"]
    names = dict(plastic=("Open field", "Polytunnels"), dump=("Vegetation", "Dumped material"), orchard=("Open field", "Young orchard"))[sub]
    return [dict(state=names[0], start=T0.isoformat(), end=s["t0"].isoformat()), dict(state=names[1], start=s["t0"].isoformat(), end=DATA_END.isoformat())]


def onset_of(site: Site):
    s = site.sched
    return s.get("clear0") or s.get("t0")


# ----------------------------------------------------------------------------- misc builders
def footprint_ll(site: Site):
    c, s = math.cos(site.ang), math.sin(site.ang)
    pts = []
    for (u, v) in [(-site.w / 2, -site.h / 2), (site.w / 2, -site.h / 2), (site.w / 2, site.h / 2), (-site.w / 2, site.h / 2), (-site.w / 2, -site.h / 2)]:
        x = site.cx + u * c - v * s
        y = site.cy + u * s + v * c
        pts.append(list(px2ll(x, y)))
    return dict(type="Polygon", coordinates=[pts])


def tile_id(site: Site):
    t = 256 / PX_M
    return f"T{int(site.cy // t):02d}-{int(site.cx // t):02d}"


def scenes():
    out = {"S2": [], "S1": []}
    for i, dd in enumerate(S2_DATES):
        sid = f"SYN_S2B_MSIL2A_{dd:%Y%m%d}T053649_R005_T43DEM"
        out["S2"].append(dict(scene_id=sid, sensor="S2", platform="Sentinel-2B (synthetic)", acquired=f"{dd.isoformat()}T05:36:49Z", level="L2A", orbit="R005",
                              crs="EPSG:32643", asset_ref=f"cog/{sid}.tif", sha256=f"synthetic-{i:03d}-s2"))
    for i, dd in enumerate(S1_DATES):
        sid = f"SYN_S1A_IW_GRDH_{dd:%Y%m%d}T005214_ASC034"
        out["S1"].append(dict(scene_id=sid, sensor="S1", platform="Sentinel-1A (synthetic)", acquired=f"{dd.isoformat()}T00:52:14Z", level="GRD→RTC σ⁰", orbit="ASC-034",
                              crs="EPSG:32643", asset_ref=f"cog/{sid}.tif", sha256=f"synthetic-{i:03d}-s1"))
    return out


PIPELINE = [
    ("ingest", "COG registered in local STAC catalogue (idempotent on scene id + sha256)"),
    ("cloud_masking", "SCL cloud / shadow / cirrus classes masked; per-tile clear fraction recorded"),
    ("radiometric_normalisation", "L2A surface reflectance with processing-baseline offset applied"),
    ("sar_calibration", "S1 GRD calibrated to σ⁰ (VV, VH)"),
    ("terrain_correction", "Radiometric terrain correction against DEM; same relative orbit only"),
    ("speckle_filtering", "Tile-level aggregation + temporal median"),
    ("co_registration", "Sub-pixel registration check (threshold 0.5 px); failures downgraded"),
    ("tile_representation", "256 m tile observation vectors (demo: curated series)"),
    ("temporal_baseline", "Location-specific harmonic seasonal baseline per tile"),
    ("change_detection", "CUSUM-style trigger + onset window from bracketing observations"),
    ("cross_sensor_verification", "Per-sensor evidence state: supports / ambiguous / contradicts / unavailable"),
    ("confidence_calibration", "Evidence-weighted confidence, tiered high / medium / low"),
]


def chip_window(site: Site):
    return int(np.clip(site.cx - CHIP / 2, 0, N - CHIP)), int(np.clip(site.cy - CHIP / 2, 0, N - CHIP))


# ----------------------------------------------------------------------------- main
def main(no_chips=False):
    t_start = time.time()
    DATA.mkdir(parents=True, exist_ok=True)
    print("building world ...")
    world = World()
    sites, meta, decoys = build_sites(world)
    world.add_decoy_features(decoys)
    by_id = {s.id: s for s in sites}

    # sanity: separation
    for a in range(len(sites)):
        for b in range(a + 1, len(sites)):
            dd_ = math.hypot(sites[a].cx - sites[b].cx, sites[a].cy - sites[b].cy)
            if dd_ < 110:
                print(f"  ! close pair {sites[a].id} / {sites[b].id}: {dd_:.0f}px")

    # cloud fields (512-res per S2 date) -----------------------------------------------------
    print("cloud fields ...")
    clouds512 = []
    for i, dd in enumerate(S2_DATES):
        cov = cloud_cov(dd) * (0.85 + 0.3 * ((i * 37) % 10) / 10)
        f = cloud_field(700 + i, cov, n=512) if cov > 0.01 else None
        clouds512.append(f)

    def site_cloud(site, i):
        f = clouds512[i]
        if f is None:
            return 0.0, 0.0
        x, y = int(site.cx / N * 512), int(site.cy / N * 512)
        r = 14
        win = f[max(0, y - r):y + r, max(0, x - r):x + r]
        return float(win.mean()), 0.0

    # per-site observation series ------------------------------------------------------------
    print("series + detection ...")
    scn = scenes()
    S = {}
    for k, site in enumerate(sites):
        cf = [site_cloud(site, i)[0] for i in range(STEPS)]
        s2, s1 = series_for(site, cf, None, seed=k * 17 + 3)
        for o in s2:
            o["scene_id"] = scn["S2"][o["i"]]["scene_id"]
        for o in s1:
            o["scene_id"] = scn["S1"][o["i"]]["scene_id"]
        S[site.id] = (s2, s1)

    # ---- analyse events ----------------------------------------------------------------
    events, cands, decoy_out = [], [], []
    hero_ids = {sid for sid, m in meta.items() if m.get("hero")}
    frames_avail = lambda sid, i: (i % 2 == 0) or sid in hero_ids
    semantic = {"E-0503": 0.70, "E-0472": 1.0, "E-0489": 0.88, "E-0517": 0.90, "E-0531": 0.84}
    site_no = 0
    ev_sites = [s for s in sites if s.id.startswith("E-")]
    ev_sites.sort(key=lambda s: s.id)
    for site in ev_sites:
        site_no += 1
        s2, s1 = S[site.id]
        onset = onset_of(site)
        a = analyse(site, s2, s1, onset)
        if not a:
            print("  ! no detection for", site.id)
            continue
        sem = semantic.get(site.id, 0.97 if site.kind in ("construction", "water") else 0.90)
        score, comps, W = confidence(a, sem)
        rdist = world.river_dist_m(site.cx, site.cy)
        typ = {"construction": "construction", "clearance": "clearance", "water": "water_extent", "road": "road", "other": "other"}[site.kind]
        stage = stage_at(site, DATA_END)
        seq = state_sequence(site, meta[site.id])
        m = meta[site.id]
        s2v = [o for o in s2 if o["date"] < a["first"]["date"] and o["usable"]]
        pre_nd = float(np.mean([o["value"] for o in s2v[-3:]])) if s2v else float(s2[0]["value"])
        post_nd = float(np.mean([o["value"] for o in s2[-6:] if o["usable"]] or [s2[-1]["value"]]))
        s1v = [o for o in s1 if o["date"] < a["first"]["date"]]
        pre_vv = float(np.mean([o["value"] for o in s1v[-3:]])) if s1v else s1[0]["value"]
        post_vv = float(np.mean([o["value"] for o in s1[-4:]]))
        onset_est = a["last_clean_date"] + (a["first_date"] - a["last_clean_date"]) / 2
        half = a["window_days"] / 2
        direction = m.get("direction") or {"construction": "appearance", "clearance": "disappearance", "road": "appearance", "other": "appearance", "water_extent": "expansion"}[typ]
        # checks -------------------------------------------------------------------------
        sarstate = a["st1"]
        checks = [
            dict(id="quality", label="Cloud / shadow quality acceptable", status="pass",
                 detail=f"{a['n_post_s2']} of {a['n_post_s2'] + a['n_masked_post']} post-onset S2 scenes usable ({round(a['usable_frac'] * 100)}%)" + (" · monsoon gap bridged by Sentinel-1" if a["n_masked_post"] >= 4 else "")),
            dict(id="registration", label="Registration quality acceptable", status="pass", detail="max offset 0.28 px · threshold 0.50 px"),
            dict(id="baseline", label="Seasonal baseline exceeded", status="pass",
                 detail=f"peak deviation {a['peak']:.1f}σ vs location-specific baseline · not explained by ±45 d phase shift"),
            dict(id="persistence", label="Persistent across observations", status="pass",
                 detail=f"{a['persist_n']} deviating observations over {a['persist_days']} days (min 3 obs / 30 d)"),
            dict(id="context", label="Temporary water excluded", status="pass",
                 detail=f"no reverting water signature (VV stays > −18 dB) · {round(rdist)} m from river edge"),
            dict(id="optical", label=f"Sentinel-2 {'structural transition' if typ == 'construction' else 'surface transition'}", status="pass" if a["st2"] == "supports" else "warn",
                 detail=f"NDVI {pre_nd:.2f} → {post_nd:.2f}" + (f" · {seq[-1]['state'].lower()}" if typ == 'construction' else "")),
            dict(id="sar", label="Sentinel-1 corroboration", status="pass" if sarstate == "supports" else "warn" if sarstate in ("ambiguous", "unavailable") else "fail",
                 detail=((f"VV {pre_vv:.1f} → {post_vv:.1f} dB · {a['s_frac'] * 100:.0f}% of post-onset scenes deviate" if sarstate == "supports" else
                          f"VV {pre_vv:.1f} → {post_vv:.1f} dB · response weak / inconsistent — confidence tier downgraded, event retained").replace("-", "−"))),
        ]
        # stage dates
        obs_first = a["first"]
        sums = dict(
            construction=f"Vegetation → bare → foundation → built structure, {round(rdist)} m from the river.",
            clearance=f"{m.get('note', 'Vegetation removed')}; persistent bare ground.",
            water_extent=f"{m.get('note', 'Water extent changed')}.",
            road=f"{m.get('note', 'Road corridor')}: cleared corridor then paved surface.",
            other=f"{m.get('note', 'Unclassified surface change')}.",
        )
        ev = dict(
            id=site.id, num=site.id[2:], site=f"Site {site_no:03d}", status="system_confirmed", type=typ, type_label=TYPE_LABEL[typ], direction=direction,
            stage=stage, stage_index=STAGE_ORDER.index(stage) if stage else None,
            summary=sums[typ], note=m.get("note"),
            geometry=footprint_ll(site), centroid=list(px2ll(site.cx, site.cy)), px=[round(site.cx, 1), round(site.cy, 1)],
            area_ha=round(site.w * site.h * PX_M * PX_M / 10000, 1), tile_id=tile_id(site),
            onset=dict(estimate=onset_est.isoformat(), half_width_days=round(half, 1), window_days=a["window_days"],
                       last_clean_pre=a["last_clean_date"].isoformat(), first_supporting=a["first_date"].isoformat(),
                       first_supporting_sensor=obs_first["sensor"], first_supporting_scene=obs_first["scene_id"],
                       last_clean_scene=a["last_clean"]["scene_id"] if a["last_clean"] else None),
            duration_days=a["persist_days"], persistence_obs=a["persist_n"], magnitude_sigma=round(a["peak"], 1),
            state_sequence=seq,
            confidence=dict(score=score, tier=tier_of(score), components=comps, weights=W),
            sensor_evidence=dict(s2=a["st2"], s1=a["st1"], s2_detail=f"{a['n_post_s2']} usable / {a['n_post_s2'] + a['n_masked_post']} post-onset scenes",
                                 s1_detail=f"{a['n_post_s1']} post-onset scenes · {a['s_frac'] * 100:.0f}% deviating"),
            checks=checks,
            context=dict(river_dist_m=round(rdist), bank="west" if site.cx < world.river_x[int(site.cy)] else "east",
                         prior_landcover={0: "cropland", 1: "sugarcane", 2: "scrub / fallow", 3: "orchard", 4: "floodplain vegetation"}[site.crop]),
            conventional=dict(label="CHANGE DETECTED", guess="Possible land-use change", delta=f"ΔNDVI {post_nd - pre_nd:+.2f}"),
            has_frames=dict(all=site.id in hero_ids),
            source_scene_ids=[a["first"]["scene_id"], a["last_clean"]["scene_id"] if a["last_clean"] else None, scn["S2"][-1]["scene_id"], scn["S1"][-1]["scene_id"]],
            hero=site.id in hero_ids,
        )
        ev["source_scene_ids"] = [x for x in ev["source_scene_ids"] if x]
        events.append(ev)
        S[site.id] = (s2, s1, a)

    # ---- similarity features (per event) ----------------------------------------------------
    for ev in events:
        s2, s1, a = S[ev["id"]]
        D1 = ev["onset"]["first_supporting"]
        d1 = dt.date.fromisoformat(D1)
        offs = [i * 20 for i in range(16)]
        curve, curve1 = [], []
        for off in offs:
            dd = d1 + dt.timedelta(days=off)
            if dd > DATA_END:
                curve.append(None)
                curve1.append(None)
                continue
            # nearest S2 usable obs / S1 obs
            u2 = [o for o in s2 if o["usable"]]
            o2 = min(u2, key=lambda o: abs((dt.date.fromisoformat(o["date"]) - dd).days))
            L = (o2["expected"] - o2["value"]) / max(o2["expected"] - 0.10, 0.15)
            o1 = min(s1, key=lambda o: abs((dt.date.fromisoformat(o["date"]) - dd).days))
            curve.append(round(float(np.clip(L, -0.5, 1.3)), 3))
            curve1.append(round(float(np.clip((o1["value"] - o1["expected"]) / 9.0, -1, 1.3)), 3))
        ev["facets"] = dict(curve=curve, curve1=curve1, peak=ev["magnitude_sigma"], type=ev["type"], river=ev["context"]["river_dist_m"], landcover=ev["context"]["prior_landcover"],
                            s1_lag=None)
        # S1 lead/lag relative to S2 first supporting
        s1dev = [o for o in s1 if o["date"] >= D1 and abs(o["z"]) >= 3]
        ev["facets"]["s1_amp"] = round(float(np.mean([abs(o["z"]) for o in s1dev])) if s1dev else 0.0, 1)

    # ---- rejected candidates ------------------------------------------------------------------
    cand_specs = {
        "C-0047": dict(reason="cloud_shadow", title="Cloud shadow", apparent="construction", failed="quality", status="rejected",
                       expl="A cloud shadow darkened one Sentinel-2 acquisition. The dark patch looks like a new built surface in a two-date comparison, but the scene is masked and Sentinel-1 shows no change.",
                       flags=["single observation", "S1 unchanged"], sev=0.88),
        "C-0054": dict(reason="seasonal_variation", title="Seasonal vegetation (early harvest)", apparent="construction", failed="baseline", status="rejected",
                       expl="Harvest arrived about three weeks earlier than the tile's mean calendar. The deviation is fully explained by a +21 day phase shift of the location-specific seasonal baseline and the field regrows on schedule.",
                       flags=["phase shift +21 d", "regrowth observed"], sev=0.71),
        "C-0058": dict(reason="registration_error", title="Registration inconsistency", apparent="construction", failed="registration", status="rejected",
                       expl="Three Sentinel-2 scenes from one relative orbit are offset by ~1.6 px. The apparent new edge is a misregistration artefact. Sentinel-1 and the other Sentinel-2 orbit show nothing.",
                       flags=["offset 1.6 px > 0.5 px", "orbit-specific"], sev=0.6),
        "C-0061": dict(reason="seasonal_variation", title="Seasonal vegetation (late sowing)", apparent="construction", failed="baseline", status="rejected",
                       expl="Sowing was delayed by about five weeks. The bare interval matches a −35 day phase shift of the seasonal cycle and vegetation returns to the baseline envelope.",
                       flags=["phase shift −35 d", "returns to envelope"], sev=0.64),
        "C-0063": dict(reason="temporary_flood", title="Temporary flood water", apparent="water", failed="context", status="rejected",
                       expl="A monsoon flood pulse: strong Sentinel-1 water signature for ~7 weeks that then recedes to the previous state. Classified as temporary water, not a structural or permanent change.",
                       flags=["water signature", "reverted by Sep"], sev=0.9),
        "C-0066": dict(reason="river_course_shift", title="Sandbar / river-course shift", apparent="construction", failed="context", status="rejected",
                       expl="Bright, persistent surface inside the river channel. Sentinel-1 shows a smooth, dark surface (sand), not the bright structural response of buildings, and the location lies within the river corridor.",
                       flags=["inside river corridor", "no structural SAR response"], sev=0.8),
        "C-0070": dict(reason="insufficient_persistence", title="Insufficient persistence", apparent="construction", failed="persistence", status="suppressed",
                       expl="A new bare patch appeared only three weeks before the end of the record. Fewer than three usable observations and less than 30 days of persistence: kept on watch, not alerted.",
                       flags=["22 days observed", "watch list"], sev=0.5),
        "C-0072": dict(reason="insufficient_sar", title="Insufficient SAR corroboration", apparent="construction", failed="sar", status="downgraded",
                       expl="Sentinel-2 shows a persistent bright bare surface, but Sentinel-1 backscatter is flat. There is no structural response, so the candidate is downgraded below the alert threshold.",
                       flags=["S2 supports", "S1 contradicts"], sev=0.62),
        "C-0075": dict(reason="haze_radiometric", title="Scene-wide haze / radiometric shift", apparent="construction", failed="quality", status="rejected",
                       expl="Two winter haze acquisitions shifted reflectance across the AOI. The regional co-anomaly test flags them because most tiles deviated simultaneously, so the candidate is not treated as local change.",
                       flags=["81% of AOI tiles deviate", "2 scenes"], sev=0.55),
    }
    CHECK_ORDER = [("quality", "Cloud / shadow quality acceptable"), ("registration", "Registration quality acceptable"), ("baseline", "Seasonal baseline exceeded"),
                   ("persistence", "Persistent across observations"), ("context", "Temporary water excluded"), ("optical", "Sentinel-2 structural transition"), ("sar", "Sentinel-1 corroboration")]
    for cid, sp in cand_specs.items():
        site = by_id[cid]
        s2, s1 = S[cid]
        rdist = world.river_dist_m(site.cx, site.cy)
        # evidence text per candidate
        ev_txt = {
            "C-0047": {"quality": "SCL/shadow test: shadow probability 0.81 on 2025-04-30 scene · 1 observation only"},
            "C-0054": {"baseline": "deviation reaches +4.4σ for 3 obs but a +21 d phase shift of the baseline leaves RMS residual 0.9σ (< 1.5σ) → seasonal"},
            "C-0058": {"registration": "estimated offset 1.6 px on 3 scenes (relative orbit R005) · threshold 0.5 px"},
            "C-0061": {"baseline": "a −35 d phase shift leaves RMS residual 1.1σ (< 1.5σ) → seasonal; vegetation returns to envelope"},
            "C-0063": {"context": "VV drops to −21 dB for 4 S1 scenes then returns within 32 days · MNDWI > 0 · water signature → temporary water"},
            "C-0066": {"context": "inside river corridor mask · VV stays dark (−17.5 dB) → smooth sand, no built response"},
            "C-0070": {"persistence": "2 usable obs per sensor over 22 days · required ≥ 3 obs and ≥ 30 days"},
            "C-0072": {"sar": "VV −11.9 dB vs baseline −12.0 dB (flat) while NDVI drops to 0.12 → S1 contradicts"},
            "C-0075": {"quality": "regional co-anomaly: 81% of AOI tiles deviate on 2026-01-06 and 2026-01-21 → scene-wide radiometric shift"},
        }[cid]
        checks = []
        failed = sp["failed"]
        hit = False
        for cid_, label in CHECK_ORDER:
            if hit:
                st, det = "skipped", "not evaluated (candidate already stopped)"
            elif cid_ == failed:
                st = "fail" if sp["status"] != "downgraded" else "warn"
                det = ev_txt.get(cid_, "")
                hit = True
            else:
                st = "pass"
                det = {"quality": "usable observations available", "registration": "offset within 0.5 px", "baseline": "deviation beyond seasonal envelope",
                       "persistence": "deviation held across observations", "context": "no reverting-water or river-corridor signature"}.get(cid_, "")
            checks.append(dict(id=cid_, label=label, status=st, detail=det))
        # stats: conventional two-date diff
        ia = i_of(D(2025, 2, 20)) if cid not in ("C-0075", "C-0070", "C-0072") else i_of(D(2025, 9, 1)) if cid == "C-0072" else i_of(D(2025, 12, 20)) if cid == "C-0075" else i_of(D(2026, 4, 25))
        s2v = [o["value"] for o in s2]
        ib = int(np.argmin([o["value"] if o["i"] > ia else 9 for o in s2]))
        if cid == "C-0047":
            ia, ib = SHADOW_IDX - 2, SHADOW_IDX
        if cid == "C-0058":
            ia, ib = MISREG_IDX[0] - 2, MISREG_IDX[0]
        if cid == "C-0075":
            ia, ib = HAZE_IDX[0] - 2, HAZE_IDX[0]
        if cid == "C-0072":
            ia, ib = i_of(D(2025, 10, 20)), i_of(D(2026, 1, 20))
        if cid == "C-0070":
            ia, ib = 44, 47
        if cid == "C-0063":
            ia, ib = i_of(D(2025, 7, 20)), i_of(D(2025, 8, 20))
        if cid == "C-0066":
            ia, ib = i_of(D(2025, 10, 1)), i_of(D(2026, 1, 20))
        if cid == "C-0054":
            ia, ib = i_of(D(2025, 3, 20)), i_of(D(2025, 4, 24))
        if cid == "C-0061":
            ia, ib = i_of(D(2025, 8, 20)), i_of(D(2025, 9, 20))
        dnd = s2[ib]["value"] - s2[ia]["value"]
        guess = {"C-0063": "Possible new water body", "C-0054": "Possible vegetation loss / land-use change", "C-0061": "Possible vegetation loss / land-use change"}.get(cid, "Possible new built surface / land-use change")
        cand = dict(
            id=cid, num=cid[2:], status=sp["status"], reason_code=sp["reason"], title=sp["title"], apparent_type=sp["apparent"], failed_step=failed,
            explanation=sp["expl"], flags=sp["flags"], geometry=footprint_ll(site), centroid=list(px2ll(site.cx, site.cy)), px=[round(site.cx, 1), round(site.cy, 1)],
            checks=checks, context=dict(river_dist_m=round(rdist), bank="west" if site.cx < world.river_x[int(site.cy)] else "east"),
            conventional=dict(label="CHANGE DETECTED", guess=guess, delta=f"ΔNDVI {dnd:+.2f}", date_a=s2[ia]["date"], date_b=s2[ib]["date"], ia=ia, ib=ib),
            candidate_score=round(sp["sev"] * 0.0 + {"C-0072": 0.42, "C-0070": 0.33, "C-0066": 0.38, "C-0063": 0.29, "C-0054": 0.31, "C-0061": 0.27, "C-0047": 0.22, "C-0058": 0.24, "C-0075": 0.2}[cid], 2),
            promotable=True, status_label={"rejected": "SUPPRESSED", "suppressed": "SUPPRESSED", "downgraded": "DOWNGRADED"}[sp["status"]],
            tile_id=tile_id(site),
        )
        cands.append(cand)

    # ---- decoys ---------------------------------------------------------------------------------------
    for dcy in decoys:
        cx, cy = dcy["px"]
        rr = np.random.default_rng(int(cx))
        s2, s1 = [], []
        crop = 0
        bias2 = 0.0
        for i in range(STEPS):
            dd = S2_DATES[i]
            e = 0.10 if dcy["kind"] in ("warehouse", "estate", "kiln", "village", "quarry") else float(ndvi_season(np.array([doy(dd)], np.float32), np.array([0]), np.array([0.0], np.float32), np.array([1.0], np.float32))[0])
            base_vv = -5.0 if dcy["kind"] in ("warehouse", "estate", "kiln", "village") else -14.8 if dcy["kind"] in ("quarry",) else vv_from_ndvi(e)
            cf = float(clouds512[i][int(cy / N * 512), int(cx / N * 512)]) if clouds512[i] is not None else 0.0
            usable = cf <= 0.18 and i not in HAZE_IDX
            v = e + rr.normal(0, 0.02)
            if not usable:
                v = v * (1 - cf) + cf * 0.06 if i not in HAZE_IDX else v - 0.1
            sig = 0.045
            s2.append(dict(i=i, date=dd.isoformat(), value=round(v, 4), expected=round(e, 4), lo=round(e - 3 * sig, 4), hi=round(e + 3 * sig, 4), z=round((v - e) / sig, 2), usable=usable,
                           mask_reason=None if usable else ("haze" if i in HAZE_IDX else "cloud"), cloud_frac=round(cf, 3), quality=0.9 if usable else 0.2, sigma=sig))
            s1.append(dict(i=i, date=S1_DATES[i].isoformat(), value=round(base_vv + rr.normal(0, 0.5), 3), expected=round(base_vv, 3), lo=round(base_vv - 2.4, 3), hi=round(base_vv + 2.4, 3),
                           z=0.0, usable=True, mask_reason=None, cloud_frac=0.0, quality=0.96, sigma=0.8, orbit="ASC-034"))
        for o in s2:
            o["scene_id"] = scn["S2"][o["i"]]["scene_id"]
        for o in s1:
            o["scene_id"] = scn["S1"][o["i"]]["scene_id"]
        S[dcy["id"]] = (s2, s1)
        ll = px2ll(cx, cy)
        decoy_out.append(dict(id=dcy["id"], label=dcy["label"], kind=dcy["kind"], centroid=list(ll), px=[round(cx, 1), round(cy, 1)],
                              geometry=dict(type="Polygon", coordinates=[[list(px2ll(cx + a, cy + b)) for a, b in [(-30, -20), (30, -20), (30, 20), (-30, 20), (-30, -20)]]]),
                              history="stable · no change event in 24 months"))

    # ------------------------------------------------------------------- imagery
    frames_index = {}
    appearance = {}
    if not no_chips:
        chip_root = ASSETS / "chips"
        if chip_root.exists():
            shutil.rmtree(chip_root)
        chip_root.mkdir(parents=True)
        rd = Renderer(world, sites, scn)
        all_ids = [s.id for s in sites] + [x["id"] for x in decoy_out]
        pos = {s.id: chip_window(s) for s in sites}
        for x in decoy_out:
            pos[x["id"]] = (int(np.clip(x["px"][0] - CHIP / 2, 0, N - CHIP)), int(np.clip(x["px"][1] - CHIP / 2, 0, N - CHIP)))
        for i in all_ids:
            (chip_root / i).mkdir()
            frames_index[i] = dict(s2=[], s1=[])
        print("rendering chips ...")
        last_frames = {}
        t = time.time()
        for i in range(STEPS):
            dd2, dd1 = S2_DATES[i], S1_DATES[i]
            cf_field = None
            if clouds512[i] is not None:
                im = Image.fromarray(clouds512[i].astype(np.float32), mode="F").resize((N, N), Image.BICUBIC)
                cf_field = np.clip(np.asarray(im, np.float32), 0, 1)
            haze = 0.30 if i in HAZE_IDX else 0.0
            for sid in all_ids:
                is_ev = sid in by_id
                want = frames_avail(sid, i) if is_ev else (i in (0, 46) or i in HAZE_IDX[:0])
                if sid.startswith("D-"):
                    want = i in (0, 24, 46)
                if not want:
                    continue
                x0, y0 = pos[sid]
                mis = (1.6, 0.9) if (sid == "C-0058" and i in MISREG_IDX) else (0.0, 0.0)
                if i in MISREG_IDX and sid != "C-0058":
                    mis = (0.0, 0.0)
                a2 = rd.s2(x0, y0, CHIP, dd2, cloud=cf_field, haze=haze, misreg=mis, seed=i * 101 + hash(sid) % 97)
                to_jpeg(a2, chip_root / sid / f"s2_{i:02d}.jpg", out=CHIP_OUT)
                a1 = rd.s1(x0, y0, CHIP, dd1, seed=i * 131 + hash(sid) % 89)
                to_jpeg(a1, chip_root / sid / f"s1_{i:02d}.jpg", out=CHIP_OUT)
                frames_index[sid]["s2"].append(i)
                frames_index[sid]["s1"].append(i)
                if i == 46 or (sid.startswith("D-") and i == 46):
                    last_frames[sid] = a2
            if i % 6 == 0:
                print(f"  date {i + 1}/{STEPS}  {time.time() - t:.0f}s")
        # appearance descriptors from the final clean S2 chip
        def desc(a):
            r_, g_, b_ = a[..., 0], a[..., 1], a[..., 2]
            lum = (0.3 * r_ + 0.59 * g_ + 0.11 * b_)
            mx, mn = a.max(-1), a.min(-1)
            sat = (mx - mn) / (mx + 1e-4)
            built = float(np.mean((lum > 0.60) & (sat < 0.16)))
            bare = float(np.mean((r_ > g_ + 0.04) & (sat > 0.14) & (lum > 0.42)))
            veg = float(np.mean(g_ > r_ + 0.05))
            water = float(np.mean((lum < 0.30) & (b_ >= r_ - 0.02)))
            gy, gx = np.gradient(lum)
            edge = float(np.mean(np.hypot(gx, gy)) * 10)
            return [built, bare, veg, water, float(lum.mean()), float(lum.std()), edge]
        for sid, a in last_frames.items():
            appearance[sid] = desc(a)
        # base maps
        print("base maps ...")
        base2 = rd.s2(0, 0, N, T0, seed=1)
        base1 = rd.s1(0, 0, N, S1_DATES[0], seed=2)
        (ASSETS / "maps").mkdir(parents=True, exist_ok=True)
        to_jpeg(base2, ASSETS / "maps" / "s2.jpg", out=2048, q=84, sharpen=False)
        to_jpeg(base1, ASSETS / "maps" / "s1.jpg", out=2048, q=84, sharpen=False)
        fused_ = np.clip(0.62 * base2 + 0.38 * base1 * np.array([0.9, 0.85, 1.25], np.float32) + 0.0, 0, 1)
        to_jpeg(fused_, ASSETS / "maps" / "fused.jpg", out=2048, q=84, sharpen=False)
    else:
        for sid in [s.id for s in sites] + [x["id"] for x in decoy_out]:
            frames_index[sid] = dict(s2=[i for i in range(STEPS) if frames_avail(sid, i)], s1=[i for i in range(STEPS) if frames_avail(sid, i)])

    # ------------------------------------------------------------------- appearance vectors
    ids_app = list(appearance.keys())
    if ids_app:
        M = np.array([appearance[i] for i in ids_app], np.float64)
        mu, sd = M.mean(0), M.std(0) + 1e-6
        Z = (M - mu) / sd
        for i, sid in enumerate(ids_app):
            appearance[sid] = [round(float(x), 4) for x in Z[i]]

    # ------------------------------------------------------------------- strands + series output
    def strand_of(sid, cp_i=None):
        s2 = S[sid][0]
        lo = min(o["lo"] for o in s2)
        hi = max(o["hi"] for o in s2)
        norm = lambda v: round((v - lo) / max(hi - lo, 1e-6), 3)
        vals = []
        prev = None
        for o in s2:
            v = o["value"] if o["usable"] else None
            vals.append(v)
        # linear fill for glyph
        idx = [i for i, v in enumerate(vals) if v is not None]
        filled = np.interp(range(STEPS), idx, [vals[i] for i in idx]).tolist() if idx else [0] * STEPS
        return dict(v=[norm(x) for x in filled], e=[norm(o["expected"]) for o in s2], lo=[norm(o["lo"]) for o in s2], hi=[norm(o["hi"]) for o in s2], cp=cp_i)

    ev_map = {e["id"]: e for e in events}
    series_out = {}
    for sid, tup in S.items():
        s2, s1 = tup[0], tup[1]
        a = tup[2] if len(tup) > 2 else None
        cp = None
        if a:
            cp = i_of(a["first_date"])
        # frame availability -> attach
        fs = frames_index.get(sid, dict(s2=[], s1=[]))
        for o in s2:
            o["frame"] = o["i"] if o["i"] in fs["s2"] else None
        for o in s1:
            o["frame"] = o["i"] if o["i"] in fs["s1"] else None
        series_out[sid] = dict(s2=s2, s1=s1, cp=cp, strand=strand_of(sid, cp))
        if sid in ev_map:
            ev_map[sid]["strand"] = series_out[sid]["strand"]
            ev_map[sid]["cp_index"] = cp
            ev_map[sid]["appearance"] = appearance.get(sid)
    # onset-derived agreement segments per step
    for sid, so in series_out.items():
        seg = []
        for i in range(STEPS):
            a2, a1 = so["s2"][i], so["s1"][i]
            d2 = a2["usable"] and abs(a2["z"]) >= 3
            d1 = abs(a1["z"]) >= 3
            if d2 and d1:
                seg.append("both")
            elif d1 and not a2["usable"]:
                seg.append("s1_continuity")
            elif d1:
                seg.append("s1")
            elif d2:
                seg.append("s2")
            else:
                seg.append("none")
        so["agreement"] = seg
    for c in cands:
        c["strand"] = series_out[c["id"]]["strand"]
        c["appearance"] = appearance.get(c["id"])
        # flagged indices for strand marker
        so = series_out[c["id"]]
        dv = [o["i"] for o in so["s2"] if abs(o["z"]) >= 3]
        c["flag_index"] = dv[0] if dv else None
        c["strand"]["cp"] = c["flag_index"]
    for x in decoy_out:
        x["strand"] = series_out[x["id"]]["strand"]
        x["appearance"] = appearance.get(x["id"])

    # ------------------------------------------------------------------- AOI
    tri = lambda x0, y0: px2ll(x0, y0)
    ys = np.arange(0, N + 1, 24)
    river_line = [list(px2ll(float(np.interp(y, np.arange(N), world.river_x)), float(min(y, N - 1)))) for y in ys]
    xs = np.arange(0, N + 1, 24)
    hy = [list(px2ll(float(x), 0.30 * N + 0.022 * N * math.sin(2 * math.pi * x / N * 1.7 + 0.5))) for x in xs]
    rx = [list(px2ll(0.21 * N + 0.02 * N * math.sin(2 * math.pi * y / N * 2.2 + 1.3), float(y))) for y in ys]
    dg = [list(px2ll(0.04 * N + t * (0.97 - 0.04) * N, 0.86 * N + t * (0.62 - 0.86) * N)) for t in np.linspace(0, 1, 30)]
    aoi = dict(
        id="AOI-01", name="AOI-01 · Demo floodplain (synthetic)", crs="EPSG:32643", size_km=AOI_KM, gsd_note="synthetic scene, 6.25 m world grid",
        transform=[X0_UTM, PX_M, 0.0, Y0_UTM, 0.0, -PX_M], center=list(CENTER),
        bounds=[LON0, LAT0 - D_LAT, LON0 + D_LON, LAT0],
        image_coordinates=[[LON0, LAT0], [LON0 + D_LON, LAT0], [LON0 + D_LON, LAT0 - D_LAT], [LON0, LAT0 - D_LAT]],
        tile_size_m=256, tiles=int((AOI_KM * 1000 / 256) ** 2),
        time=dict(start=S2_DATES[0].isoformat(), end=DATA_END.isoformat(), s2_dates=[x.isoformat() for x in S2_DATES], s1_dates=[x.isoformat() for x in S1_DATES]),
        river=dict(type="LineString", coordinates=river_line),
        roads=[dict(name="Highway", type="LineString", coordinates=hy), dict(name="North–south road", type="LineString", coordinates=rx), dict(name="District road", type="LineString", coordinates=dg)],
        basemaps=dict(s2="/assets/maps/s2.jpg", s1="/assets/maps/s1.jpg", fused="/assets/maps/fused.jpg"),
        haze_idx=HAZE_IDX,
    )

    def dump(name, obj):
        with open(DATA / name, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))

    dump("aoi.json", aoi)
    dump("events.json", events)
    dump("candidates.json", cands)
    dump("decoys.json", decoy_out)
    dump("series.json", series_out)
    dump("scenes.json", scn)
    dump("frames.json", frames_index)
    dump("pipeline.json", [dict(step=a, description=b) for a, b in PIPELINE])
    dump("audit_seed.json", [
        dict(ts="2026-06-12T09:41:22Z", analyst="analyst.k", event_id="E-0445", decision="confirm", reason="", note="Verified against optical + SAR history", prev_status="system_confirmed", query_id=None),
        dict(ts="2026-06-12T09:44:07Z", analyst="analyst.k", event_id="E-0538", decision="confirm", reason="", note="", prev_status="system_confirmed", query_id=None),
    ])
    if not no_chips:
        import appearance
        appearance.main()      # visual-appearance descriptors from the centre crop of the final S2 chips
    print(f"done in {time.time() - t_start:.0f}s · events={len(events)} candidates={len(cands)} decoys={len(decoy_out)}")
    for e in events:
        if e["type"] == "construction":
            print(f"  {e['id']} {e['stage']:<12} conf={e['confidence']['score']:.2f} {e['confidence']['tier']:<6} onset={e['onset']['estimate']} ±{e['onset']['half_width_days']:.0f}d "
                  f"river={e['context']['river_dist_m']}m s2={e['sensor_evidence']['s2']} s1={e['sensor_evidence']['s1']} persist={e['persistence_obs']}")
    for e in events:
        if e["type"] != "construction":
            print(f"  {e['id']} {e['type']:<13} conf={e['confidence']['score']:.2f} {e['confidence']['tier']:<6} s2={e['sensor_evidence']['s2']} s1={e['sensor_evidence']['s1']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-chips", action="store_true")
    args = ap.parse_args()
    main(no_chips=args.no_chips)
