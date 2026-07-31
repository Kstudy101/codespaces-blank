#!/usr/bin/env python3
"""data/kanji_platform.db から公開用の kanji.json を作る。

   使い方:  python3 tools/build-kanji-json.py
   .db を更新したら必ず実行して kanji.json を作り直すこと。
"""
import sqlite3, json, gzip, os, re
os.chdir("/workspaces/codespaces-blank")

db = sqlite3.connect("data/kanji_platform.db")

# --- 現行アプリの手書きデータ（韓国音）を読み、衝突を検出する ---
src = open("index.html", encoding="utf-8").read()
blk = src[src.index("const HANJA = {"):
          src.index("/* ==================================================================\n   4. 五行")]
curated = {m.group(1): m.group(2) for m in re.finditer(r"^'(.)':\{k:'([^']+)'", blk, re.M)}

kanji, kyu, conflicts = {}, {}, []
for h, k, s, m in db.execute(
        "SELECT hanzi, kyuujitai, kr_sound, kr_meaning FROM kanji ORDER BY hanzi"):
    if not s:
        continue
    # 訓音（例：「밭 전」）。無い字は空文字。
    kanji[h] = [s, (m or "").strip()]
    if k and k != h:
        kyu[k] = h
    if h in curated and curated[h] != s:
        conflicts.append((h, curated[h], s))

out = {"v": 1, "n": len(kanji), "k": kanji, "kyu": kyu}
raw = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
open("kanji.json", "w", encoding="utf-8").write(raw)

b = raw.encode()
print(f"kanji.json : {len(b)/1024:.1f} KB  (gzip {len(gzip.compress(b,9))/1024:.1f} KB)")
print(f"  한자 {len(kanji)}자 / 구자체 매핑 {len(kyu)}건")
print(f"  훈음 보유: {sum(1 for v in kanji.values() if v[1])}자")
print()
print(f"현행 손수 데이터와 한국음이 다른 글자: {len(conflicts)}")
for h, a, b2 in conflicts:
    print(f"  {h}: 앱='{a}'  DB='{b2}'  → 앱(이름 문맥) 우선")
