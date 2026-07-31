#!/usr/bin/env python3
"""サイト自身の絶対URLを一括で入れ替える。

    python3 tools/set-site-url.py https://kstudy101.jp

canonical / og:url / og:image / twitter:image / sitemap.xml / robots.txt、
および index.html の SITE_URL 定数を書き換える。

【重要】置換対象は「index.html の canonical に書かれているホスト」だけに限る。
除外リスト方式（Google 等を弾く）にすると、pagead2.googlesyndication.com の
ような未登録のサブドメインを取りこぼして AdSense や GA の script src まで
書き換えてしまう。実際に一度それをやって広告と計測を壊した。
自分のホストは canonical から一意に決まるので、そこだけを対象にする。
"""
import re, sys, os, pathlib

TARGETS = ["index.html", "privacy.html", "contact.html", "tips.html",
           "404.html", "sitemap.xml", "robots.txt"]

def main():
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} https://example.com")
    new = sys.argv[1].rstrip("/")
    m = re.match(r"^https://([A-Za-z0-9.-]+)$", new)
    if not m:
        sys.exit(f"URLの形式が不正です（https://host のみ）: {new}")
    new_host = m.group(1)

    root = pathlib.Path(__file__).resolve().parent.parent
    os.chdir(root)

    # --- 自分のホストを canonical から特定する ---
    src = open("index.html", encoding="utf-8").read()
    cm = re.search(r'<link rel="canonical" href="https://([A-Za-z0-9.-]+)', src)
    if not cm:
        sys.exit("index.html に canonical が見つかりません")
    old_host = cm.group(1)

    if old_host == new_host:
        print(f"すでに {new_host} です。変更ありません。")
        return
    print(f"置換: {old_host}  →  {new_host}")

    total = 0
    for f in TARGETS:
        if not os.path.exists(f):
            continue
        s = open(f, encoding="utf-8").read()
        n = s.count(f"https://{old_host}")
        if n:
            open(f, "w", encoding="utf-8").write(s.replace(f"https://{old_host}", new))
            print(f"  {f:16} {n}か所")
            total += n
    print(f"合計 {total} か所を更新しました。")

    # --- 検算：自分のホストが残っていないか / 他社URLを壊していないか ---
    KEEP = ["pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
            "www.googletagmanager.com/gtag/js",
            "policies.google.com", "formspree.io"]
    bad = []
    for f in TARGETS:
        if not os.path.exists(f):
            continue
        s = open(f, encoding="utf-8").read()
        # スキームまで含めて見る。apex → www のように新ホストが旧ホストを
        # 部分文字列として含む場合、ホスト名だけの比較では必ず誤検知する。
        if f"https://{old_host}/" in s or s.rstrip().endswith(f"https://{old_host}"):
            bad.append(f"{f}: 旧ホストが残存")
    for f in ["index.html", "privacy.html", "contact.html", "tips.html"]:
        s = open(f, encoding="utf-8").read()
        for k in KEEP:
            host = k.split("/")[0]
            if host in ("policies.google.com", "formspree.io"):
                continue
            if k not in s:
                bad.append(f"{f}: 外部URL {k} が壊れています")
    if bad:
        sys.exit("✗ " + "\n✗ ".join(bad))
    print("✓ 外部サービスのURL（AdSense / GA）は無傷です。")

if __name__ == "__main__":
    main()
