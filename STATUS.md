# STATUS.md — 지금 어디까지 왔고, 다음에 뭘 해야 하는가

최종 갱신: 2026-08-08 (D3 완료·세션 종결)

> **다른 컴퓨터에서 이어받을 때 이 파일부터 읽으십시오.**
> 그 다음 [instruction.txt](instruction.txt) → [CLAUDE.md](CLAUDE.md) 순서입니다.

---

## 0. 30초 요약

- 사이트(정적)는 **Xserver에서 가동 중** — https://www.kstudy101.jp/
  `main` 에 push 하면 GitHub Actions 가 자동 배포합니다
- LINE 배신 서버(`server/`)는 **ChemiCloud 에 배포 완료** (최신 2026-08-07, `518c060` — B1 프로필 편집) —
  마이그레이션은 이제 **적용 이력(schema_migrations)** 을 가진다. 배포마다
  001부터 재실행되던 폭탄(2회차에 errno 1054 로 배포 정지)은 `8b12063` 로 종식
- 결제(선불 횟수권) — **A3 Stripe 테스트 완료** (2026-08-08). C2·C3 완료. **C4 실판매 판단**만 남음
- 관문(자동 검증) **19종 전부 통과** + smoke 29항목 (migrate 2회 연속 검사 포함)
- 사이드 메뉴 개편([docs/plan-side-menu.md](docs/plan-side-menu.md)) — **구현·관문 완료** (B2)
- 콘텐츠 입고·자동 업로드 — **서버 반영 완료** (D1·D1b·D1c·D2, 2026-08-07 대표 확인).
  private repo → FTPS → UAPI Deploy → `.cpanel.yml` seed 전 경로 가동 ([plan-content-ci](docs/plan-content-ci.md))

**권장 진행 순서 (한 줄).**
C4 실판매 → B1 라이브 → E 조건 도래 시 라이브 확인.

**B3 (2026-08-07 확인).** maintain §3 `#3 beginner 持っている=3 / 台帳=0` —
migration `002` 가 `total_days_entitled` 를 `course_entitlements` 로 옮겼으나 **`trial_track` 은
기존 이용자에 백필하지 않음**. `findEntitlementDrift` 는 `trial_track = e.track` 일 때만
체험 3일을 기대하므로, `trial_start` 는 있는데 `trial_track` 이 NULL 인 legacy 1건이
경고로 남는다. **현재 코드 버그 아님.** 수동 조치: 해당 user 의 `trial_track` 을
실제 체험 코스로 UPDATE 하거나, entitlement 를 실측 후 맞춤. 자동 수정은 하지 않음
(maintain 설계).

열 공통: **ID** / **작업** / **담당**(`대표`·`개발`·`조건대기`) / **근거**.

### A. 지금 당장 (대표 실기·결정)

| ID | 작업 | 담당 | 근거 |
|---|---|---|---|
| **C4** | 실판매 모드 (`SALES_MODE=open`) 판단·투입 | 대표 | [live-check-c4-sales-open.md](docs/live-check-c4-sales-open.md). A3 완료 |
| **B1** | 프로필 편집 라이브 검증 | 대표 | [docs/live-check-profile.md](docs/live-check-profile.md). `/profile/start` → **302** 확인됨 |

### B. 개발 (남은 것)

| ID | 작업 | 담당 | 근거 |
|---|---|---|---|
| — | (현재 없음) | — | — |

### C. 결제 오픈 — C4만 남음

| ID | 작업 | 담당 | 근거 |
|---|---|---|---|
| **C4** | A3 완료 후 `SALES_MODE=open` 판단 | 대표 | [live-check-c4](docs/live-check-c4-sales-open.md) · [plan-journey](docs/plan-journey.md) §4 |

### D. 콘텐츠 입고

| ID | 작업 | 담당 | 근거 |
|---|---|---|---|
| — | (현재 없음) | — | — |

### E. 라이브 미검증 (코드·관문 통과, 실조건 대기)

아침 7시·저녁 6시 실발송은 **대표 확인 완료 (2026-08-06).**

| ID | 작업 | 담당 | 근거 |
|---|---|---|---|
| **E1** | 복습 퀴즈 (3의 배수 날) | 조건대기 | [live-check-quiz-review.md](docs/live-check-quiz-review.md) |
| **E2** | 절목 퀴즈 | 조건대기 | [live-check-quiz-checkpoint.md](docs/live-check-quiz-checkpoint.md) |
| **E3** | 기한 예고 | 조건대기 | [live-check-expiring.md](docs/live-check-expiring.md) · 잔여 2일 |
| **E4** | 다중 이용자 페이지네이션 | 조건대기 | [live-check-pagination.md](docs/live-check-pagination.md) · 500명+ |

