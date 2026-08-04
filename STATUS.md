# STATUS.md — 지금 어디까지 왔고, 다음에 뭘 해야 하는가

최종 갱신: 2026-08-04 (배신 서버 첫 배포 후) / 기준 커밋: `660915a`

> **다른 컴퓨터에서 이어받을 때 이 파일부터 읽으십시오.**
> 그 다음 [instruction.txt](instruction.txt) → [CLAUDE.md](CLAUDE.md) 순서입니다.

---

## 0. 30초 요약

- 사이트(정적)는 **Xserver에서 가동 중** — https://www.kstudy101.jp/
  `main` 에 push 하면 GitHub Actions 가 자동 배포합니다
- LINE 배신 서버(`server/`)는 **ChemiCloud 에 배포 완료** (2026-08-04, `660915a`) —
  마이그레이션 002(되돌릴 수 없는 DROP COLUMN 포함)까지 본번 적용 끝. §9.2
- 결제(선불 횟수권)는 **코드 완성, 의도적으로 잠겨 있음** — §3
- 관문(자동 검증) **18종 전부 통과**

**다음에 할 일은 하나입니다.**

1. **§3의 값 3개를 정한다** — 그게 없으면 결제가 안 열립니다

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

## 3. ★ 막혀 있는 것 — 값 3개가 필요합니다

결제 동선은 **일부러 열리지 않게** 해두었습니다. 미완성이 아니라 잠금입니다.
표시 의무를 채우기 전에 조용히 팔리는 쪽이 훨씬 무겁기 때문입니다.

`server/.env`(본번은 cPanel → Setup Node.js App → Environment variables)에
다음이 비어 있으면 **가격표 자체가 안 나옵니다.** 누르면 「준비중」이라고 답하고,
서버 기동 로그에 **무엇이 없는지 이름으로** 나옵니다.

| 환경변수 | 무엇인가 | 왜 코드로 못 채우는가 |
|---|---|---|
| `TOKUSHOHO_URL` | 특정상거래법에 기반한 표기 페이지 URL | **법인이 아니면 본명·자택주소·전화번호가 공개됩니다.** 대표님 판단 |
| `REFUND_POLICY` | 환불 규정 1줄 (가격표에 그대로 나감) | 사업 판단 |
| `RICHMENU_IMAGE` | 리치메뉴 이미지 2500×1686 (JPEG/PNG, 1MB 이하) | 디자인 자산 |

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

# 관문 18종. DB도 npm install 도 필요 없습니다 (의존은 mysql2 하나뿐)
for f in saju fortune study name omikuji gilbang amulet birth pages \
         server webhook onboarding render push fortune-server evening billing quiz; do
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

배포 경로는 두 가지:

```bash
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
| **101일 원고** | `server/content/` — 초급 약 50일치만 있고, 중급·고급은 0. 저장소에는 없음(유료물) |
| **운세 문면** | `server/content/fortune-lines.json` — 6항목 × 5등급 = 30칸 + 십신 10. 없으면 운세만 조용히 빠짐 |
| **특정상거래법 표기 페이지** | `tokushoho.html` 미작성 (§3 이 정해져야 씀) |
| **퀴즈 원고** | `quiz` 열은 생겼으나(003) 원고 0건 — 백필 전까지 복습 퀴즈는 조용히 빠짐 ([docs/plan-quiz.md](docs/plan-quiz.md) §3-8) |
| **절목 퀴즈의 발신** | 30/50/75일차. 수신·채점은 살아 있음(`tpl.quiz` 파싱, 003). 보내는 코드만 없음 — 후속 계획 |

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
| [docs/plan-p4-content.md](docs/plan-p4-content.md) | 원고 입고 |
| [docs/plan-deploy-server.md](docs/plan-deploy-server.md) | 배신 서버 배포 절차와 결과 (2026-08-04) |
| [docs/plan-deploy-hang.md](docs/plan-deploy-hang.md) | 배포 중 npm ci 사고의 경위와 수정 |
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
   운세가 갈라지고, 양쪽 다 그럴듯한 숫자라 대조 전엔 아무도 모릅니다
4. **`repo/` 는 `mysql2` 도 `node:` 내장도 읽지 않습니다.** 넘겨받은 `conn.execute()` 만.
   그 덕에 관문 18종이 `npm install` 없이 돕니다
5. **의존은 `mysql2` 하나뿐입니다.** Stripe SDK 도 LINE SDK 도 넣지 않았습니다
6. **폴리시(privacy.html)와 코드가 어긋난 적이 4번 있습니다**(GA4·Clarity·LINE·성별).
   저장하는 항목을 늘리면 반드시 제2항도 같은 커밋에서 고치십시오
7. **`build-site.sh` 의 `PUBLIC` 배열에 없는 파일은 배포되지 않습니다.**
   페이지를 추가하면 `PUBLIC` / `set-site-url.py` 의 `TARGETS` / `sitemap.xml` /
   `deploy.yml` 의 스모크 테스트 **4곳 전부**를 고쳐야 합니다

---

## 9. 최근 작업 이력

| 커밋 | 내용 |
|---|---|
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
