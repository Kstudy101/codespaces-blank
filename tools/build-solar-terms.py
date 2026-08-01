#!/usr/bin/env python3
"""24節気の時刻表 solar-terms.json を作る。

   使い方:  python3 tools/build-solar-terms.py
            python3 tools/build-solar-terms.py --from 1930 --to 2030

四柱のうち外部データが要るのは年柱と月柱だけで、必要なのは節気の時刻のみ。
日柱は 60 日周期の算術で出るので表は要らない（docs/plan-fortune-content.md §3）。

節気とは太陽の視黄経が 15 度の倍数になる瞬間のこと。それを JPL の暦（DE421）
から直接求める。KASI API のような外部サービスは使わない ── 鍵も秘密情報も
要らず、結果は JSON に固定して commit する。build-kanji-json.py と同じで、
ローカルで一度動かし、出力をリポジトリに置く方式。

初回だけ de421.bsp（約 17MB）を自動取得して .ephem/ に置く。
.ephem/ は .gitignore 済みで、配信もされない。

出力は UTC。日本標準時に固定しないのは、韓国の標準時が UTC+8:30 だった
時期（1908-1912、1954-1961）があり、生年月日をどの地方時で読むかは
利用側で決める必要があるため。ここで +9 を焼き込むとその判断ができなくなる。
"""
import argparse, gzip, json, os, sys
from datetime import datetime, timezone

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

try:
    import numpy as np
    from skyfield.api import Loader
    from skyfield.framelib import ecliptic_frame
except ImportError as e:
    sys.exit(f"✗ {e.name} が要ります:  pip install skyfield numpy")

# 黄経 15 度ごとの節気。index = 黄経 / 15。0 = 春分。
# 節（月の切り替わり）は index が奇数、中気は偶数。
TERMS = [
    # 黄経  韓国語    日本語    節?
    (  0, "춘분",  "春分",  False),
    ( 15, "청명",  "清明",  True ),
    ( 30, "곡우",  "穀雨",  False),
    ( 45, "입하",  "立夏",  True ),
    ( 60, "소만",  "小満",  False),
    ( 75, "망종",  "芒種",  True ),
    ( 90, "하지",  "夏至",  False),
    (105, "소서",  "小暑",  True ),
    (120, "대서",  "大暑",  False),
    (135, "입추",  "立秋",  True ),
    (150, "처서",  "処暑",  False),
    (165, "백로",  "白露",  True ),
    (180, "추분",  "秋分",  False),
    (195, "한로",  "寒露",  True ),
    (210, "상강",  "霜降",  False),
    (225, "입동",  "立冬",  True ),
    (240, "소설",  "小雪",  False),
    (255, "대설",  "大雪",  True ),
    (270, "동지",  "冬至",  False),
    (285, "소한",  "小寒",  True ),
    (300, "대한",  "大寒",  False),
    (315, "입춘",  "立春",  True ),
    (330, "우수",  "雨水",  False),
    (345, "경칩",  "啓蟄",  True ),
]

# 節 12 個が 12 支の月を切る。立春(315°)から寅月。
# index が奇数のものを立春から順に並べたもの。
MONTH_BRANCH = ["인", "묘", "진", "사", "오", "미", "신", "유", "술", "해", "자", "축"]

