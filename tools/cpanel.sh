#!/usr/bin/env bash
# ===================================================================
# cpanel.sh — cPanel の UAPI を叩く
#
# ChemiCloud は SSH の口（21098）をこちらの IP に対して落としている。
# ポート 22 は「拒否」を返すのにこちらは無応答なので、届いていない
# のではなく、防火壁が捨てている。IP を開けてもらう手もあるが、
# Codespace の IP は立て直すたびに変わるので、開けても翌日には
# また閉まる。
#
# 一方 cPanel の 2083 は開いていて、正規の証明書で繋がる。
# UAPI は HTTPS の上に載っているので、こちらを通り道にする。
#
#   使い方:
#     bash tools/cpanel.sh Fileman/list_files dir=/
#     bash tools/cpanel.sh VersionControl/retrieve
#     bash tools/cpanel.sh --api2 Cron/listcron
#
# 【なぜ API2 の口も要るのか】
# cron は UAPI に無い。叩くと「Cpanel::API::Cron を読めません」で
# 落ちる ── モジュールが存在しないので、権限を直しても通らない。
# cron を触る口は API2（/json-api/cpanel）にしか無く、配信が
# 1 日 2 回になった時点でここを通る必要ができた。
#
# 2 つの口は返す形が違う。UAPI は {status, data}、API2 は
# {cpanelresult: {data, error}}。成否の見方も別なので、
# 下で分けて読む ── 同じつもりで読むと、失敗が data:null として
# 「成功したが中身が空」に見える。
#
#   鍵の置き場（どちらもリポジトリの外）:
#     ~/.config/kstudy101/chemicloud.conf   ホスト・利用者名
#     ~/.config/kstudy101/cpanel.token      API トークン
#
# トークンは表示しない。--trace のような形で漏れると、
# パスワードを渡したのと同じことになる（UAPI はほぼ全権）。
# ===================================================================
set -euo pipefail

CONF=~/.config/kstudy101/chemicloud.conf
TOKEN_FILE=${CPANEL_TOKEN_FILE:-~/.config/kstudy101/cpanel.token}
[ -f "$CONF" ] && . "$CONF"

# cPanel の口は api.kstudy101.jp:2083。ChemiCloud が配る
# rs6-kor.chemicloud.com は公開 DNS に無く、名前が引けない。
CP_HOST=${CPANEL_HOST:-api.kstudy101.jp}
CP_PORT=${CPANEL_PORT:-2083}
CP_USER=${CHEMI_USER:-}

if [ ! -f "$TOKEN_FILE" ]; then
  cat >&2 <<EOF
✗ API トークンがありません: $TOKEN_FILE

  cPanel → Security → Manage API Tokens → Create
    名前     kstudy101-deploy
    権限     制限しない（Git と Node の操作に要る）

  出てきた文字列を、チャットに貼らずファイルに置いてください:
    mkdir -p ~/.config/kstudy101
    cat > ~/.config/kstudy101/cpanel.token   （貼って Ctrl-D）
    chmod 600 ~/.config/kstudy101/cpanel.token
EOF
  exit 1
fi
[ -n "$CP_USER" ] || { echo "✗ CHEMI_USER が未設定です（$CONF）" >&2; exit 1; }

TOKEN=$(tr -d ' \t\r\n' < "$TOKEN_FILE")
[ -n "$TOKEN" ] || { echo "✗ トークンが空です: $TOKEN_FILE" >&2; exit 1; }

API2=0
if [ "${1:-}" = "--api2" ]; then API2=1; shift; fi

[ $# -ge 1 ] || { echo "使い方: cpanel.sh [--api2] Module/function [key=value ...]" >&2; exit 1; }
CALL=$1; shift

MODULE=${CALL%%/*}
FUNC=${CALL#*/}
if [ "$MODULE" = "$CALL" ] || [ -z "$FUNC" ]; then
  echo "✗ Module/function の形で渡してください: $CALL" >&2
  exit 1
fi

# 引数は curl に --data-urlencode で渡す。手で URL を組み立てると、
# パスや JSON に混じる & や = で切れる ── 静かに別の意味になる。
args=()
for kv in "$@"; do args+=(--data-urlencode "$kv"); done

if [ "$API2" = "1" ]; then
  # API2 は呼び先を問い合わせ文字列で指定する。ここだけは
  # --data-urlencode ではなく決め打ちでよい（値はこちらが作る）。
  args+=(--data-urlencode "cpanel_jsonapi_module=${MODULE}"
         --data-urlencode "cpanel_jsonapi_func=${FUNC}"
         --data-urlencode "cpanel_jsonapi_apiversion=2")
  URL="https://${CP_HOST}:${CP_PORT}/json-api/cpanel"
else
  URL="https://${CP_HOST}:${CP_PORT}/execute/${CALL}"
fi

# 証明書は検証する（-k を付けない）。api.kstudy101.jp の証明書は
# 2083 でも有効なので、切る理由が無い。
# 既定は GET。原稿のようにまとまった中身を送るときは POST にする
# ── URL に載せると長さの上限に当たり、切れた所から先が黙って消える。
#    CPANEL_POST=1 bash tools/cpanel.sh Fileman/save_file_content …
METHOD=()
[ "${CPANEL_POST:-}" = "1" ] || METHOD=(-G)

resp=$(curl -sS -m 120 "${METHOD[@]}" \
        -H "Authorization: cpanel ${CP_USER}:${TOKEN}" \
        "${args[@]}" \
        "$URL") || {
  echo "✗ 接続できません: $URL" >&2
  exit 1
}

# どちらの口も HTTP 200 のまま失敗を返す。ここで見ないと、
# 呼んだ側は成功したと思って次へ進む。
if ! echo "$resp" | jq -e . >/dev/null 2>&1; then
  echo "✗ JSON が返りませんでした（トークンか権限を確認）:" >&2
  echo "$resp" | head -5 >&2
  exit 1
fi

if [ "$API2" = "1" ]; then
  # API2 の失敗は cpanelresult.error に入る。data が空でも
  # error が無ければ成功（listcron が 0 件、など）。
  err=$(echo "$resp" | jq -r '.cpanelresult.error // empty')
  if [ -n "$err" ]; then
    echo "✗ ${CALL} が失敗しました:" >&2
    echo "  $err" >&2
    exit 1
  fi
  # 個々の結果にも status が付く（追加は成功したか）。
  bad=$(echo "$resp" | jq -r '[.cpanelresult.data[]? | select(.status? == 0) | .statusmsg // "理由が返っていません"] | .[]')
  if [ -n "$bad" ]; then
    echo "✗ ${CALL} が失敗しました:" >&2
    echo "$bad" | sed 's/^/    /' >&2
    exit 1
  fi
  echo "$resp" | jq '.cpanelresult.data'
  exit 0
fi

# UAPI は status:0 で失敗を返す。エラーは errors 配列。
if [ "$(echo "$resp" | jq -r '.status // 0')" != "1" ]; then
  echo "✗ ${CALL} が失敗しました:" >&2
  echo "$resp" | jq -r '(.errors // ["理由が返っていません"])[]' | sed 's/^/    /' >&2
  exit 1
fi

echo "$resp" | jq '.data'
