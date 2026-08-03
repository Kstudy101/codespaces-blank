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
# cron は 1 時間ごとに呼ぶ。何時に配るかは push-daily.mjs が
# 日本時間を見て決める（--not-before=7）。借りているサーバーの
# 地方時が何かは確かめにくく、移設や夏時間で黙ってずれる。
#
#   cron: 0 * * * * /bin/bash ~/kstudy101-line/db/push-cron.sh >> ~/logs/push.log 2>&1
# ===================================================================
set -uo pipefail

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

# shellcheck disable=SC1090
. "$ACT"
cd "$APP" || exit 1

echo "───── $(date -u '+%F %T')Z (UTC) ─────"
# 追加の引数はそのまま渡す。--dry-run を付けて呼べば、cron が
# 実際に通る道（activate を探す・パスを組む）を、誰にも送らずに
# 確かめられる。cron の行を直接叩いて試すと本当に送ってしまう。
node db/with-env.mjs db/push-daily.mjs --not-before=7 "$@"
