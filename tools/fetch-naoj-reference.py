#!/usr/bin/env python3
"""検証用の基準データを国立天文台から取ってきて data/naoj-reference.json に置く。

   使い方:  python3 tools/fetch-naoj-reference.py
            python3 tools/fetch-naoj-reference.py --refresh   （取り直す）

自前で計算した節気の時刻と日の干支が正しいかは、自分の計算とは無関係の
公表値と突き合わせないと確かめられない。国立天文台 暦計算室の CGI は
鍵も登録も要らずに両方を出せる。

  二十四節気  /cgi-bin/koyomi/cande/phenomena_s.cgi   2009〜2027 年のみ
  日の干支    /cgi-bin/koyomi/cande/cale2j.cgi        年の範囲に制限なし
  均時差      /cgi-bin/koyomi/cande/gst.cgi           2009〜2027 年のみ

取得結果は data/ に置く。data/ は build-site.sh の PUBLIC に無く、
deploy.yml の paths-ignore にも入っているので配信されない。
検証のたびに国立天文台へ叩きに行かないよう、一度取ったら再利用する。
"""
import argparse, json, os, re, sys, time, urllib.parse, urllib.request

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

BASE = "https://eco.mtk.nao.ac.jp/cgi-bin/koyomi/cande/"
OUT = "data/naoj-reference.json"

# 節気は 2009〜2027 しか出せない。範囲の端（1930・2030）を直接は確かめられない
# ので、そこは日の干支の方でカバーする（干支は年の制限がない）。
TERM_YEARS = list(range(2009, 2028))

# 日の干支を取る区間。60 日連続で取れば干支の一巡ぶんを一度に確かめられる。
# 選んだ日付には理由がある。
GANJI_WINDOWS = [
    ("1930-01-01", 60, "表の下端"),
    ("1936-02-01", 60, "閏年 2/29 をまたぐ"),
    ("1948-05-15", 60, "韓国サマータイム開始(1948-06-01)をまたぐ"),
    ("1954-03-01", 60, "韓国標準時が UTC+8:30 になった 1954-03-21 をまたぐ"),
    ("1961-08-01", 60, "韓国標準時が UTC+9 に戻った 1961-08-10 をまたぐ"),
    ("1984-01-05", 60, "甲子日は 1984-01-31（02-02 とする通説の検算）"),
    ("2000-02-01", 60, "400 年閏の 2000-02-29 をまたぐ"),
    ("2026-08-01", 60, "現在"),
    ("2030-11-02", 60, "表の上端"),
]


