"""Recompute the 'visual appearance' descriptors from the rendered S2 chips (centre crop = the site itself)
and patch them into the JSON files. Stand-in for an image-embedding model in the curated demo."""
import json, math, sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "backend" / "data"

def desc(path):
    a = np.asarray(Image.open(path).convert("RGB"), np.float32) / 255
    h = a.shape[0]
    c0, c1 = int(h * 0.30), int(h * 0.70)
    a = a[c0:c1, c0:c1]
    r_, g_, b_ = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.3 * r_ + 0.59 * g_ + 0.11 * b_
    mx, mn = a.max(-1), a.min(-1)
    sat = (mx - mn) / (mx + 1e-4)
    built = float(np.mean((lum > 0.62) & (sat < 0.16)))
    bare = float(np.mean((r_ > g_ + 0.04) & (sat > 0.14) & (lum > 0.42)))
    veg = float(np.mean(g_ > r_ + 0.05))
    gy, gx = np.gradient(lum)
    edge = float(np.mean(np.hypot(gx, gy)) * 10)
    return [built * 2.0, bare, veg, float(lum.mean()), float(lum.std()) * 2, edge]

def main():
    E = json.load(open(DATA / "events.json", encoding="utf-8"))
    C = json.load(open(DATA / "candidates.json", encoding="utf-8"))
    D = json.load(open(DATA / "decoys.json", encoding="utf-8"))
    ids = [e["id"] for e in E] + [c["id"] for c in C] + [d["id"] for d in D]
    raw = {i: desc(ROOT / "assets" / "chips" / i / "s2_46.jpg") for i in ids}
    M = np.array(list(raw.values()), np.float64)
    mu, sd = M.mean(0), M.std(0) + 1e-6
    z = {i: [round(float(x), 4) for x in (np.array(v) - mu) / sd] for i, v in raw.items()}
    for lst in (E, C, D):
        for x in lst:
            x["appearance"] = z[x["id"]]
    for name, obj in (("events.json", E), ("candidates.json", C), ("decoys.json", D)):
        json.dump(obj, open(DATA / name, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    ref = z["E-0472"]
    cos = lambda a, b: sum(x * y for x, y in zip(a, b)) / math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
    rows = sorted(((round((cos(ref, v) + 1) / 2 * 100), k) for k, v in z.items() if k != "E-0472"), reverse=True)
    print(rows[:14])

if __name__ == "__main__":
    main()
