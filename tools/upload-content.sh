#!/usr/bin/env bash
# ===================================================================
# upload-content.sh — 原稿だけを ChemiCloud の content/ へ上げる
#
# 【なぜ cPanel の API トークンを使わないのか】
# UAPI のトークンには範囲の指定が無い。ファイル・DB・メール・cron・
# バックアップが一括りで、原稿を 1 つ置くためにその全部を渡すことに
# なる（tools/cpanel.sh の頭も同じことを言っている）。
#
# FTP の口は性質が違う。ディレクトリの制限が「アカウントそのもの」に
# 付くので、この台本が間違って広く使われる事故が構造的に起こらない
# ── 上へ出ようとしても、こちらが遠慮するのではなくサーバーが断る。
#
#   使い方:
#     bash tools/upload-content.sh server/content/beginner-51-60.json
#     bash tools/upload-content.sh --dry-run server/content/beginner-51-60.json
#     bash tools/upload-content.sh --list
#
#   資格情報（リポジトリの外に置く。cpanel.sh と同じ考え）:
#     ~/.config/kstudy101/ftp-content.conf   chmod 600
#       FTP_HOST=ftp.kstudy101.jp
#       FTP_USER=content@kstudy101.jp
#       FTP_PASS=（cPanel の生成ボタンで作ったもの）
#       FTP_DIR=/     ← この口には content/ が最上位。これで正しい
#
# パスワードは表示しない。命令行にも載せない ── 載せると同じ機械の
# 他のプロセスから ps で見える。curl の設定ファイルを作って -K で
# 渡し、終わったら消す。
#
# 消す機能は作らない。原稿を消す事故は取り返しがつかず（公開リポジトリに
# 置けないので、向こうの content/ が唯一の写しになる日がある）、消したい
# 日は File Manager で人が消せばよい（指示書⑬ §2-3）。
#
# 依存は curl だけ。npm パッケージを足すと、関門 19 種が npm install
# 無しで走る性質が壊れる（指示書⑬ §2-1）。
# ===================================================================
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONF=${FTP_CONTENT_CONF:-~/.config/kstudy101/ftp-content.conf}

usage() {
  cat <<'EOF'
使い方:
  bash tools/upload-content.sh <原稿.json>            上げる
  bash tools/upload-content.sh --dry-run <原稿.json>  上げずに、何がどこへ行くか見せる
  bash tools/upload-content.sh --list                 向こうに何があるか
EOF
}

# --- 引数 -----------------------------------------------------------
LIST=0
DRY=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list)    LIST=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*)        echo "✗ 知らない指定です: $1" >&2; usage >&2; exit 1 ;;
    *)
      [ -z "$TARGET" ] || { echo "✗ ファイルは 1 つずつです（$TARGET と $1）" >&2; exit 1; }
      TARGET=$1 ;;
  esac
  shift
done

if [ "$LIST" = 1 ] && [ -n "$TARGET" ]; then
  echo "✗ --list はファイルを取りません: $TARGET" >&2
  exit 1
fi
if [ "$LIST" = 0 ] && [ -z "$TARGET" ]; then
  usage >&2
  exit 1
fi

# --- 資格情報 -------------------------------------------------------
# 無いまま進まない。「無いのに続行」が一番たちが悪い（指示書⑬ §2-2-4）。
if [ ! -f "$CONF" ]; then
  cat >&2 <<EOF
✗ 原稿用 FTP の資格情報がありません: $CONF

  cPanel → FTP Accounts で 1 つ作ってください（指示書⑬ §1-1）:
    Log In      content                    → content@kstudy101.jp になります
    Password    生成ボタンで作る（手で決めない）
    Directory   kstudy101-line/content     ★ 既定の public_html/content ではありません
    Quota       50 MB                      ★ 無制限にしない

  出てきた値を、チャットに貼らずファイルへ置いてください:
    mkdir -p ~/.config/kstudy101
    cat > $CONF        （下の 4 行を貼って Ctrl-D）
      FTP_HOST=ftp.kstudy101.jp
      FTP_USER=content@kstudy101.jp
      FTP_PASS=（生成されたもの）
      FTP_DIR=/
    chmod 600 $CONF
