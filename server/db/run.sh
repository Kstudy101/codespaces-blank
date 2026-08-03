#!/usr/bin/env bash
# ===================================================================
# run.sh — activate を通してから、渡されたものを走らせる
#
#   bash ~/kstudy101-line/db/run.sh db/check-line.mjs
#
# cron の行に activate の場所を書かない。$(...) は crontab に
# 登録する時点で展開されてしまい、空文字のまま保存される ──
# 実際そうなって「node: command not found」だけが残った。
# 探すのは走るときで、探す場所はスクリプトの中。
# ===================================================================
set -uo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ACT=$(ls -d "$HOME"/nodevenv/"$(basename "$APP")"/*/bin/activate 2>/dev/null | sort -V | tail -1)
[ -n "$ACT" ] || { echo "nodevenv が見つかりません" >&2; exit 1; }

# CloudLinux の activate は未定義の CL_VIRTUAL_ENV を読む（push-cron.sh と同じ）
set +u; . "$ACT"; set -u
cd "$APP" || exit 1
exec node db/with-env.mjs "$@"
