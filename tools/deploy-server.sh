#!/usr/bin/env bash
# ===================================================================
# deploy-server.sh — server/ を ChemiCloud へ送る
#
# サイト本体は Xserver へ rsync している（deploy.yml）。こちらは
# 動く場所も仕組みも違うので、同じ流れに乗せない:
#
#   サイト  静的ファイルを置くだけ。置いた瞬間に反映される
#   server  Passenger が抱えているプロセスがあり、置いただけでは
#           古いコードが動き続ける。再起動して初めて入れ替わる
#
# GitHub Actions からではなく手元から流す。配信システムは
# 「押した人が結果を見届ける」ものにしておきたい ── push のたびに
# 本番の配信サーバーが入れ替わるのは、事故の起こし方として
# 静かすぎる。
#
#   使い方:
#     bash tools/deploy-server.sh --probe    まず向こうを調べるだけ
#     bash tools/deploy-server.sh            送って入れ替える
#
#   要る環境変数（~/.config/kstudy101/chemicloud.conf に書いてもよい）:
#     CHEMI_HOST      例 sNN.chemicloud.com
#     CHEMI_USER      cPanel のユーザー名
#     CHEMI_PORT      既定 22
#     CHEMI_APP_ROOT  既定 kstudy101-line （ホームからの相対）
#     CHEMI_KEY       既定 ~/.ssh/chemicloud
# ===================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

CONF=~/.config/kstudy101/chemicloud.conf
[ -f "$CONF" ] && . "$CONF"

PORT=${CHEMI_PORT:-22}
APP_ROOT=${CHEMI_APP_ROOT:-kstudy101-line}
KEY=${CHEMI_KEY:-$HOME/.ssh/chemicloud}
PROBE=0
[ "${1:-}" = "--probe" ] && PROBE=1

# --- 足りないものを名前で言ってから止める -------------------------
# env.mjs と同じ考え。1 つ目で止めると、直して走らせて次で止まる、
# を繰り返すことになる。
missing=()
[ -n "${CHEMI_HOST:-}" ] || missing+=("CHEMI_HOST")
[ -n "${CHEMI_USER:-}" ] || missing+=("CHEMI_USER")
[ -f "$KEY" ]            || missing+=("秘密鍵 $KEY")
if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ 足りません:" >&2
  printf '  ・%s\n' "${missing[@]}" >&2
  echo >&2
  echo "  cPanel → SSH Access → Manage SSH Keys で鍵を作り、" >&2
  echo "  秘密鍵を $KEY に置いて chmod 600 してください。" >&2
  exit 1
fi
chmod 600 "$KEY" 2>/dev/null || true

SSH=(ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=accept-new
     -o ConnectTimeout=15 "$CHEMI_USER@$CHEMI_HOST")

# --- 向こうを調べる -------------------------------------------------
#
# CloudLinux の Node.js Selector は node_modules を
# ~/nodevenv/<approot>/<版>/lib/node_modules に置き、アプリ側からは
# symlink で見せる。素の npm install を叩くと実体の方を壊すので、
# 必ず activate を通してから叩く。その activate の場所は版によって
# 変わるので、決め打ちせず毎回探す。
echo "── 接続先を調べます ──"
INFO=$("${SSH[@]}" bash -lc "'
  echo \"home=\$HOME\"
  echo \"approot=\$([ -d \"\$HOME/$APP_ROOT\" ] && echo あり || echo なし)\"
  act=\$(ls -d \"\$HOME/nodevenv/$APP_ROOT\"/*/bin/activate 2>/dev/null | sort -V | tail -1)
  echo \"activate=\${act:-なし}\"
  if [ -n \"\$act\" ]; then . \"\$act\" >/dev/null 2>&1; echo \"node=\$(node -v 2>&1)\"; fi
  echo \"env=\$([ -f \"\$HOME/$APP_ROOT/.env\" ] && echo あり || echo なし)\"
  echo \"restart_dir=\$([ -d \"\$HOME/$APP_ROOT/tmp\" ] && echo あり || echo なし)\"
'") || { echo "✗ SSH で繋がりません（host/user/port/鍵を確認）" >&2; exit 1; }
echo "$INFO" | sed 's/^/  /'

ACTIVATE=$(echo "$INFO" | sed -n 's/^activate=//p')
if [ "$ACTIVATE" = "なし" ]; then
  echo >&2
  echo "✗ Node.js アプリがまだ作られていません。" >&2
  echo "  cPanel → Setup Node.js App → CREATE APPLICATION で:" >&2
  echo "    Node.js version        20 以上" >&2
  echo "    Application root       $APP_ROOT" >&2
  echo "    Application URL        api.kstudy101.jp" >&2
  echo "    Application startup    app.js" >&2
  exit 1
fi

[ "$PROBE" -eq 1 ] && { echo "✓ 調べただけで終わります"; exit 0; }

# --- 送る -----------------------------------------------------------
#
# --delete で送るので、向こうにしか無いものは必ず除外する。
#   node_modules … 向こうは symlink。上書きすると Selector が壊れる
#   .env         … 手元に無いし、あっても送るべきではない。向こうの
#                  値は cPanel の Environment variables で持つ
#   content      … 101 日ぶんの原稿。公開リポジトリに置いていないので
#                  サーバーのここにしか無い。消すと配信が止まり、
#                  手元から上げ直すまで戻らない
#   stderr.log   … アプリが落ちた理由。調べたいのはたいてい配置の直前なので、
#                  配置のたびに消していては一番要るものが残らない
#   tmp / public … Passenger が使う。再起動の合図と文書ルートで、
#                  消すとアプリが上がらなくなりうる
#
# 除外の並びは .cpanel.yml と揃えること。片方だけ足すと、どちらの経路で
# 配ったかで結果が変わる ── しかも消えたことに気づくのは、配信が
# 止まった翌朝になる。
echo
echo "── 送ります ──"
rsync -az --delete --checksum \
  --exclude node_modules --exclude '.env' --exclude '.env.local' \
  --exclude content --exclude tmp --exclude public --exclude 'stderr.log' \
  -e "ssh -i $KEY -p $PORT -o StrictHostKeyChecking=accept-new" \
  server/ "$CHEMI_USER@$CHEMI_HOST:$APP_ROOT/" \
  --out-format='  %n'

# --- 依存を入れて、入れ替える ---------------------------------------
#
# restart.txt を touch すると Passenger が次の要求で新しいコードを
# 読む。既に走っているプロセスは殺されないので、送った直後に
# 触っておかないと、いつまでも古い方が応え続ける。
echo
echo "── 依存を入れて再起動します ──"
"${SSH[@]}" bash -lc "'
  set -e
  . \"$ACTIVATE\"
  cd \"\$HOME/$APP_ROOT\"
  npm ci --omit=dev 2>&1 | tail -3
  mkdir -p tmp && touch tmp/restart.txt
  echo \"  再起動を要求しました\"
'"

echo
echo "✓ 送りました。確認:"
echo "    curl -s https://api.kstudy101.jp/health"
echo
echo "  DB がまだなら、向こうで 1 度だけ:"
echo "    . $ACTIVATE && cd ~/$APP_ROOT && node db/migrate.mjs && node db/smoke.mjs"
