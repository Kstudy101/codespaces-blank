#!/usr/bin/env bash
# ===================================================================
# push-cron.sh — cron から朝の配信を呼ぶ
#
# cron の行に直接コマンドを書かない。書くと Node の版が
# 行の中に固定される（~/nodevenv/kstudy101-line/24/bin/node）ので、
# cPanel の画面で版を上げた日に、配信だけが古い版を探して止まる。
# 止まったことは誰も気づかない ── 届かないことに気づけるのは
# 受け取る側だけで、その人は「今日は来ないな」としか思わない。
#
# cron は 1 時間ごとに呼ぶ。何時に配るかは各バッチが日本時間を
# 見て決める（朝 --not-before=7 / 夕 --not-before=18）。借りている
# サーバーの地方時が何かは確かめにくく、移設や夏時間で黙ってずれる。
#
#   cron:
#     0 * * * * /bin/bash ~/kstudy101-line/db/push-cron.sh morning >> ~/logs/push.log 2>&1
#     0 * * * * /bin/bash ~/kstudy101-line/db/push-cron.sh evening >> ~/logs/push.log 2>&1
#     0 19 * * * /bin/bash ~/kstudy101-line/db/push-cron.sh maintain >> ~/logs/push.log 2>&1
#
# maintain（日次の掃除と見張り。db/maintain.mjs）だけ時刻指定なのは、
# 朝夕のような「何時に届くか」の約束が無く、JST の判定が要らないため。
# 19:00 UTC = 04:00 JST ── 配信（朝 7 時・夕 18 時 JST）と重ならない
# 未明帯。サーバーの地方時が UTC からずれた日は時間帯もずれるが、
# 消すのは期限切れと 400 日前のログだけなので、配信と重なっても
# 表を取り合わない。
#
# 1 本のスクリプトに寄せているのは、nodevenv を探す手順（下）を
# 2 か所に置きたくないため。実際そこが CloudLinux の activate で
# 一度壊れており、直す場所が 2 つあると片方だけ直る。
#
# 第 1 引数が無いときは morning。cron の行を書き換える前に配置しても
# 朝の便が止まらないようにしてある ── 配置と cron の変更は
# 同時にはできない（別の画面で行う）。
# ===================================================================
set -uo pipefail

# どの便か。引数が無ければ朝（上の注記のとおり）。
WHICH="morning"
if [ $# -gt 0 ]; then
  case "$1" in
    morning|evening|maintain) WHICH="$1"; shift ;;
    # 綴り違いを黙って朝として走らせない。夕方のつもりで
    # 書いた行が毎時朝の便を叩く、が起きる。
    -*) : ;;
    *) echo "使い方: push-cron.sh [morning|evening|maintain] [追加の引数…]" >&2; exit 1 ;;
  esac
fi

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/logs/push.log"

# 版のディレクトリ名は変わるので、その都度いちばん新しいものを探す。
# 辞書順だと 10 が 24 より後ろに来るので -V で並べる。
ACT=$(ls -d "$HOME"/nodevenv/"$(basename "$APP")"/*/bin/activate 2>/dev/null | sort -V | tail -1)
if [ -z "$ACT" ]; then
  echo "[$(date -u '+%F %T')Z] nodevenv が見つかりません。配信できません。" >&2
  exit 1
fi

# 記録が際限なく伸びると、共用サーバーの容量を静かに食う。
# 5MB を超えたら直近だけ残す ── 消してしまうと、止まっていた
# 期間そのものが分からなくなる。
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5242880 ]; then
  tail -c 1048576 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# CloudLinux の activate は未定義の CL_VIRTUAL_ENV を読む。
# set -u のまま読み込むと、そこで落ちて node まで届かない。
#
# これは cron から呼んだときにだけ出た。配置の下見では、外側の
# シェルが先に activate を済ませていたので通ってしまう ──
# 「試した道」と「本番で通る道」が違っていた。
# 読み込むあいだだけ外す。
# shellcheck disable=SC1090
set +u
. "$ACT"
set -u

cd "$APP" || exit 1

echo "───── $(date -u '+%F %T')Z (UTC) ${WHICH} ─────"
# 追加の引数はそのまま渡す。--dry-run を付けて呼べば、cron が
# 実際に通る道（activate を探す・パスを組む）を、誰にも送らず
# 何も消さずに確かめられる。cron の行を直接叩いて試すと本当に走る。
if [ "$WHICH" = "evening" ]; then
  node db/with-env.mjs db/push-evening.mjs --not-before=18 "$@"
elif [ "$WHICH" = "maintain" ]; then
  node db/with-env.mjs db/maintain.mjs "$@"
else
  node db/with-env.mjs db/push-daily.mjs --not-before=7 "$@"
fi
