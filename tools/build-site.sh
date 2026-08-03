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
  words.html
  omikuji.html
  gilbang.html
  amulet.html
  404.html
  page.css
  kanji.json
  saju.js
  fortune.js
  study.js
  omikuji.js
  gilbang.js
  amulet.js
  birth.js
  new-moons.json
  solar-terms.json
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
#
# PUBLIC は許可リストなので、足したものが勝手に入ることは無い。
# それでもここで見るのは、PUBLIC に書き足す側が間違えたときの網。
#
# *.sql / *.env は LINE 配信システム（server/）を足したときに加えた。
# server/db/schema.sql は表の作り方そのもので、server/.env には
# DB のパスワードと Stripe の秘密鍵が入る。1 度でも配ってしまえば、
# 消しても取り返せない類いのもの。
NOPUB=( -name '*.db' -o -name '*.py' -o -name '*.sh' -o -name '*.md'
        -o -name '*.sql' -o -name '*.env' -o -name '.env*' )
if find "$OUT" \( "${NOPUB[@]}" \) | grep -q .; then
  echo "✗ 非公開ファイルが dist に含まれています" >&2
  find "$OUT" \( "${NOPUB[@]}" \) >&2
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
for html in "$OUT"/index.html "$OUT"/privacy.html "$OUT"/contact.html "$OUT"/tips.html "$OUT"/words.html "$OUT"/omikuji.html "$OUT"/gilbang.html "$OUT"/amulet.html; do
  grep -q 'rel="canonical"' "$html" || { echo "✗ $(basename "$html"): canonical がありません" >&2; fail=1; }
done

