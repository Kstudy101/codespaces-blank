#!/usr/bin/env bash
# 公開するファイルだけを dist/ に集める。
#
# このプロジェクトにビルドツール（npm / bundler 等）は無い。
# それでも dist/ を作るのは、リポジトリには置くが公開してはいけないものが
# あるため。とくに data/kanji_platform.db（808KB の元データ）は
# 実行時に使われないので、サーバーへ上げる必要がない。
#
#   使い方:  bash tools/build-site.sh
#   出力  :  dist/

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=dist
rm -rf "$OUT"
mkdir -p "$OUT"

# --- 公開するもの ---------------------------------------------------
PUBLIC=(
  index.html
  privacy.html
  contact.html
  tips.html
  404.html
  page.css
  kanji.json
  ogp.png
  ads.txt
  robots.txt
  sitemap.xml
  .htaccess
)

for f in "${PUBLIC[@]}"; do
  if [ ! -e "$f" ]; then
    echo "✗ 必須ファイルがありません: $f" >&2
    exit 1
  fi
  cp "$f" "$OUT/"
done

# --- 公開してはいけないものが混ざっていないか ------------------------
if find "$OUT" \( -name '*.db' -o -name '*.py' -o -name '*.sh' -o -name '*.md' \) | grep -q .; then
  echo "✗ 非公開ファイルが dist に含まれています" >&2
  find "$OUT" \( -name '*.db' -o -name '*.py' -o -name '*.sh' -o -name '*.md' \) >&2
  exit 1
fi

# --- 中身の健全性 ---------------------------------------------------
fail=0

# 1) 内部リンクの先が存在するか（拡張子なしURLは .html に読み替える）
for html in "$OUT"/*.html; do
  grep -o 'href="/[a-z0-9-]*"' "$html" 2>/dev/null | sed 's/href="\///;s/"//' | sort -u | while read -r p; do
    [ -z "$p" ] && continue
    [ -e "$OUT/$p.html" ] || { echo "✗ $(basename "$html"): /$p の実体がありません" >&2; exit 1; }
  done || fail=1
done

# 2) canonical が全ページにあるか
for html in "$OUT"/index.html "$OUT"/privacy.html "$OUT"/contact.html "$OUT"/tips.html; do
  grep -q 'rel="canonical"' "$html" || { echo "✗ $(basename "$html"): canonical がありません" >&2; fail=1; }
done

# 3) 旧ホストが残っていないか（移行時の取りこぼし検出）
host=$(grep -o 'rel="canonical" href="https://[^/"]*' "$OUT/index.html" | sed 's|.*https://||')
if [ -n "$host" ]; then
  for f in "$OUT"/*.html "$OUT"/sitemap.xml "$OUT"/robots.txt; do
    if grep -oE 'https://[A-Za-z0-9.-]+/' "$f" \
       | grep -vE "https://($host|[a-z]+\.google\.com|policies\.google\.com|www\.googletagmanager\.com|pagead2\.googlesyndication\.com|formspree\.io|line\.me|x\.com|www\.threads\.net|www\.aboutads\.info|tools\.google\.com|marketingplatform\.google\.com|www\.w3\.org|www\.sitemaps\.org)/" \
       | grep -q .; then
      echo "⚠ $(basename "$f"): $host 以外の自サイトURLらしきものがあります" >&2
      grep -oE 'https://[A-Za-z0-9.-]+/' "$f" | sort -u | sed 's/^/    /' >&2
    fi
  done
fi

[ "$fail" -eq 0 ] || exit 1

echo "✓ dist/ を作成しました（$(find "$OUT" -type f | wc -l) ファイル / $(du -sh "$OUT" | cut -f1)）"
echo "  公開ホスト: ${host:-未検出}"
find "$OUT" -type f | sed "s|^$OUT/|  |" | sort
