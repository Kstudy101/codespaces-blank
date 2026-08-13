#!/usr/bin/env bash
# ===================================================================
# publish-content.sh — 手元の原稿をまとめて検査・FTPS・（任意で）seed
#
# 計画: docs/plan-content-batch-deploy.md（래퍼 방식）
# 1 ファイル口は tools/upload-content.sh のまま。ここは並べて呼ぶだけ。
#
#   bash tools/publish-content.sh --check
#   bash tools/publish-content.sh --check --upload
#   bash tools/publish-content.sh --check --upload --deploy \
#     server/content/beginner-01-15.json
#   bash tools/publish-content.sh --upload --dry-run
#
# 引数なし = --all（下記パターン。_*.json は常に除外）
#   beginner-*.json / intermediate-*.json / advanced-*.json
#   quiz-*-review.json
#
# --deploy は明示したときだけ（誤って再起動しない）。
#   → tools/trigger-chemi-deploy.sh → .cpanel.yml が seed
#
# Windows では Git Bash から。FTP 資格は upload-content と同じ
#   ~/.config/kstudy101/ftp-content.conf
# ===================================================================
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONTENT="$ROOT/server/content"
UPLOAD="$ROOT/tools/upload-content.sh"
TRIGGER="$ROOT/tools/trigger-chemi-deploy.sh"
SEED="$ROOT/server/db/seed-content.mjs"

DO_CHECK=0
DO_UPLOAD=0
DO_DEPLOY=0
DRY=0
TARGETS=()

usage() {
  cat <<'EOF'
使い方:
  bash tools/publish-content.sh --check [--upload] [--deploy] [原稿.json …]
  bash tools/publish-content.sh --upload [--dry-run] [原稿.json …]
  bash tools/publish-content.sh --deploy

  ファイル省略時は --all（beginner/intermediate/advanced/quiz-*-review）。
  _*.json（ビルド用）は常に除外。名指しでも上げません。
  --deploy は明示必須。upload なしでも可（向こうの content を再 seed）。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check)   DO_CHECK=1 ;;
    --upload)  DO_UPLOAD=1 ;;
    --deploy)  DO_DEPLOY=1 ;;
    --dry-run) DRY=1 ;;
    --all)     ;; # 明示してもよい（省略時と同じ）
    -h|--help) usage; exit 0 ;;
    -*)        echo "✗ 知らない指定です: $1" >&2; usage >&2; exit 1 ;;
    *)         TARGETS+=("$1") ;;
  esac
  shift
done

if [ "$DO_CHECK" = 0 ] && [ "$DO_UPLOAD" = 0 ] && [ "$DO_DEPLOY" = 0 ]; then
  echo "✗ --check / --upload / --deploy のどれかを指定してください" >&2
  usage >&2
  exit 1
fi

if [ "$DRY" = 1 ] && [ "$DO_UPLOAD" = 0 ]; then
  echo "✗ --dry-run は --upload と一緒に使います" >&2
  exit 1
fi

# --- 対象ファイル ---------------------------------------------------
is_excluded() {
  local base=$1
  case "$base" in
    _*) return 0 ;;
    fortune-lines.json) return 0 ;;
  esac
  return 1
}

collect_all() {
  shopt -s nullglob
  local f base
  for f in \
    "$CONTENT"/beginner-*.json \
    "$CONTENT"/intermediate-*.json \
    "$CONTENT"/advanced-*.json \
    "$CONTENT"/quiz-*-review.json
  do
    base=$(basename "$f")
    is_excluded "$base" && continue
    printf '%s\n' "$f"
  done
}

resolve_targets() {
  local f base abs
  if [ ${#TARGETS[@]} -eq 0 ]; then
    collect_all
    return
  fi
  for f in "${TARGETS[@]}"; do
    case "$f" in
      *..*) echo "✗ 経路に .. は使えません: $f" >&2; exit 1 ;;
    esac
    case "$f" in
      *.json) ;;
      *) echo "✗ .json 以外は扱いません: $f" >&2; exit 1 ;;
    esac
    base=$(basename "$f")
    if is_excluded "$base"; then
      echo "✗ 除外対象です（ビルド用・非原稿）: $f" >&2
      exit 1
    fi
    if [ -f "$f" ]; then
      abs=$(cd "$(dirname "$f")" && pwd)/$(basename "$f")
    elif [ -f "$CONTENT/$base" ]; then
      abs="$CONTENT/$base"
      echo "  （読み替え）$f → server/content/$base" >&2
    else
      echo "✗ ありません: $f" >&2
      exit 1
    fi
    printf '%s\n' "$abs"
  done
}

mapfile -t FILES < <(resolve_targets)
# deploy-only でファイル不要な場合は空でもよい
if [ "$DO_CHECK" = 1 ] || [ "$DO_UPLOAD" = 1 ]; then
  if [ ${#FILES[@]} -eq 0 ]; then
    echo "✗ 対象の原稿が 0 件です（server/content/ を確認）" >&2
    exit 1
  fi
  echo "── 対象 ${#FILES[@]} ファイル ──"
  printf '  %s\n' "${FILES[@]/#$ROOT\//}"
fi

# --- 検査（DB 不要）-------------------------------------------------
if [ "$DO_CHECK" = 1 ]; then
  echo ""
  echo "── --check（seed-content、書き込みなし）──"
  node "$SEED" --check "${FILES[@]}"
fi

# --- 上げる（1 本口を順に）-----------------------------------------
if [ "$DO_UPLOAD" = 1 ]; then
  echo ""
  if [ ! -x "$UPLOAD" ] && [ ! -f "$UPLOAD" ]; then
    echo "✗ $UPLOAD がありません" >&2
    exit 1
  fi
  export UPLOAD_CONTENT_QUIET=1
  n=0
  for f in "${FILES[@]}"; do
    n=$((n + 1))
    echo ""
    echo "── upload $n/${#FILES[@]} ──"
    if [ "$DRY" = 1 ]; then
      bash "$UPLOAD" --dry-run "$f"
    else
      bash "$UPLOAD" "$f"
    fi
  done
  if [ "$DRY" = 1 ]; then
    echo ""
    echo "✓ dry-run 終了（まだ上げていません）"
  else
    echo ""
    echo "✓ ${#FILES[@]} ファイルを上げました"
  fi
fi

# --- Deploy → .cpanel.yml が seed ----------------------------------
if [ "$DO_DEPLOY" = 1 ]; then
  if [ "$DRY" = 1 ]; then
    echo ""
    echo "── --dry-run のため --deploy は飛ばします ──"
    exit 0
  fi
  echo ""
  echo "── --deploy（trigger-chemi-deploy → seed）──"
  bash "$TRIGGER"
  echo ""
  echo "✓ 配備を起こしました。seed 成否は cPanel の配備ログで確認してください。"
  echo "  ※ 差し替えは JST 18 時の夕方配信より前に（STATUS §8-9）"
fi
