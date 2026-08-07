# 계획서 — 컨텐츠 추가를 위해 구축할 것

작성: 2026-08-07 / 선행: [research-content-add.md](research-content-add.md)  
상태: **승인 대기** (구현하지 않음)

> 「컨텐츠를 더 넣으려면 무엇을 만들면 좋은가」에 대한 구상·결정안.
> 대표님 검토·승인 전까지 코드·원고를 쓰지 않는다.

---

## 0. 권고 한 줄

**CMS/관리 UI는 짓지 않는다.**  
이미 있는 `content-check → seed → dry-run` 위에  
**(가) 재고 리포트 + (나) 로컬 일괄 검사 + (다) CONTENT_DIR 정렬**만 얇게 얹고,  
본작업은 **집필·서버 업로드**로 간다.

---

## 1. 문제 정의

| 오해 | 실제 |
|---|---|
| 「컨텐츠 추가 = 새 배신 시스템」 | 배신·렌더·관문은 동작 중 |
| 「CMS가 있어야 쓴다」 | JSON + seed upsert가 입고 API |
| 「도구만 있으면 채워진다」 | 병목은 303일 집필과 퀴즈·운세 문면 |

막을 실패 모드:

- 공개 repo에 원고가 들어가는 것  
- 배포/동기화가 `content/` 유일 사본을 지우는 것  
- 저녁 18시 전후에 같은 날 원고를 갈아 끼워 Q/A가 어긋나는 것  
- 스테이징과 라이브 경로가 섞여 cron이 미검증 원고를 읽는 것  
- P9 CMS를 지금 범위에 끌어들여 의존·인증 표면을 키우는 것

---

## 2. 접근 방식 (권고안 = 옵션 B)

세 층을 나눈다. **동시에 다 하지 않는다.**

```
층 0  집필·입고 (도구 없이 STATUS §1 실기)     ← 지금 막힌 본선
층 1  얇은 하네스 (아래 §3)                   ← 승인 후 코드
층 2  비공개 이력 / P9 UI                     ← 명시 지시 전 제외
```

### 층 0 — 구축 없이 컨텐츠를 넣는 정본 절차

STATUS와 동일. 문서만 보강해도 된다 (`docs/runbook-content-intake.md` 후보).

1. 로컬에서 일별 JSON (또는 quiz sidecar → `merge-quiz --write`)  
2. `node db/seed-content.mjs --check` (및 fortune-lines면 `checkLines`)  
3. File Manager로 `server/content/` 업로드 (**git 금지**)  
4. 본번: `seed --check` → `seed`  
5. `push-daily --user=<시험계정> --dry-run` 문면 3통  
6. **같은 날 교체는 JST 18시 저녁 배치 전에 끝낼 것**

우선 집필 큐 (기존 STATUS와 정합):

| 순위 | 내용 | 이유 |
|---|---|---|
| 1 | 중급·고급 1–3일 + `fortune-lines.json` | §1 착수 대기, 로컬 검증 완료분 |
| 2 | 초급 `quiz` 백필 (복습·30/50/75) | 코드는 이미 침묵 중 |
| 3 | 초급 51–101 | curriculum.md 참조, 형식 검증됨 |
| 4 | 중급·고급 4일 이후 | 1–3 dry-run 통과 후 확장 |

### 층 1 — 구축할 것 (작음, 이득 큼)

#### (가) 재고 리포트 — `server/db/content-inventory.mjs` (신규)

DB 없이도 디스크만, 또는 `with-env`로 DB missing와 대조.

출력 예:

```
track          days   quiz   missing ranges
beginner       50     0      51-101
intermediate   0      0      1-101
advanced       0      0      1-101
fortune-lines  OK|MISSING|INVALID
```

기존 `findMissingTemplateDays` / seed 끝 출력을 묶는 읽기 전용 도구.
`who.mjs`·`lapsed.mjs`와 같은 **운영자 CLI** 패밀리.

#### (나) 로컬 일괄 검사 — `server/db/content-pack-check.mjs` (신규) 또는 seed 플래그

한 디렉터리를 받아:

