#!/usr/bin/env bash
# ===================================================================
# trigger-chemi-deploy.sh — cPanel の Deploy HEAD を起こす
#
# 指示書⑮ §5-2③: UAPI 呼び出しをコピーせず tools/cpanel.sh を使う。
# 原稿 private repo の Actions からも、手元からも同じ口。
#
#   bash tools/trigger-chemi-deploy.sh
#
# 前提: cpanel.sh と同じ資格情報
#   ~/.config/kstudy101/chemicloud.conf  (CHEMI_USER / 任意で CPANEL_HOST)
#   ~/.config/kstudy101/cpanel.token
# または環境変数 CPANEL_HOST / CHEMI_USER と CPANEL_TOKEN_FILE。
#
# 流れは deploy-server.yml と同じ:
#   retrieve → 名前で repository_root を決める → update → deployment create
# 完了待ちのポーリングはしない（.cpanel.yml の seed 成否は
# cPanel の配備ログで見る。Actions 側は create が通れば先へ進む）。
# ===================================================================
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CP="$ROOT/tools/cpanel.sh"
[ -x "$CP" ] || CP="bash $CP"

need_jq() { command -v jq >/dev/null || { echo "✗ jq が必要です" >&2; exit 1; }; }
need_jq

echo "── 保存庫を探します"
REPOS=$($CP VersionControl/retrieve)
ROOT_PATH=$(echo "$REPOS" | jq -r \
  '[.[]? | select(.source_repository.url | test("Kstudy101/codespaces-blank"))][0].repository_root // empty')
if [ -z "$ROOT_PATH" ]; then
  echo "✗ Kstudy101/codespaces-blank を遠隔に持つ保存庫がありません" >&2
  echo "$REPOS" | jq -r '.[].source_repository.url // empty' 2>/dev/null || echo "$REPOS" >&2
  exit 1
fi
echo "   repository_root = $ROOT_PATH"

echo "── 遠隔から取り込み (update)"
$CP VersionControl/update "repository_root=$ROOT_PATH" "branch=main" >/dev/null
echo "   OK"

echo "── Deploy HEAD を作ります"
DEP=$($CP VersionControlDeployment/create "repository_root=$ROOT_PATH")
echo "$DEP" | jq -r '"   deploy_id = \(.deploy_id // .)"'
echo "✓ 配備を起こしました（seed はサーバーの .cpanel.yml が実行します）"