def post(cgi, data):
    req = urllib.request.Request(
        BASE + cgi,
        data=urllib.parse.urlencode(data).encode(),
        headers={"User-Agent": "kstudy101-verify/1.0 (+https://www.kstudy101.jp/)"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("euc_jp", "replace")


def rows(html):
    for tr in re.findall(r"<tr>(.*?)</tr>", html, re.S):
        yield [re.sub(r"<[^>]+>", "", c).strip()
               for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]


def fetch_terms(year):
    """その年の二十四節気を UTC で。 → [{"lon":285,"utc":"2024-01-05T20:49"}, ...]"""
    out = []
    for r in rows(post("phenomena_s.cgi", {"year": year, "lst": 0})):
        if len(r) < 6 or r[3] != "二十四節気":
            continue
        m = re.search(r"黄経\s*(\d+)", r[5])
        if not m or not r[1]:
            sys.exit(f"✗ {year}: 行を読めません: {r}")
        out.append({"lon": int(m.group(1)),
                    "utc": r[0].replace("/", "-") + "T" + r[1]})
    if len(out) != 24:
        sys.exit(f"✗ {year}: 節気が {len(out)} 件（24 件のはず）")
    return out


def fetch_ganji(start, days):
    """連続する日の干支。 → [{"date":"1930-01-01","ganji":"辛亥"}, ...]"""
    y, m, d = start.split("-")
    html = post("cale2j.cgi", {"year": int(y), "month": int(m), "day": int(d),
                               "div": 1, "divu": 3, "len": days, "lenu": 3})
    out = [{"date": r[0].replace("/", "-"), "ganji": r[3]}
           for r in rows(html)
           if len(r) >= 4 and re.fullmatch(r"\d{4}/\d{2}/\d{2}", r[0])]
    if len(out) != days:
        sys.exit(f"✗ {start}: {len(out)} 日分（{days} 日のはず）")
    return out


def fetch_eot(year, step=10, days=360):
    """均時差（視太陽時 − 平均太陽時）を分で。 → [{"utc":..., "min":-3.078}, ...]

    経度差だけでは真太陽時にならない。均時差は ±16 分あって、
    2 時間刻みの時支は境目でこれに動かされる。自前の計算式（Meeus 28 章）が
    合っているかは、これと突き合わせないと分からない。"""
    html = post("gst.cgi", {"year": year, "month": 1, "day": 1,
                            "hour": 0, "min": 0, "sec": 0, "lst": 0,
                            "div": step, "divu": 3, "len": days, "lenu": 3})
    out = []
    for r in rows(html):
        if len(r) < 6 or not re.fullmatch(r"\d{4}/\d{2}/\d{2}", r[0]):
            continue
        m = re.fullmatch(r"(-?)(\d+)\s+([\d.]+)", r[5].strip())
        if not m:
            sys.exit(f"✗ {year}: 均時差を読めません: {r[5]!r}")
        # 時刻の桁は揃っていない（"0:00:00"）。頭を 0 で埋めて HH:MM に直す。
        hm = re.match(r"(\d{1,2}):(\d{2})", r[1])
        if not hm:
            sys.exit(f"✗ {year}: 時刻を読めません: {r[1]!r}")
        sign = -1 if m.group(1) else 1
        out.append({"utc": f"{r[0].replace('/', '-')}T{int(hm.group(1)):02d}:{hm.group(2)}",
                    "min": sign * (int(m.group(2)) + float(m.group(3)) / 60)})
    if not out:
        sys.exit(f"✗ {year}: 均時差が 0 件")
    return out


def main():
    ap = argparse.ArgumentParser()
    # 節を指定できるようにしてあるのは、取り直したいのが 1 節だけのときに
    # 30 回も国立天文台へ叩きに行かずに済ませるため。--refresh だけなら全部。
    ap.add_argument("--refresh", nargs="*", choices=["terms", "ganji", "eot"],
                    metavar="SECTION",
                    help="取り直す。節を指定するとその節だけ（例: --refresh eot）")
    a = ap.parse_args()

    have = os.path.exists(OUT)
    if have and a.refresh is None:
        print(f"{OUT} は取得済みです。取り直すなら --refresh")
        return
    want = set(a.refresh or ["terms", "ganji", "eot"]) if have else \
        {"terms", "ganji", "eot"}

    ref = {
        "source": "国立天文台 暦計算室 (https://eco.mtk.nao.ac.jp/koyomi/cande/)",
        "fetched": time.strftime("%Y-%m-%d"),
        "terms_tz": "UTC",
        "terms": {},
        "ganji": {},
        "eot": {},
    }
    if have:
        # 取り直さない節は前の内容をそのまま残す。
        with open(OUT, encoding="utf-8") as f:
            ref.update({k: v for k, v in json.load(f).items()
                        if k not in want and k != "fetched"})

    if "terms" in want:
        for y in TERM_YEARS:
            ref["terms"][str(y)] = fetch_terms(y)
            print(f"  節気 {y}  24 件")
            time.sleep(1)      # 公共サーバーなので間を空ける

    if "ganji" in want:
        for start, days, why in GANJI_WINDOWS:
            ref["ganji"][start] = {"days": days, "why": why,
                                   "list": fetch_ganji(start, days)}
            print(f"  干支 {start} から {days} 日  （{why}）")
            time.sleep(1)

    # 均時差は年ごとの形がほぼ同じなので、うるう年と平年を 1 つずつ取れば足りる。
    if "eot" in want:
        for y in (2024, 2025):
            ref["eot"][str(y)] = fetch_eot(y)
            print(f"  均時差 {y}  {len(ref['eot'][str(y)])} 点")
            time.sleep(1)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ref, f, ensure_ascii=False, indent=1)

    n_t = sum(len(v) for v in ref["terms"].values())
    n_g = sum(v["days"] for v in ref["ganji"].values())
    n_e = sum(len(v) for v in ref["eot"].values())
    print(f"\n{OUT}: 節気 {n_t} 件 / 干支 {n_g} 日 / 均時差 {n_e} 点  "
          f"({os.path.getsize(OUT)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