1. day JSON → `checkAll` (기존)  
2. `fortune-lines.json` 있으면 `checkLines`  
3. 요약 exit code (CI/로컬 동일)

새 의존 없음. 관문 `verify-*`에 원고 실물을 넣지 않는다 (공개 repo 규칙).

#### (다) `CONTENT_DIR` 정렬 — `seed-content.mjs` 소패치

`merge-quiz.mjs`와 같이:

```js
const CONTENT_DIR = process.env.CONTENT_DIR
  || path.join(SERVER_DIR, "content");
```

스테이징 예: `CONTENT_DIR=./content-staging npm run seed:check`  
cron·본번 기본 경로는 그대로 `server/content/`. 환경변수 없을 때 동작 불변.

### 층 2 — 제외 (scope 밖) 또는 후순위 결정

| 후보 | 취급 | 이유 |
|---|---|---|
| 웹 CMS / P9 운영 UI | **제외** | 인증·새 표면·의존. 별도 계획 전까지 금지 |
| HTTP seed/push API | **제외** | plan-p4 기각 |
| private git for 원고 | **결정 필요 ①** | 이력·리뷰에 유리, 유출·동기 비용 |
| 서명 tarball + SCP | private git 대안 | CI에서 check만, 본번 업로드는 수동/스크립트 |
| LLM 일괄 생성기 | **제외** | 품질 책임을 도구가 못 짐. 사람이 쓰고 기계가 검사 |
| 초급 51+ 자동 생성 | **제외** | 집필 작업이지 구축이 아님 |

---

## 3. 결정이 필요한 것 (기술 선택은 대표님)

### 결정 ① — 원고 이력 보관

| | (가) File Manager만 (현상) | (나) private repo / 암호화 아티팩트 |
|---|---|---|
| 이력·diff | 약함 | 강함 |
| 유출면 | 서버 권한 = 유일 위험 | clone/CI 권한 추가 |
| 구축량 | 0 | 동기·ignore·배포 exclude 재확인 |
| 권고 | **당분간 (가)** — §1 실기 먼저 | 중급 전량 들어가기 전에 재검토 |

### 결정 ② — 층 1 하네스를 이번 사이클로 넣을지

| | (가) 문서 runbook만 | (나) inventory + pack-check + CONTENT_DIR |
|---|---|---|
| 코드 diff | 없음 | 작음 (신규 1–2 + seed 수줄) |
| 반복 입고 | 손 체크리스트 | 한 명령으로 재고·형태 |
| 권고 | §1만 급하면 (가) | **컨텐츠를 계속 넣을 거면 (나)** |

### 결정 ③ — 집필 우선순위

STATUS §1(중급·고급 1–3 + fortune-lines)을 유지할지,  
퀴즈 백필을 끼워 넣을지. **배신 체감**은 fortune-lines·quiz가 크고,  
**코스 상품**은 중급·고급 일수다.

권고: §1 순서 유지 → dry-run 통과 후 quiz 백필 → 초급 51+.

---

## 4. 승인 시 코드 변경 스케치 (아직 구현 안 함)

### 4.1 수정·추가 파일

| 경로 | 변경 |
|---|---|
| `server/db/content-inventory.mjs` | **신규** — 디스크±DB 재고 |
| `server/db/content-pack-check.mjs` | **신규** — checkAll + checkLines 일괄 |
| `server/db/seed-content.mjs` | `CONTENT_DIR` env 수용 (기본값 불변) |
| `server/package.json` | `"content:inv"`, `"content:pack"` 스크립트 (선택) |
| `docs/runbook-content-intake.md` | **신규** — 층 0 절차 (결정 ②에서 문서만이면 이것만) |
| `STATUS.md` | 다음 작업에 하네스/입고 링크 |

관문: 신규 CLI는 DB 없이 디스크 모드가 돌아야 하고,  
기존 `verify-*` 19종을 깨지 않아야 한다.  
원고 실물을 저장소·관문에 넣지 않는다.

### 4.2 스니펫 — CONTENT_DIR (seed)

```js
// seed-content.mjs (현재는 고정 경로)
const CONTENT_DIR = process.env.CONTENT_DIR
  || path.join(SERVER_DIR, "content");
```