# 3) 旧ホストの取りこぼし検出。
#
#    「許可リストに無いホスト」を疑う書き方にしていたが、外部サービスを
#    足すたびにリストを直す必要があり、実際 Clarity を入れた時に正常なURLを
#    大量に警告した。探したいのは自分の古いホストなので、そちらを直接見る。
#
#    探しているのは 2 種類だけ:
#      ・移転前の置き場（pages.dev / github.io）
#      ・www の付け忘れ（apex そのもの。/ へ 301 されるので canonical に使えない）
#
#    同じドメインの別サブドメイン（api.kstudy101.jp など）は対象外。
#    "kstudy" を含むもの全部を疑う書き方にしていたため、配信サーバーの
#    URL を書いた時点でビルドが落ちた。別サービスの正当な宛先まで
#    巻き込むのは、Clarity のときと同じ失敗の繰り返しだった。
host=$(grep -o 'rel="canonical" href="https://[^/"]*' "$OUT/index.html" | sed 's|.*https://||')
apex=${host#www.}
if [ -n "$host" ]; then
  for f in "$OUT"/*.html "$OUT"/sitemap.xml "$OUT"/robots.txt; do
    stale=$(grep -oE 'https://[A-Za-z0-9.-]+' "$f" | sed 's|https://||' | sort -u \
            | grep -iE "(pages\.dev|github\.io)\$|^${apex}\$" | grep -vx "$host" || true)
    if [ -n "$stale" ]; then
      echo "✗ $(basename "$f"): 旧ホストが残っています（正: $host）" >&2
      echo "$stale" | sed 's/^/    /' >&2
      fail=1
    fi
  done
fi

# 4) sitemap の網羅性。両方向を見る。
#
#    ページを足して sitemap に入れ忘れる、が起きやすい。逆に、消した
#    ページが sitemap に残っているとクローラーに 404 を出し続ける。
#
#    載せないページは意図して載せていないので、ここに理由つきで並べる:
#      words … 端末ごとの一覧で、クローラーには常に空に見える（noindex）
#      404   … エラーページ
SITEMAP_SKIP=" words 404 "

for html in "$OUT"/*.html; do
  name=$(basename "$html" .html)
  case "$SITEMAP_SKIP" in *" $name "*) continue ;; esac
  if [ "$name" = "index" ]; then want="<loc>https://$host/</loc>"
  else                            want="<loc>https://$host/$name</loc>"; fi
  grep -qF "$want" "$OUT/sitemap.xml" \
    || { echo "✗ sitemap.xml: /$name が載っていません" >&2; fail=1; }
done

grep -o '<loc>https://[^<]*</loc>' "$OUT/sitemap.xml" \
  | sed "s|<loc>https://$host||;s|</loc>||" | sort -u | while read -r p; do
    [ "$p" = "/" ] && p="/index"
    [ -e "$OUT$p.html" ] || { echo "✗ sitemap.xml: $p の実体がありません" >&2; exit 1; }
  done || fail=1

# 5) CSS カスタムプロパティの取りこぼし。
#
#    page.css の色トークンは index.html と手で揃える約束になっている。
#    実際に --gold を写し忘れ、/gilbang の方位盤で「中央」を指す印が
#    消えていた。background は継承しないので、未定義の var() は
#    transparent になる ── 中央が出る人にだけ何も表示されないので、
#    画面を見ていても気づけない。
#
#    フォールバック付き var(--x, 既定) は未定義でも成立するので見ない。
#    grep の「見つからない＝終了1」を && で繋ぐと set -e に殺されるので、
#    判定は必ず if で書くこと。
decls () { grep -ohE -- '--[a-z0-9-]+[[:space:]]*:' "$1" 2>/dev/null \
             | sed 's/[[:space:]]*:$//' | sort -u || true; }
props=$(decls "$OUT/page.css")
for html in "$OUT"/*.html; do
  own=$(decls "$html")
  uses=$(grep -ohE 'var\(--[a-z0-9-]+\)' "$html" 2>/dev/null | sed 's/var(//;s/)//' | sort -u || true)
  for v in $uses; do
    if printf '%s\n' "$props" | grep -qx -- "$v"; then continue; fi
    if printf '%s\n' "$own"   | grep -qx -- "$v"; then continue; fi
    echo "✗ $(basename "$html"): $v が未定義です（page.css にも自身にもありません）" >&2
    fail=1
  done
done

# 6) index.html と page.css の色トークンの値がずれていないか。
#
#    5) は「使っているのに無い」を見る。こちらは「両方にあるが値が違う」を見る。
#    どちらか片方だけ色を変えると、トップと下層で違う赤になる ── これも
#    並べて見ないと気づけない類い。片方にしか無いトークン（--radius 等）は
#    見ない。page.css が index.html の全部を要るわけではないので。
tokens () { sed -n '/^:root{/,/^}/p' "$1" | grep -oE -- '--[a-z0-9-]+:[^;]+' | sed 's/:/ /' | sort || true; }
ti=$(tokens "$OUT/index.html"); tp=$(tokens "$OUT/page.css")
for name in $(printf '%s\n%s\n' "$ti" "$tp" | awk '{print $1}' | sort | uniq -d); do
  vi=$(printf '%s\n' "$ti" | awk -v n="$name" '$1==n{sub(/^[^ ]+ /,""); print}')
  vp=$(printf '%s\n' "$tp" | awk -v n="$name" '$1==n{sub(/^[^ ]+ /,""); print}')
  if [ "$vi" != "$vp" ]; then
    echo "✗ 色トークン $name がずれています（index.html: $vi / page.css: $vp）" >&2
    fail=1
  fi
done

[ "$fail" -eq 0 ] || exit 1

# --- 共用ファイルの参照に内容ハッシュを付ける -------------------------
#
# Xserver は Apache の前に nginx を置いており、そこが応答をURL単位で
# キャッシュする。.htaccess で no-cache を返すようにしても、nginx が
# すでに抱えている古い応答は差し替わらない ── 実際、page.css を
# no-cache に変えたあとも一週間の max-age が返り続けた。
#
# ヘッダに頼らず、中身が変わったらURLが変わるようにする。
# ?v= が変われば nginx にとってもブラウザにとっても別のURLなので、
# 古い写しが残っていても新しい方を取りに行く。
python3 - "$OUT" <<'PY'
import hashlib, pathlib, re, sys

out = pathlib.Path(sys.argv[1])
assets = sorted(p.name for p in out.iterdir()
                if p.suffix in ('.css', '.js') and p.is_file())
ver = {a: hashlib.sha256((out / a).read_bytes()).hexdigest()[:8] for a in assets}

for html in out.glob('*.html'):
    s = t = html.read_text(encoding='utf-8')
    for a, v in ver.items():
        # href="page.css" と href="/page.css" の両方が使われている
        s = re.sub(r'((?:href|src)=")(/?' + re.escape(a) + r')(")',
                   lambda m: f'{m.group(1)}{m.group(2)}?v={ver[a]}{m.group(3)}', s)
    if s != t:
        html.write_text(s, encoding='utf-8')

print('  版を付けた共用ファイル: ' + ', '.join(f'{a}?v={v}' for a, v in ver.items()))

# 付け忘れが無いか確かめる。1つでも素のままだと、そのファイルだけ
# 古い写しを掴み続ける。
missed = []
for html in out.glob('*.html'):
    s = html.read_text(encoding='utf-8')
    for a in ver:
        if re.search(r'(?:href|src)="/?' + re.escape(a) + r'"', s):
            missed.append(f'{html.name} → {a}')
if missed:
    sys.exit('✗ 版が付いていない参照: ' + ', '.join(missed))
PY

echo "✓ dist/ を作成しました（$(find "$OUT" -type f | wc -l) ファイル / $(du -sh "$OUT" | cut -f1)）"
echo "  公開ホスト: ${host:-未検出}"
find "$OUT" -type f | sed "s|^$OUT/|  |" | sort