EOF
  exit 1
fi
chmod 600 "$CONF" 2>/dev/null || true
# conf を source しない。生成パスワードに { } & が混ざると
# bash が brace / バックグラウンドと読み、別の文字列が FTP_PASS に入る
# （2026-08-07: PASS のあとに 421 timeout で発覚）。行ごと代入する。
FTP_HOST=""; FTP_USER=""; FTP_PASS=""; FTP_DIR=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|\#*) continue ;;
  esac
  key=${line%%=*}; val=${line#*=}
  # 両端の対応する引用符を 1 組だけ外す
  case "$val" in
    \'*\') val=${val:1:${#val}-2} ;;
    \"*\") val=${val:1:${#val}-2} ;;
  esac
  case "$key" in
    FTP_HOST) FTP_HOST=$val ;;
    FTP_USER) FTP_USER=$val ;;
    FTP_PASS) FTP_PASS=$val ;;
    FTP_DIR)  FTP_DIR=$val ;;
  esac
done < "$CONF"

# 足りないものは 1 つ目で止めず、まとめて名前で言う（deploy-server.sh と同じ）。
missing=()
[ -n "${FTP_HOST:-}" ] || missing+=("FTP_HOST")
[ -n "${FTP_USER:-}" ] || missing+=("FTP_USER")
[ -n "${FTP_PASS:-}" ] || missing+=("FTP_PASS")
if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ $CONF に足りません:" >&2
  printf '  ・%s\n' "${missing[@]}" >&2
  exit 1
fi

# --- curl の設定ファイル（資格はここだけを通る）---------------------
# 資格を命令行の引数で渡すと ps に出る。設定ファイルにして -K で渡し、
# trap で消す（関門がこの形を見張っている）。
umask 077
CURLRC=$(mktemp)
trap 'rm -f "$CURLRC"' EXIT

# curl の設定ファイルは " の中で \\ と \" を解する。生成された
# パスワードにその 2 文字が混じっても壊れないよう、先に逃がす。
esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
printf 'user = "%s:%s"\n' "$(esc "$FTP_USER")" "$(esc "$FTP_PASS")" > "$CURLRC"

# --ssl-reqd は設定ファイルに入れない。秘密ではないし、命令の側に
# 見えている方が「平文で繋いでいない」ことを目で確かめられる。
# TLS を張れないときは繋がずに失敗する ── 黙って平文へ降りない。
CURL=(curl --ssl-reqd -K "$CURLRC" -sS -m 120)

DIR=${FTP_DIR:-/}
case "$DIR" in /*) ;; *) DIR="/$DIR" ;; esac
case "$DIR" in */) ;; *) DIR="$DIR/" ;; esac
BASE="ftp://$FTP_HOST$DIR"

advise() {
  cat >&2 <<EOF

  よくある原因:
   ・証明書の名前が合わない … 共有サーバーは実ホスト名（rs◯◯-kor.chemicloud.com）の
     証明書を出すことがあります。cPanel → FTP Accounts → Configure FTP Client が
     案内するホスト名を、$CONF の FTP_HOST に入れてください。
     ★ 証明書を見ないで繋ぐ指定は、この台本には入れていません（それを入れると
       平文を禁じた意味が消えます）。
   ・利用者名かパスワードが違う … 利用者は $FTP_USER です（パスワードは出しません）
   ・Directory が違う … kstudy101-line/content になっているか
EOF
}

# --- 一覧 -----------------------------------------------------------
if [ "$LIST" = 1 ]; then
  echo "── $BASE ──"
  "${CURL[@]}" --list-only "$BASE" || { echo "✗ 一覧が取れません" >&2; advise; exit 1; }
  exit 0
