# 바이브코딩 스타터킷

Claude Code로 개발할 때 **구조가 무너지지 않게** 하는 프로젝트 뼈대입니다.

> 코드보다 규칙이 먼저입니다.
> 규칙이 없으면 Claude는 매번 스스로 판단하고, 오늘의 판단과 내일의 판단이 달라집니다.
> 각각은 좋은 코드지만, 합치면 무너집니다.

---

## 시작하기 (3단계)

### 1단계 — 설치

```bash
./setup.sh
```

`.env` 파일 생성, 의존성 안내, Git 초기화까지 한 번에 처리합니다.

### 2단계 — Claude Code 실행

프로젝트 루트에서:

```bash
claude
```

Claude가 `CLAUDE.md`를 자동으로 읽습니다.

### 3단계 — 만들고 싶은 것만 말하기

```
회원가입 기능 만들어줘
```

세팅이 끝났으므로 **기능만 말하면 됩니다.** Claude는 이렇게 동작합니다:

```
CLAUDE.md 읽기
  → 계획 세우기
  → plan-reviewer 에이전트로 계획 검토
  → 필요하면 researcher 에이전트로 조사
  → 해당 영역 규칙 읽기 (skills.rules.json 매핑)
  → 정해진 위치에 파일 생성
  → 자체 점검 체크리스트 확인
```

---

## 무엇이 들어 있나

| 구성 | 내용 |
|---|---|
| `CLAUDE.md` | Claude가 가장 먼저 읽는 프로젝트 지침서 |
| `.claude/rules/` | 규칙 문서 **20개** (백엔드 10 + 프론트 10) |
| `.claude/agents/` | 에이전트 **2명** (계획 검토 / 자료 조사) |
| `.claude/skills.rules.json` | 작업 영역 → 읽을 규칙 자동 매핑 |
| `backend/` | FastAPI + SQLAlchemy 계층 구조 + 예시 도메인 |
| `frontend/` | Next.js + TypeScript + Tailwind + 예시 화면 |

### 규칙 20개

**백엔드**
| # | 내용 |
|---|---|
| 01 | 폴더 구조 — 어디에 뭘 두는가 |
| 02 | 이름 규칙 |
| 03 | 계층 경계 — api → service → domain → db |
| 04 | API 설계 |
| 05 | 데이터베이스·마이그레이션 |
| 06 | 에러 처리 |
| 07 | 입력 검증 |
| 08 | 설정과 비밀값 |
| 09 | 로깅 |
| 10 | 테스트 |

**프론트엔드**
| # | 내용 |
|---|---|
| 01 | 폴더 구조 |
| 02 | 이름 규칙 |
| 03 | 컴포넌트 규칙 |
| 04 | **디자인 규칙 (design.md)** — 색상·간격·타이포 토큰 |
| 05 | 상태와 데이터 |
| 06 | 폼과 검증 |
| 07 | API 호출 |
| 08 | 로딩·빈 상태·에러 |
| 09 | 접근성 |
| 10 | 성능 |

---

## 처음에 반드시 할 일

1. **`CLAUDE.md`의 0번 항목을 채우세요.**
   서비스 이름, 주요 사용자, 핵심 기능 3가지. 비어 있으면 Claude가 먼저 물어봅니다.

2. **`.claude/rules/frontend/04-design.md`의 색상을 바꾸세요.**
   기본 팔레트는 시작점입니다. `--accent` 계열을 서비스 정체성에 맞게 교체하세요.
   바꿀 때는 `04-design.md`와 `frontend/src/styles/globals.css` **두 곳을 동시에** 고칩니다.

3. **예시 기능을 확인하세요.**
   `backend/app/domain/example_item/`과 `frontend/src/features/example-item/`이
   모든 계층을 관통하는 본보기입니다. 새 기능은 이걸 복사해서 시작합니다.

---

## 솔직한 한계

- **Claude Code 실행 환경이 필요합니다.** (`npm i -g @anthropic-ai/claude-code`)
- **이 킷이 코드를 대신 짜주지 않습니다.** 뼈대와 규칙만 제공합니다.
- **예시 기능의 인증은 가짜입니다.** `CURRENT_OWNER_ID = 1`을 실제 인증으로 교체하세요.
- 규칙은 이 프로젝트의 기본값입니다. 팀 사정에 맞게 고쳐 쓰세요.

---

## 실행

```bash
# 백엔드
cd backend
pip install -e ".[dev]"
alembic revision --autogenerate -m "init"
alembic upgrade head
uvicorn app.main:app --reload

# 프론트엔드
cd frontend
pnpm install
pnpm dlx shadcn@latest init
pnpm dev
```

DB는 `docker compose up -d`로 띄울 수 있습니다.