### F. 끝남 / 잠김 (혼동 방지)

- **끝남**: 코스 선택 흐름, outage-billing 설계 2건, cron 3행, morning/evening 실발송, 관문 19종, 사이드 메뉴(B2),
  원고 업로드 도구([plan-upload-content](docs/plan-upload-content.md)),
  원고 FTP 계정·탈출 시험(A0), 본편 원고·운세 JSON 서버 반영(A1·D1·D2),
  초급 51〜101 착수점·검증 도구(D1b), 원고 CI 자동화(D1c — private repo → FTPS → deploy → seed),
  **A2 코스 선택 온보딩 라이브** (2026-08-07 대표 확인),
  **A5 결제 env 3값 + C1 cPanel 투입** (2026-08-07),
  **프로필 편집 B1** — 코드·배포 (`518c060`, `/profile/start` 302, migration `006`, LINE 「情報を変更」),
  **B3 maintain 드리프트 beginner 3/0** — migration 002 `trial_track` 미백필 legacy (§0 아래),
  **A4 gender 대운 — (다) 현행 유지(저장만)** (2026-08-07 대표 결정),
  **A3 Stripe 테스트** (2026-08-08 대표 확인),
  **C2 tokushoho.html** — 사이트 배포 (2026-08-08),
  **C3 리치メニュー** — LINE 등록 (2026-08-08, `richmenu-ad029399fabcc322b8050f8d92974678`),
  **D3 퀴즈 원고** — 3코스×51문=153, 서버 seed·`答え合わせ` 확인 (2026-08-08 대표 확인)
- **중지·종결**: **D0** — 로컬 `server/content/` 24JSON(초·중·고 303일) ChemiCloud **수동 FTPS·seed** (2026-08-08 대표 결정).
  로컬 `seed-content.mjs --check` ✓ (`beginner-01.json` 제거 후). **서버 반영 안 함·재개 예정 없음.**
  원고 반영은 **D1c** (private repo → FTPS → deploy → `.cpanel.yml` seed) 경로만 유지.
- **잠김(미완 아님)**: 실판매 모드 — C4 판단 전까지 `SALES_MODE` 는 test 유지
- **옛 계획**: [plan-p4-content.md](docs/plan-p4-content.md) — 렌더러·배치·원고 입고 전부 가동 중 (2026-08-07)

> 참고: 2026-08-05 보류였던 plan-outage-billing 의 설계 2건은 **2026-08-06
> 지시서로 승인·구현 완료** — 결제 트랜잭션·역방향 대조·재조준(아래 이력).

> **해소됨 (2026-08-05, `52ac6cc`)**: 본번 crontab 에 morning/evening 이
> 없던 문제 — 배포가 cron 3행(morning·evening 매시 / maintain 04:00 JST)을
> 자동 등록하도록 전환했고, 배포 로그와 `crontab -l` 실측으로 3행 전부
> 확인. 등록은 행 단위 멱등이라 중복되지 않는다. 이후 cron 은 화면이
> 아니라 `.cpanel.yml` 이 정본이다.

복습 퀴즈는 테스트 계정 라이브 검증 통과 (2026-08-05): 발신 판정·스킵
3케이스·실발송·즉답·미학습 차단·DB 쓰기 0. 통로는 `push-daily --user=<id>`.

배포 검증은 전부 끝났습니다 (2026-08-04): cron 두 줄 + `~/logs/` 등록 완료,
원고 수량 실측 `beginner 50` 확인. 배신은 다음 아침 7시(JST)부터 실전입니다.

---

## 1. 이 저장소에 무엇이 들어 있는가

두 개의 독립한 시스템이 한 저장소에 있습니다. **배포 경로가 완전히 다릅니다.**

```
저장소 (public)
├── 사이트 본체 (정적)  →  Xserver     GitHub Actions 가 main push 때 rsync
│     index.html 외 8장 + 공용 JS 7개
└── server/ (Node.js)   →  ChemiCloud  cPanel Git 또는 tools/deploy-server.sh (수동)
      LINE 101일 한국어 강좌 배신 시스템
```