def main():
    ap = argparse.ArgumentParser()
    # 対応したい生年は 1930〜2030 だが、表はその外側まで作る。
    # 月柱はその生年月日を挟む「節」が要る。1930-01-03 生まれを出すには
    # 1929-12-07 の大雪が要るので、1930 始まりでは足りない。
    ap.add_argument("--from", dest="y0", type=int, default=1929)
    ap.add_argument("--to",   dest="y1", type=int, default=2031)
    ap.add_argument("-o",     dest="out", default="solar-terms.json")
    a = ap.parse_args()

    load = Loader(".ephem")
    eph = load("de421.bsp")
    ts = load.timescale()
    earth, sun = eph["earth"], eph["sun"]

    def sun_lon(jd_tt):
        """視黄経（真の分点・黄道、光行差と章動込み）を度で返す。配列可。"""
        _, lon, _ = earth.at(ts.tt_jd(jd_tt)).observe(sun).apparent() \
                         .frame_latlon(ecliptic_frame)
        return lon.degrees

    # --- 1) 1 日刻みで太陽黄経を出し、連続化する -----------------------
    #
    # 黄経は 1 日に約 0.9856 度しか動かないので、15 度の境界は必ず
    # どこか 1 日の区間にちょうど 1 回だけ入る。unwrap で 360 度の
    # 折り返しを外すと単調増加になり、境界の探索が searchsorted で済む。
    jd0 = ts.utc(a.y0, 1, 1).tt
    jd1 = ts.utc(a.y1 + 1, 1, 1).tt
    grid = np.arange(jd0, jd1 + 1.0, 1.0)
    unwrapped = np.degrees(np.unwrap(np.radians(sun_lon(grid))))
    if not np.all(np.diff(unwrapped) > 0):
        sys.exit("✗ 太陽黄経が単調増加になりません。unwrap か格子が壊れています")

    targets = np.arange(np.ceil(unwrapped[0] / 15) * 15,
                        unwrapped[-1], 15.0)
    idx = np.searchsorted(unwrapped, targets)
    lo, hi = grid[idx - 1], grid[idx]

    # --- 2) 二分法で境界時刻を詰める ------------------------------------
    #
    # 1 日幅を 32 回割ると約 0.02 秒。分単位で出すので十分。
    # 全境界（約 2,400 件）をまとめて 1 本の配列で回す。
    wrapped_targets = targets % 360.0
    for _ in range(32):
        mid = (lo + hi) / 2
        f = ((sun_lon(mid) - wrapped_targets + 180.0) % 360.0) - 180.0
        before = f < 0
        lo = np.where(before, mid, lo)
        hi = np.where(before, hi, mid)
    jd = (lo + hi) / 2

    # --- 3) 検算 ---------------------------------------------------------
    # 求めた時刻の黄経が本当に目標どおりか。ここが合わないなら
    # 二分法か目標値の作り方が壊れている。
    err = np.abs(((sun_lon(jd) - wrapped_targets + 180.0) % 360.0) - 180.0)
    worst = err.max() * 3600.0
    if worst > 0.1:
        sys.exit(f"✗ 黄経の残差が大きすぎます: {worst:.3f} 秒角")

    # --- 4) UTC の分に丸め、差分で持つ -----------------------------------
    #
    # JD から直接引き算せず、暦の年月日時分秒に直してから分を数える。
    # 閏秒があるので JD の差と暦上の経過分は一致せず、表示する時刻と
    # 保存する値がずれる。公表資料と突き合わせるのは暦の側なので、
    # そちらに合わせる。
    t_utc = ts.tt_jd(jd)
    minutes = np.array([_utc_minutes(*c) for c in zip(*t_utc.utc)], dtype=np.int64)

    if not np.all(np.diff(minutes) > 0):
        sys.exit("✗ 節気の時刻が時間順になっていません")
    gap = np.diff(minutes) / 1440.0
    if gap.min() < 14.0 or gap.max() > 16.5:
        sys.exit(f"✗ 節気の間隔が異常です: {gap.min():.2f}〜{gap.max():.2f} 日")

    j0 = int(round(targets[0] / 15)) % 24
    deltas = [int(minutes[0])] + np.diff(minutes).astype(int).tolist()

    out = {
        "v": 1,
        "note": "24 solar terms, UTC. t is delta-encoded minutes from epoch.",
        "epoch": "1900-01-01T00:00:00Z",
        "unit": "minute",
        "range": [a.y0, a.y1],
        "j0": j0,                       # t[0] の節気 index（黄経 = j0*15）
        "names": [t[1] for t in TERMS],
        "ja":    [t[2] for t in TERMS],
        "jeol":  [i for i, t in enumerate(TERMS) if t[3]],
        "branch": MONTH_BRANCH,
        "t": deltas,
    }

    raw = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    open(a.out, "w", encoding="utf-8").write(raw)

    b = raw.encode()
    print(f"{a.out} : {len(b)/1024:.1f} KB  (gzip {len(gzip.compress(b,9))/1024:.1f} KB)")
    print(f"  {a.y0}〜{a.y1}  節気 {len(deltas)} 件  残差 最大 {worst:.4f} 秒角")
    print(f"  先頭 {t_utc.utc_strftime('%Y-%m-%d %H:%M')[0]} UTC  {TERMS[j0][2]}")
    print(f"  末尾 {t_utc.utc_strftime('%Y-%m-%d %H:%M')[-1]} UTC  "
          f"{TERMS[(j0+len(deltas)-1)%24][2]}")


_BASE = datetime(1900, 1, 1, tzinfo=timezone.utc)


def _utc_minutes(y, mo, d, h, mi, s):
    """UTC の暦時刻 → 1900-01-01T00:00Z からの分（四捨五入）。"""
    t = datetime(int(y), int(mo), int(d), int(h), int(mi), tzinfo=timezone.utc)
    return int(round(((t - _BASE).total_seconds() + float(s)) / 60.0))


if __name__ == "__main__":
    main()
