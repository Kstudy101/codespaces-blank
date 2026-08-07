#!/usr/bin/env bash
set -euo pipefail

echo "바이브코딩 스타터킷 설치를 시작합니다."
echo

# 1. .env 생성
for dir in backend frontend; do
  if [ -f "$dir/.env.example" ] && [ ! -f "$dir/.env" ]; then
    cp "$dir/.env.example" "$dir/.env"
    echo "  생성됨: $dir/.env"
  fi
done

# 2. JWT_SECRET 자동 생성
if command -v openssl >/dev/null 2>&1; then
  SECRET=$(openssl rand -hex 32)
  if [ -f backend/.env ]; then
    if grep -q '^JWT_SECRET=$' backend/.env; then
      sed -i.bak "s|^JWT_SECRET=$|JWT_SECRET=$SECRET|" backend/.env && rm -f backend/.env.bak
      echo "  JWT_SECRET 생성 완료"
    fi
  fi
fi

# 3. Git 초기화
if [ ! -d .git ]; then
  git init -q
  echo "  Git 저장소 초기화"
fi

echo
echo "설치가 끝났습니다. 다음 순서로 진행하세요."
echo
echo "  1. CLAUDE.md 를 열어 '0. 이 프로젝트는 무엇인가' 를 채우세요"
echo "  2. .claude/rules/frontend/04-design.md 의 색상을 서비스에 맞게 바꾸세요"
echo "  3. 프로젝트 루트에서 'claude' 를 실행하고 만들고 싶은 기능을 말하세요"
echo
echo "  DB 띄우기:      docker compose up -d"
echo "  백엔드 의존성:  cd backend && pip install -e '.[dev]'"
echo "  프론트 의존성:  cd frontend && pnpm install"