`main` 에 push 하면 **사이트만** 배포됩니다. `server/` 는 따로 올려야 합니다.

---

## 2. 지금 동작하는 것 (실기 검증 완료)

[docs/research-line-flow.md](docs/research-line-flow.md) 에 실제로 도착하는 메시지까지
전부 찍어 두었습니다. 요약:

| | 상태 |
|---|---|
| 웹 진단 → LINE 연동 (state 30분, DB엔 해시만) | 동작 |
| 연동 직후 서비스 안내 | 동작 |
| 이름 선택 (사이트 이름 / LINE 표시명) | 동작 |
| 생년월일 진위 확인 (가짜면 사이트로 되돌림) | 동작 |
| 아침 7시 — 한국식 운세 + 그날 문법 + 회화 + 단어 | 동작 |
| 저녁 6시 — 같은 문법 복습 (일수 소비 안 함) | 동작 |
| 코스별 선불 횟수권 · 결제 · 만료예고 · 재개 · 수료 | **코드 완성 / 잠김** |

받침에 따라 조사가 바뀌는 것까지 맞습니다 —
「다케다 하나코**예요**」「다케다 하나코**는**」(받침 없음).

---

## 3. 결제 오픈 — A3·C2·C3 완료 (2026-08-08), C4만 남음

A5·C1 env 입력 · A3 Stripe 테스트 · C2 `/tokushoho` · C3 리치メニュー 완료.
`SALES_MODE` 는 **test** 유지 — C4 에서 `open` 판단.

| 환경변수 | 역할 | 비고 |
|---|---|---|
| `TOKUSHOHO_URL` | 특정상거래법 표기 URL | `https://www.kstudy101.jp/tokushoho` (C2 배포 후 200 확인) |
| `REFUND_POLICY` | 환불 규정 1줄 | tokushoho §返品·キャンセル 과 동일 문구 |
| `RICHMENU_IMAGE` | 리치メニュー 2500×1686 | `server/assets/richmenu.jpg` (등록 완료) |

**리치메뉴 이미지가 필요한 이유** — LINE은 「이미지 1장 + 누를 수 있는 좌표」로
메뉴를 만듭니다. 글자를 따로 보내는 방법이 없어서, 글자도 이미지 안에 그려야 합니다.

```
┌─────────────┬─────────────┬─────────────┐
│  강좌 안내   │   수강료     │   내 진도    │   ← 상단 2/3
├─────────────┴─────────────┴─────────────┤
│              문의하기                     │   ← 하단 1/3
└──────────────────────────────────────────┘
```

이미지가 준비되면:
```bash
node tools/setup-richmenu.mjs --dry-run           # 좌표만 확인
node tools/setup-richmenu.mjs --image=menu.png    # 등록 (1회만)
node tools/setup-richmenu.mjs --list              # 지금 뭐가 걸려 있나
```

---

## 4. 다음 컴퓨터에서 처음 할 일

```bash
git clone https://github.com/Kstudy101/codespaces-blank.git
cd codespaces-blank

# 관문 19종. DB도 npm install 도 필요 없습니다 (의존은 mysql2 하나뿐)
for f in saju fortune study name omikuji gilbang amulet birth pages \
         server webhook onboarding render push fortune-server evening billing quiz kana; do
  node tools/verify-$f.mjs >/dev/null && echo "PASS $f" || echo "FAIL $f"
done
```

**Windows 라면** `.gitattributes` 가 LF로 맞춰주므로 그대로 돌아갑니다.
(예전엔 CRLF 체크아웃에서 2종이 못 돌았습니다 —
`verify-amulet` / `verify-onboarding` 이 소스를 정규식으로 뜨면서 `\n` 을 직접 씁니다.)

---

## 5. `server/` 를 배포할 때 — ★ 되돌릴 수 없는 한 줄이 있습니다

> **2026-08-04: 첫 배포 완료.** 아래 002 는 본번에 적용 끝났으므로, 다음 배포부터는
> 이 절이 「이미 지나간 주의」가 됩니다. 새 migration 을 만들 때 다시 읽으십시오.
> 배포 절차와 이번에 밟은 함정은 [docs/plan-deploy-server.md](docs/plan-deploy-server.md) /
> [docs/plan-deploy-hang.md](docs/plan-deploy-hang.md) 에 있습니다.

`server/db/migrations/002-per-course-billing.sql` 안에:

