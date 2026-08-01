#!/usr/bin/env python3
"""朔（新月）の一覧 new-moons.json を作る。

   使い方:  python3 tools/build-new-moons.py
            python3 tools/build-new-moons.py --from 2000 --to 2040

韓国の「손없는 날」は、旧暦の日付の一の位で決まる。

  음력 1・2 일 → 동쪽에 손      3・4 일 → 남쪽
  5・6 일     → 서쪽           7・8 일 → 북쪽
  9・0 일     → 손이 없다（어느 방향이든 좋다）

つまり要るのは旧暦の「日」だけで、月の番号は要らない。旧暦の日は
「その日を含む朔から数えて何日目か」なので、朔の日付さえあれば出る。
閏月をどこに置くかという旧暦のいちばん面倒な部分は、月の番号にしか
効かないので、この用途では避けて通れる。

朔とは月と太陽の視黄経が等しくなる瞬間のこと。build-solar-terms.py と
同じ DE421 から求める。境目は韓国標準時（UTC+9）の暦日で取る ──
旧暦は現地の暦日で数えるので、UTC で丸めると日付が 1 日ずれる朔が出る。

範囲を 1930〜2030 にしていないのは、この機能が「今日」と、せいぜい
引っ越し先を考えるくらいの近い未来にしか使われないため。生年月日を
遡る四柱とは要る範囲が違う。
"""
import argparse, gzip, json, os, sys
from datetime import datetime, timedelta, timezone

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

try:
    import numpy as np
    from skyfield.api import Loader
    from skyfield.framelib import ecliptic_frame
except ImportError as e:
    sys.exit(f"✗ {e.name} が要ります:  pip install skyfield numpy")

KST = timezone(timedelta(hours=9))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="y0", type=int, default=2000)
    ap.add_argument("--to",   dest="y1", type=int, default=2040)
    ap.add_argument("-o",     dest="out", default="new-moons.json")
    a = ap.parse_args()

    load = Loader(".ephem")
    eph = load("de421.bsp")
    ts = load.timescale()
    earth, sun, moon = eph["earth"], eph["sun"], eph["moon"]

    def elong(jd_tt):
        """月 − 太陽 の視黄経差を −180〜180 度で。配列可。"""
        t = ts.tt_jd(jd_tt)
        e = earth.at(t)
        _, slon, _ = e.observe(sun).apparent().frame_latlon(ecliptic_frame)
        _, mlon, _ = e.observe(moon).apparent().frame_latlon(ecliptic_frame)
        return ((mlon.degrees - slon.degrees + 180.0) % 360.0) - 180.0

    # --- 1) 半日刻みで差を出し、−→+ に変わる区間を拾う ------------------
    #
    # 月は 1 日に約 12 度ずつ太陽から離れるので、0 度を跨ぐ瞬間は
    # 半日の区間に高々 1 回しか入らない。
    #
    # 差は朔のあと 0 から増えて +180（望）で −180 に折り返し、負のまま
    # 0 に戻ってきて次の朔になる。つまり朔は「− から + へ」の交差で、
    # 「+ から − へ」は望の折り返し。ここを取り違えると、残差が
    # きっちり 180 度になって出てくる（実際そうなった）。
    jd0 = ts.utc(a.y0 - 1, 12, 1).tt
    jd1 = ts.utc(a.y1 + 1, 1, 31).tt
    grid = np.arange(jd0, jd1, 0.5)
    d = elong(grid)
    cross = np.where((d[:-1] < 0) & (d[1:] > 0))[0]
    lo, hi = grid[cross], grid[cross + 1]

    # --- 2) 二分法 -------------------------------------------------------
    # 区間は d(lo) < 0 < d(hi)。mid が負なら根は右側にある。
    for _ in range(32):
        mid = (lo + hi) / 2
        f = elong(mid)
        below = f < 0
        lo = np.where(below, mid, lo)
        hi = np.where(below, hi, mid)
    jd = (lo + hi) / 2

    # --- 3) 検算 ---------------------------------------------------------
    err = np.abs(elong(jd))
    worst = err.max() * 3600.0
    if worst > 1.0:
        sys.exit(f"✗ 朔の残差が大きすぎます: {worst:.3f} 秒角")

    gaps = np.diff(jd)
    if gaps.min() < 29.0 or gaps.max() > 30.5:
        sys.exit(f"✗ 朔の間隔が異常です: {gaps.min():.2f}〜{gaps.max():.2f} 日")

    # --- 4) 韓国標準時の暦日に落とす -------------------------------------
    #
    # 旧暦の 1 日は「朔が起きた日」。何時に起きたかは関係ないので、
    # KST の暦日だけを持つ。UTC の日付で持つと、KST で 0 時〜9 時に
    # 起きた朔が前日にずれる。
    t = ts.tt_jd(jd)
    days = []
    for y, mo, dd, h, mi, s in zip(*t.utc):
        u = datetime(int(y), int(mo), int(dd), int(h), int(mi), tzinfo=timezone.utc)
        days.append(u.astimezone(KST).date())

    days = [d for d in days if a.y0 <= d.year <= a.y1]
    if len(days) != len(set(days)):
        sys.exit("✗ 同じ日に朔が 2 回あります")

    base = days[0]
    deltas = [0] + [(days[i] - days[i - 1]).days for i in range(1, len(days))]
    if not all(29 <= x <= 30 for x in deltas[1:]):
        sys.exit(f"✗ 朔の間隔が 29〜30 日から外れました: {sorted(set(deltas[1:]))}")

    out = {
        "v": 1,
        "note": "New moons (朔), KST calendar dates. t is delta-encoded days from base.",
        "tz": "Asia/Seoul (UTC+9)",
        "base": base.isoformat(),
        "range": [a.y0, a.y1],
        "t": deltas,
    }
    raw = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    open(a.out, "w", encoding="utf-8").write(raw)

    b = raw.encode()
    print(f"{a.out} : {len(b)/1024:.1f} KB  (gzip {len(gzip.compress(b,9))/1024:.1f} KB)")
    print(f"  {a.y0}〜{a.y1}  朔 {len(days)} 件  残差 最大 {worst:.4f} 秒角")
    print(f"  先頭 {days[0]}  末尾 {days[-1]}  （韓国標準時の暦日）")


if __name__ == "__main__":
    main()