### 4.3 스니펫 — inventory 디스크 모드 골격

```js
// content-inventory.mjs (구상)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { checkLines } from "../lib/fortune-text.mjs";
import { learning } from "../lib/repo/index.mjs";

function scanDays(dir) {
  const byTrack = Object.fromEntries(learning.TRACKS.map((t) => [t, new Set()]));
  const quiz = Object.fromEntries(learning.TRACKS.map((t) => [t, new Set()]));
  // days 배열 있는 JSON만 (seed 와 동일하게 형태로 판별)
  // day_number / quiz 유무를 track별로 집계
  return { byTrack, quiz };
}
```

### 4.4 스니펫 — pack-check

```js
// content-pack-check.mjs (구상)
import { checkAll } from "../lib/content-check.mjs";
import { checkLines, /* load raw */ } from "../lib/fortune-text.mjs";

const dir = process.env.CONTENT_DIR || defaultContent;
const days = loadDayFiles(dir);          // seed.load 와 같은 규칙
const problems = checkAll(days);
const fl = path.join(dir, "fortune-lines.json");
if (existsSync(fl)) problems.push(...checkLines(JSON.parse(readFileSync(fl, "utf8"))));
process.exit(problems.length ? 1 : 0);
```

기존 `checkAll` / `checkLines`를 **호출만** 한다. 검사 규칙을 복제하지 않는다.

---

## 5. 트레이드오프

| 선택 | 얻는 것 | 잃는/위험 |
|---|---|---|
| 하네스만 (권고) | 반복 입고 실수↓, diff 작음, 의존 0 | WYSIWYG 없음 — dry-run이 미리보기 |
| CMS (비권고) | 브라우저 편집 | 인증·폴리시·스택. 이 저장소 제약과 충돌 |
| private repo 즉시 | 이력 | §1 실기보다 인프라가 앞섬 |
| 문서만 | 즉시 집필 가능 | 재고·퀴즈 공백을 계속 손으로 셈 |

LINE 5통 한도·이름 슬롯·조사 규칙·운세 엔진 비복제는 **기존 그대로**.
하네스가 렌더/배치 순서를 바꾸지 않는다.

---

## 6. 구현 체크리스트 (승인 후)

- [ ] 결정 ①②③ 반영해 이 문서 갱신  
- [ ] (결정 ②=나) `CONTENT_DIR` seed 정렬 + 관문/수동 확인  
- [ ] (결정 ②=나) `content-inventory.mjs` 디스크 모드  
- [ ] (결정 ②=나) DB 모드(`with-env`) missing 대조 — 선택  
- [ ] (결정 ②=나) `content-pack-check.mjs`  
- [ ] `docs/runbook-content-intake.md` (18시 규칙 포함)  
- [ ] STATUS.md §0/§6에 링크  
- [ ] 관문 19종 PASS  
- [ ] **원고 본문·fortune-lines 실물은 커밋하지 않음**

---

## 7. 제외 (scope 밖) — 명시

- 중급·고급·초급 51+ **문장 집필** (별도 사람 작업 / STATUS §1)  
- Stripe·특상법·리치메뉴 (§3)  
- plan-profile 전제 (gender 대운 등)  
- P9 운영자 웹 UI  
- 사이트(Xserver) 새 페이지  
- 운세 엔진 server/ 사본  
- 새 npm 의존성

---

## 8. 대표님께 부탁하는 응답

계획 문서에 메모로 남겨 주시면 반영만 하고 **구현은 그 다음 지시**로 한다.

1. 결정 ① 원고 이력: (가) File Manager만 / (나) private 등  
2. 결정 ② 하네스: (가) runbook만 / (나) inventory+pack-check+CONTENT_DIR  
3. 결정 ③ 집필 순서: STATUS §1 유지 or 변경  
4. 거부·추가 제약 (예: 「DB 모드는 쓰지 마라」「스크립트 이름 지정」)

승인 문장 예: 「결정 ①가 ②나 ③유지 — 층 1 구현해」  
또는 「구상만 채택, 코드는 §1 실기 끝나고」