```sql
ALTER TABLE subscriptions DROP COLUMN total_days_entitled;
```

데이터는 그 앞의 `INSERT ... SELECT` 로 `course_entitlements` 에 옮겨집니다.
`migrate.mjs` 가 표·열의 존재를 이름으로 다시 세므로, 옮기기가 실패하면
거기서 멈춥니다. **그래도 흘리기 전에 DB 백업을 받으십시오.**

배포 경로는 세 가지 (2026-08-05 부터 자동이 기본):

```bash
# (0) 자동 — server/** 가 바뀐 push 를 GitHub Actions 가 관문 19종 통과 후
#     cPanel UAPI 로 배포합니다 (.github/workflows/deploy-server.yml).
#     Secrets 3개가 등록돼 있어야 하며, 미설정이면 조용히 건너뜁니다.
#     ★ 되돌릴 수 없는 migration 을 쓸 때는 push 전에 DB 백업 —
#       자동화 이후 그것이 유일한 안전선입니다.

# (가) cPanel Git Version Control — 자격정보가 필요 없습니다 (브라우저만)
#      cPanel 화면 → Git Version Control → "Update from Remote"
#                                        → "Deploy HEAD Commit"
#      .cpanel.yml 이 자동으로:
#        코드 배치 → 운세엔진 복사 → npm install → migrate → (content 있으면) seed → 재기동

# (나) 손으로 — 아래 자격정보가 그 기기에 있어야 합니다
bash tools/deploy-server.sh --probe    # 먼저 향쪽을 조사만
bash tools/deploy-server.sh            # 보내고 재기동
```

**(나)에 필요한 것 — 저장소에 없습니다. 기기마다 따로 놓아야 합니다.**

| 위치 | 내용 |
|---|---|
| `~/.config/kstudy101/chemicloud.conf` | `CHEMI_HOST` / `CHEMI_USER` / `CHEMI_PORT` |
| `~/.ssh/chemicloud` | SSH 비밀키 (`chmod 600`) |
| `~/.config/kstudy101/cpanel.token` | cPanel API 토큰 (`tools/cpanel.sh` 용) |

> ChemiCloud는 SSH 포트를 IP 단위로 막습니다. 새 기기에서 (나)가 안 되면
> **(가)를 쓰십시오** — 브라우저만 있으면 되고, 실행되는 내용은 같습니다.

**본번 DB 접속정보는 저장소에도 `.env`에도 없습니다.**
cPanel → Setup Node.js App → Environment variables 가 유일한 출처입니다
(`db/with-env.mjs` 가 거기서 읽어옵니다).

### 5.1 원고를 올리는 길은 배포와 별개입니다

배포 3경로는 `content/` 를 **제외**합니다(지우지 않기 위해). 그래서 원고는 따로 올립니다.

```bash
bash tools/upload-content.sh --dry-run server/content/beginner-51-60.json   # 무엇이 어디로
bash tools/upload-content.sh server/content/beginner-51-60.json            # 보낸다
bash tools/upload-content.sh --list                                        # 저쪽에 뭐가 있나
```

**cPanel API 토큰을 쓰지 않습니다** — 토큰엔 범위 제한이 없어 원고 1개를 위해 전권을 넘기게 됩니다.
대신 **원고 전용 FTP 계정**(Directory 를 `kstudy101-line/content` 로 고정, Quota 50MB)을 씁니다.
디렉터리 제한이 계정 자체에 붙으므로, 이 스크립트가 넓게 쓰이는 사고가 구조적으로 안 납니다.

| 위치 | 내용 |
|---|---|
| `~/.config/kstudy101/ftp-content.conf` | `FTP_HOST` / `FTP_USER` / `FTP_PASS` / `FTP_DIR=/` (`chmod 600`) |

FTPS 고정(평문 금지)·비밀번호는 명령행에 안 올림·**삭제 기능 없음**·올린 뒤 원격 크기 대조.
이 약속들은 `verify-server` 의 `[原稿の送り口]` 9항목이 지킵니다.
설계와 확인 절차는 [docs/plan-upload-content.md](docs/plan-upload-content.md).

---

두 경로 모두 **`content/` `.env` `tmp` `public` `stderr.log` 를 지키도록** 되어 있습니다.
`server/content/`(101일 원고)는 **저장소에 없고 서버 위에만** 있으므로,
여기가 뚫리면 유일한 사본이 사라집니다. 제외 목록 7개는 세 경로가 전부 동일해야 합니다.