fi

# --- 門 3 つ --------------------------------------------------------
# アカウント側でも止まるが、こちら側でも止める（指示書⑬ §2-2-7・8）。
case "$TARGET" in
  *..*) echo "✗ 経路に .. は使えません: $TARGET" >&2; exit 1 ;;
esac
case "$TARGET" in
  *.json) ;;
  *) echo "✗ .json 以外は上げません: $TARGET" >&2; exit 1 ;;
esac

NAME=$(basename "$TARGET")
if [ ! -f "$TARGET" ]; then
  echo "✗ そのファイルがありません: $TARGET" >&2
  # 原稿の実体は server/content/。指示書の例は content/… と書いてあるので、
  # 取り違えたときは黙って読み替えず、名指しで教える。
  if [ -f "$ROOT/server/content/$NAME" ]; then
    echo "  原稿はこちらにあります: server/content/$NAME" >&2
    echo "  リポジトリの根から:     bash tools/upload-content.sh server/content/$NAME" >&2
  fi
  exit 1
fi
LOCAL=$(wc -c < "$TARGET" | tr -d ' ')

# --- 見せるだけ -----------------------------------------------------
if [ "$DRY" = 1 ]; then
  cat <<EOF
── これから上げるもの（--dry-run。まだ上げていません）──
  手元       $TARGET
  大きさ     $LOCAL バイト
  送り先     ${BASE}${NAME}   （FTPS・明示的 TLS）
  利用者     $FTP_USER

  ※ この口は content/ より上へ行けません（アカウント側の Directory 制限）
  ※ 消す機能はありません。同じ名前を上げると置き換わります
EOF
  exit 0
fi

# --- 上げる ---------------------------------------------------------
echo "── 上げます ──"
"${CURL[@]}" -T "$TARGET" "${BASE}${NAME}" \
  || { echo "✗ 上げられませんでした: $NAME" >&2; advise; exit 1; }

# 上げた「つもり」で終わらせない。向こうの大きさを読み直して手元と
# 突き合わせる ── 途中で切れても FTP はそこまでを保存して終わるので、
# 見に行かない限り成功に見える（指示書⑬ §2-2-6）。
# --head は FTP では SIZE/MDTM を投げ、大きさを content-length として返す。
# 見出しの大小は相手任せなので、小文字に均してから取り出す。
if ! REMOTE=$("${CURL[@]}" --head "${BASE}${NAME}" \
              | tr -d '\r' | tr 'A-Z' 'a-z' | sed -n 's/^content-length: *//p'); then
  echo "✗ 上げたものを読み直せませんでした: $NAME" >&2
  advise
  exit 1
fi
REMOTE=$(printf '%s' "$REMOTE" | tr -d ' \t\n')
if [ "$REMOTE" != "$LOCAL" ]; then
  echo "✗ 大きさが合いません（手元 $LOCAL / 向こう ${REMOTE:-取れず} バイト）" >&2
  echo "  切れたまま上がっています。同じ命令をもう一度流すと置き換わります。" >&2
  exit 1
fi
echo "✓ $NAME  $LOCAL バイト — 向こうで読み直して一致"

# --- ここから先は人がやる（指示書⑬ §4）-----------------------------
cat <<EOF

── 残りは人の目でやります（自動化しません）──
  1. 文字化けしていないか、頭を見る
       head -c 400 ~/kstudy101-line/content/$NAME
  2. 入稿の検査（1 文字も書きません）
       bash ~/kstudy101-line/db/run.sh db/seed-content.mjs --check content/$NAME
  3. 通ったら DB へ（cPanel Terminal）
       bash ~/kstudy101-line/db/run.sh db/seed-content.mjs

  ※ 原稿の差し替えは JST 18 時の夕方配信より前に終えてください
    ── 夕方の答えは押された瞬間に計算し直されるので、配信と操作の
       あいだに差し替えると問題と答えがずれます（STATUS §8-9）
EOF