배포 후 확인:
```bash
curl -s https://api.kstudy101.jp/health
node db/with-env.mjs db/check-line.mjs    # LINE 쪽 설정을 LINE 에게 물어봄 (cron 에서)
node db/with-env.mjs db/who.mjs           # 배신 대상 상태 (이름·생년월일은 안 나옴)
node db/with-env.mjs db/lapsed.mjs        # 이탈 장부
```

---

## 6. 아직 없는 것

| | 비고 |
|---|---|
| **특정상거래法 표기 페이지** | ~~`tokushoho.html` 미작성~~ — C2 배포 완료 (2026-08-08) |

> **2026-08-07 해소:** 101일 원고·`fortune-lines.json` 은 **서버 `content/` 에 입고 완료**
> (저장소에는 없음 — 유료물). push 시 private repo 워크플로가 FTPS → deploy → seed 까지 자동 실행.

---

## 7. 읽는 순서 (문서)

| 파일 | 언제 읽나 |
|---|---|
| **STATUS.md** (이 파일) | 이어받을 때 제일 먼저 |
| [instruction.txt](instruction.txt) | 작업 방식(리서치→계획→주석→구현→피드백) |
| [CLAUDE.md](CLAUDE.md) | 위의 요약. Claude Code 가 자동으로 읽음 |
| [docs/research.md](docs/research.md) | 저장소 전체가 어떻게 동작하는가 (2026-08-03) |
| [docs/research-audit.md](docs/research-audit.md) | 전수 점검 결과 (2026-08-04) |
| [docs/research-line-flow.md](docs/research-line-flow.md) | LINE 연동 요구사항별 실기 검증 |
| [docs/plan-billing.md](docs/plan-billing.md) | 선불 횟수권 설계·구현 결과 |
| [docs/plan-audit-fixes.md](docs/plan-audit-fixes.md) | 전수 점검에서 나온 것의 수정 결과 |
| [docs/plan-fortune-content.md](docs/plan-fortune-content.md) | 운세 콘텐츠 확장 (사이트 쪽) |
| [docs/plan-fortune-daily.md](docs/plan-fortune-daily.md) | 운세 배신 |
| [docs/plan-p4-content.md](docs/plan-p4-content.md) | 원고 입고 — 완료 (2026-08-07) |
| [docs/plan-content-ci.md](docs/plan-content-ci.md) | 원고 CI 자동화 — 완료 (D1c) |
| [docs/plan-deploy-server.md](docs/plan-deploy-server.md) | 배신 서버 배포 절차와 결과 (2026-08-04) |
| [docs/plan-deploy-hang.md](docs/plan-deploy-hang.md) | 배포 중 npm ci 사고의 경위와 수정 |
| [docs/live-check-line-onboarding.md](docs/live-check-line-onboarding.md) | 코스 선택 온보딩 라이브 검증 (A2) |
| [docs/live-check-quiz-review.md](docs/live-check-quiz-review.md) | 복습 퀴즈 라이브 (E1) |
| [docs/live-check-quiz-checkpoint.md](docs/live-check-quiz-checkpoint.md) | 절목 퀴즈 라이브 (E2) |
| [docs/live-check-expiring.md](docs/live-check-expiring.md) | 기한 예고 (E3) |
| [docs/live-check-pagination.md](docs/live-check-pagination.md) | 500명+ 배치 (E4) |
| [docs/plan-profile.md](docs/plan-profile.md) | 프로필 편집 — 배포 완료, 라이브 대기 (B1) |
| [docs/plan-tokushoho.md](docs/plan-tokushoho.md) | 特定商取引法 표기 — 승인·문안 대기 (C2) |
| [docs/plan-side-menu.md](docs/plan-side-menu.md) | 사이드 메뉴 개편 — 완료 (B2) |
| [docs/plan-content-51-101.md](docs/plan-content-51-101.md) | 초급 51〜101 착수점 — 완료 (D1b) |
| [docs/system-overview.txt](docs/system-overview.txt) | 시스템 전반 |

---

## 8. 이 저장소에서 특히 조심할 것

읽지 않으면 반드시 밟는 것들입니다. 자세한 이유는 각 파일 머리말에 있습니다.

1. **잔여 일수는 `days_entitled - days_used`.** `current_day` 로 세면 안 됩니다 —
   「1일차부터 다시」로 `current_day` 가 0이 되므로, 받은 일수가 공짜가 됩니다
2. **`advanceDay` 는 일자 확보와 일수 소비를 한 문장에서** 합니다. 나누면 그 사이에
   죽었을 때 하루가 공짜가 됩니다
3. **운세 엔진(`saju.js`/`fortune.js`)의 사본을 `server/` 에 두지 마십시오.**
   `node:vm` 으로 사이트의 1부를 그대로 실행합니다. 사본을 두면 웹과 LINE의
   운세가 갈라지고, 양쪽 다 그럴듯한 숫자라 대조 전엔 아무도 모릅니다.
   유일한 예외가 `server/lib/kana2hangul.mjs`(가나→한글) — **허가된 사본**이며,
   `verify-kana` 가 index.html 실물과 전수 대조합니다(2026-08-05, Phase 1)
4. **`repo/` 는 `mysql2` 도 `node:` 내장도 읽지 않습니다.** 넘겨받은 `conn.execute()` 만.
   그 덕에 관문 19종이 `npm install` 없이 돕니다
5. **의존은 `mysql2` 하나뿐입니다.** Stripe SDK 도 LINE SDK 도 넣지 않았습니다
6. **폴리시(privacy.html)와 코드가 어긋난 적이 4번 있습니다**(GA4·Clarity·LINE·성별).
   저장하는 항목을 늘리면 반드시 제2항도 같은 커밋에서 고치십시오
7. **`learning_progress` 의 행을 손으로 지우지 마십시오.** `days_used` 가 같이
   사라져 잔여일수가 복활하고(잔여 = entitled - used), 배신 대상 JOIN 에서
   무음 탈락합니다. 접점 자기복구(healProgress)가 행은 되살리지만
   **days_used 는 되돌릴 수 없습니다** (docs/research-onboarding-gap.md)
8. **`build-site.sh` 의 `PUBLIC` 배열에 없는 파일은 배포되지 않습니다.**
   페이지를 추가하면 `PUBLIC` / `set-site-url.py` 의 `TARGETS` / `sitemap.xml` /
   `deploy.yml` 의 스모크 테스트 **4곳 전부**를 고쳐야 합니다
9. **원고 재배치(seed)는 저녁 배치(JST 18시) 전에 끝내십시오.**
   저녁 복습의 답은 「こたえを見る」를 누른 순간 다시 계산됩니다
   (지시서⑨). 18시 발송과 탭 사이에 그날 원고를 갈아끼우면 문제와
   답이 어긋납니다 — 방어 코드는 없고, 이 운용 규칙이 유일한 방어입니다

---

## 9. 최근 작업 이력

| 커밋 | 내용 |
|---|---|
| (STATUS) | **D 콘텐츠 입고 완료** — 본편 원고·`fortune-lines.json` 서버 반영, private repo CI(FTPS→deploy→seed) 가동 확인. A0·A1·D1·D1b·D1c·D2 → §F |
| `0f94fee` | 원고 전용 FTP 계정과 `tools/upload-content.sh` (지시서⑬) — 전권 토큰 대신 `content/` 에 갇힌 계정 하나로. FTPS 강제·비밀번호 비노출·삭제 없음·크기 대조. `verify-server` +9 (84→93), 변이 시험 8종 전부 검출. [plan-upload-content](docs/plan-upload-content.md) |
| (§2) | 코스 선택을 온보딩 말미에 — track 단계·trackpick(판매 게이트 밖)·즉시 1일차·체험 중 기한예고 억제·trial_end 신설(004)·askCourse pick 변형. C2 연동 안내 2건(7880092)과 같은 배포 |
| `db20b17` | 아침 배치 장애 대응(승인 C=A+B) — failed 로 남은 확보 완료일을 advanceDay 없이 재조준(retryKey 동일) + `--not-after` 배송 창 상한. verify-push 48항목 (관문 580) |
| `e1f3c9f` | 결제 경로 보강 3건 — creditPurchase·startTrial 을 트랜잭션(transact 주입)으로 / 역방향 대조 findMissingEntitlements(검출만, maintain 3.5절) / async_payment_succeeded 수용. verify-billing 56항목 |
| `14b57f4` | §3 pending_links 청소 크론(maintain.mjs) — 폴리시의 「30분 삭제」를 코드가 지킴. 등록은 .cpanel.yml 이 배치마다 확인. 본번 실측: 만료 24건 검출 |
| `906b6ac` | §2 조용히 사라지는 길 2개 — 재추가 복귀(잔여 유→active/무→trial) + 읽기 대기를 blockingStep 에 편입 + 읽기 50자 절단. 재현 관문 3종 선행 |
| `8b12063` | §1 마이그레이션 적용 이력(schema_migrations) — 배포마다 001부터 재실행되던 것 종식. 본번 부트스트랩 표침 3개 적중 실증. smoke 에 migrate 2회 연속 검사 |
| `2ffbaaa` | smoke 저녁 검사의 잠복 결함 — 실물 흐름의 setActiveTrack 이 빠져 통과 불가능했다 (002 이후 처음으로 실 DB에서 smoke 를 돌려 발견) |
| `53f053c` | `push-daily --user` — 본번 실동작 검증용 1인 전용 경로 + dry-run 문면 표시 |
| `db1fa01` | `merge-quiz.mjs` — 퀴즈 원고를 일별 원고에 차입 (커리큘럼 대조 내장) |
| `4b8c8f4` | 3일 주기 복습 퀴즈 (계획: plan-quiz.md) — 관문 18종 521항목 |
| `660915a` | 배포에서 `npm ci` 를 쓰지 않는다 — Selector 의 symlink 를 지우기 때문 (§9.2) |
| `d4937fd` | LLM 행동 지침 4원칙(`CLAUDE-karpathy.md`)을 `CLAUDE.md` 가 불러오게 함 |
| `07a78fd` | STATUS.md(이 파일) 도입 + 리팩터링이 남긴 미사용 import 정리 |
| `23ec595` | 선불 횟수권 — 코스별 일수·Stripe·리치메뉴·이탈 장부·수료. 관문 `verify-billing` 신설 |
| `8325068` | LINE 연동 버그 2건 수정 — 답한 질문이 반복되는 것 / 생년월일 건너뛰면 배치가 매일 죽는 것 |
| `ce2f176` | 배포 경로가 서버에만 있는 원고를 지우던 것 수정 + 성별 폴리시 문구 |
| `74879e1` | `instruction.txt` / `CLAUDE.md` 도입 |

### 9.1 마지막 배포 (2026-08-04)

`07a78fd` 를 `main` 에 push → GitHub Actions 성공.

```
관문 17종        전부 success
Build dist       25 파일
Guard destination  전송처 확인 (WordPress 등이 없는지)
Deploy (rsync)   Xserver
Smoke test       success
```

라이브 확인:

```
https://www.kstudy101.jp/privacy   새 문구(성별「未回答」) 반영 확인
/ /privacy /tips /amulet /gilbang /omikuji /words /contact  전부 200
/birth.js /saju.js                                          전부 200
```

**이 배포에 `server/` 는 포함되지 않습니다.** 사이트만입니다(§1).

### 9.2 배신 서버 첫 배포 (2026-08-04, ChemiCloud)

경로 (가) — cPanel Git Version Control, 브라우저만으로. 커밋 `660915a`.

**밟은 함정 (다음 사람은 안 밟도록):**

1. **`npm ci` 가 CloudLinux Selector 의 symlink 를 파괴** — ci 는 `node_modules` 를
   지우고 다시 만드는데, 지워진 것이 `~/nodevenv/` 를 가리키는 링크였음.
   증상: Run NPM Install 이 「node_modules という名前の実体を置くな」로 거부.
   복구: File Manager 로 실체 폴더 삭제 → Setup Node.js App 에서 Restart →
   링크 재생성 → Run NPM Install 성공. 재발 방지: `660915a` 가 두 배포 경로
   모두 `npm install` 로 변경 (자세한 경위는 [docs/plan-deploy-hang.md](docs/plan-deploy-hang.md))
2. **cPanel UI 의 「in progress」는 믿을 수 없음** — 시스템 태스크 큐 로그로는
   10초 만에 Task finished 인데 화면은 계속 in progress. 판정은 화면이 아니라
   `tmp/restart.txt` 의 수정 시각으로 할 것 — 12개 작업이 `set -e` 로 이어져
   있고 restart.txt 가 마지막이므로, 갱신됐다면 migrate 가 0 으로 끝난 것

**확인된 것:** `/health` → `ok` / `tmp/restart.txt` 갱신 / 태스크 큐 Task finished (10초) /
원고 수량 실측 `beginner 50` (phpMyAdmin) / cron 두 줄 + `~/logs/` 등록 (같은 날 완료).
