# plan-quiz.md — 3일 주기 복습 퀴즈 + 절목 퀴즈 기반 정비

> STATUS: **D3** (원고 백필) · **E1** (복습 라이브) — [STATUS.md](../STATUS.md) §0.

작성: 2026-08-04 / 근거: [research-quiz.md](research-quiz.md) / 기준 커밋: `0743a34`

> **상태: 구현 완료 (2026-08-04). 관문 18종 521항목 전부 통과.**
> 남은 것은 재배포와 퀴즈 원고 백필(§3-8)뿐. 대표님 확정사항 반영:
> ① 노선 (다) — 복습(`review`)과 절목(`quiz`) 분리, 절목일엔 복습 스킵
> ② Migration 003 — `content_templates.quiz JSON` + 초급 백필
> ③ text + quickReply 유지 (Flex 도입 안 함)
> ④ **승인 시 추가 (메시지 상한 억제):** 기한예고가 붙는 날은 복습 퀴즈를
>   쉰다 — 아침 배신을 상시 최대 4/5 통으로 유지해 LINE 상한과의 여유를 확보.

---

## 0. 범위

| 넣는 것 | 넣지 않는 것 (§6에 이유) |
|---|---|
| Migration 003 (`quiz` 열) | **절목 퀴즈의 발신** (30/50/75) — 후속 계획 |
| 복습 퀴즈 발신 (3일 주기, 아침 배신에 동봉) | 복습 결과의 저장·통계 |
| `action=review` 수신·즉석 채점 | Flex Message |
| 원고 검사·입고 경로에 quiz 추가 | 저녁 배신 변경 |
| 관문 `verify-quiz` 신설 | 중급·고급 백필 (원고가 0) |
| 초급 1~50일 퀴즈 백필 (원고 작업) | `privacy.html` — **저장 항목이 늘지 않으므로 불변** |

## 1. 동작 설계

```
아침 배신 (push-daily.mjs deliverOne)
  next = current_day + 1                     ← 오늘 보내는 일차
  next % 3 === 0                             ← 3의 배수 일차만
  && !(await isCheckpoint(next))             ← 절목일(30/50/75)엔 쉼 (30 % 3 = 0 충돌 회피)
  → pool: track 의 day_number <= next AND quiz IS NOT NULL 에서 1건 무작위
  → 있으면: 본문 뒤에 1통 추가 (text + quickReply, 선택지 버튼)
  → 없으면: 아무것도 안 붙이고 본편만 (Graceful Fallback)

수신 (postback.mjs)
  action=review&day=X&choice=N
  → X <= 그 사람의 current_day 확인          ← data 변조로 미학습일 정답 캐내기 방지
  → 그 날 원고의 quiz.answer 와 대조         ← 정답은 서버에만. data 에 싣지 않음
  → reply 1통: 「正解です！🎉」/「残念…　正解は ②〇〇」
  → DB 는 읽기만. 쓰지 않음                  ← quiz_pass_log(학기 합불)를 안 건드림
```

**메시지 수 상한** — 기한예고가 붙는 날은 복습 퀴즈를 쉽니다 (승인 시 결정 ④).
이로써 아침 배신은 **상시 최대 4통** (본편 2 + 운세 1 + {기한예고 또는 퀴즈} 1) —
LINE 상한 5에 대해 항상 1통의 여유. 기한예고는 일수당 1회뿐이라 퀴즈 공백도 하루입니다.

## 2. 수정 파일

| 경로 | 변경 |
|---|---|
| `server/db/migrations/003-review-quiz.sql` | **신규.** `quiz JSON NULL` 열 |
| `server/db/migrate.mjs` | `EXPECTED_COLUMNS` 에 1줄 |
| `server/lib/repo/learning.mjs` | `pickReviewQuiz()` 신설, `upsertTemplate` 에 quiz, `getTemplate` 반환에 quiz 파싱 |
| `server/lib/content-check.mjs` | quiz 형식 검사 (선택 항목) |
| `server/lib/render.mjs` | `renderReviewQuiz()` 신설 (순수 함수) |
| `server/db/push-daily.mjs` | `deliverOne` 에 동봉 분기 |
| `server/lib/handlers/postback.mjs` | `action=review` 분기 |
| `tools/verify-quiz.mjs` | **신규 관문** |
| `CLAUDE.md` / `STATUS.md` / `README.md` / `.github/workflows/deploy.yml` | 관문 17→18종 목록 갱신 (4곳) |

## 3. 상세와 스니펫

### 3-1. Migration 003

```sql
-- 003-review-quiz.sql
--
-- 복습 퀴즈의 원고. NULL 허용 ── 퀴즈가 없는 날은 그 날대로 정상이고,
-- 발신 쪽이 quiz IS NOT NULL 로 거른다 (원고 없으면 운세처럼 조용히 빠짐).
--
--   { "question": "…", "choices": ["…","…","…"], "answer": 2 }
--
-- answer 는 0 시작 첨자. 서버만 읽는다 ── postback data 에 싣으면
-- 누르기 전에 고쳐 써서 반드시 정답이 된다 (handlers/postback.mjs 머리말).
ALTER TABLE content_templates ADD COLUMN quiz JSON NULL;
```

`migrate.mjs`:

```js
const EXPECTED_COLUMNS = [
  ...
  ["lapse_log",          "lapsed_at"],
  /* 003. 복습 퀴즈 원고. 없으면 퀴즈만 조용히 빠진다. */
  ["content_templates",  "quiz"]
];
```

재실행 안전: `ADD COLUMN` 중복은 errno 1060 → `ALREADY_APPLIED` 가 삼킴 (기존 구조 그대로).

### 3-2. 무작위 추출 — `repo/learning.mjs`

```js
/* 복습 퀴즈를 1건 뽑는다. maxDay 이하만 ── 미학습 문법을 내지 않기 위해.
   표는 코스당 최대 101행이라 RAND() 비용은 없다. */
export async function pickReviewQuiz(conn, track, maxDay) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}`);
  const rows = await all(conn,
    `SELECT day_number, quiz FROM content_templates
      WHERE track = ? AND day_number <= ? AND quiz IS NOT NULL
      ORDER BY RAND() LIMIT 1`, [track, Number(maxDay)]);
  if (!rows.length) return null;
  const q = fromJson(rows[0].quiz);
  if (!q || !q.question || !Array.isArray(q.choices)
      || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
    return null;   /* 원고가 깨져 있으면 안 보낸다. 본편은 나간다 */
  }
  return { dayNumber: rows[0].day_number, ...q };
}
```

`upsertTemplate` — 인자에 `quiz = null` 추가, INSERT 열·`ON DUPLICATE KEY UPDATE` 에 `quiz` 추가.
`getTemplate` — 반환에 `quiz: fromJson(row.quiz)` (postback 채점부의 `tpl.quiz` 가 이걸 읽음 —
**기존 절목 채점부는 무수정으로 살아납니다**).

### 3-3. 문면 — `render.mjs` (순수 함수, verify-render 대상)

```js
/* 복습 퀴즈 1통. 선택지는 quickReply ── 온보딩·결제와 같은 형식.
   label 은 20자 제한(LINE 이 400 을 돌려줌). 잘라서 넣는다. */
export function renderReviewQuiz(quiz) {
  return {
    type: "text",
    text: `🔁 복습 퀴즈（${quiz.dayNumber}日目より）\n\n${quiz.question}`,
    quickReply: { items: quiz.choices.slice(0, 4).map((c, i) => ({
      type: "action",
      action: {
        type: "postback",
        label: `${"①②③④"[i]} ${String(c)}`.slice(0, 20),
        data: `action=review&day=${quiz.dayNumber}&choice=${i}`,
        displayText: `${"①②③④"[i]} ${String(c)}`.slice(0, 20)
      }
    })) }
  };
}
```

### 3-4. 발신 — `push-daily.mjs` `deliverOne`

기한예고 블록 뒤, `if (DRY || DISABLED)` 앞에 (읽기 전용이라 DRY 앞이어도 부작용 없음):

```js
/* ---- 3일 주기 복습 퀴즈 -------------------------------------------
   보내는 일차(next)가 3의 배수인 날만. current_day 로 세지 않는 것은
   current_day 가 「어제까지 보낸 수」이기 때문 ── 그걸로 세면 하루 어긋난다.

   절목일(30/50/75)은 쉰다. 30 % 3 = 0 이라 겹치는데, 같은 아침에
   퀴즈가 2건 나가면 어느 답이 어느 문제인지 섞인다. 절목 퀴즈가
   구현되는 날을 위해 자리를 비워 둔다.

   뽑히지 않으면(원고 없음/깨짐) 아무것도 안 붙인다. 본편은 나간다 ──
   운세(fortuneSection)와 같은 태도.

   ★ 이 1통으로 최악의 아침이 5통(본편2+운세+기한예고+퀴즈)이 된다.
     LINE 상한이 5. 다음에 통을 붙이는 사람은 여기부터 셀 것. */
if (next % 3 === 0 && !(await learning.isCheckpoint(conn, next))) {
  const quiz = await learning.pickReviewQuiz(conn, u.track, next);
  if (quiz) messages = [...messages, renderReviewQuiz(quiz)];
}
```

### 3-5. 수신 — `postback.mjs` (기존 quiz 분기 **앞**에)

```js
/* ---- 복습 퀴즈 (3일 주기) ------------------------------------------
   절목(action=quiz)과 딴 방 ── 저쪽은 학기 합불을 기록하고, 이쪽은
   아무것도 저장하지 않는다. 즉석 채점·답장뿐. 섞으면 9일차 오답이
   semester1 합불을 덮는다 (research-quiz.md §2). */
if (action === "review") {
  const day = int(params.day);
  const choice = int(params.choice);
  if (day === null || choice === null) {
    return { skipped: "day / choice が読めません", userId: user.id };
  }
  const track = user.active_track;
  if (!track) return { skipped: "受講中のコースがありません", userId: user.id };

  /* data 는 단말을 거쳐 돌아오므로 변조된다. 미학습일의 day 를
     자칭하면 정답을 캐낼 수 있으니, 그 사람의 진도로 확인한다. */
  const progress = await learning.getProgress(conn, user.id, track);
  if (!progress || day < 1 || day > progress.current_day) {
    return { skipped: `${day}日目はまだ学習していません`, userId: user.id };
  }

  const tpl = await learning.getTemplate(conn, track, day);
  const q = tpl?.quiz;
  if (!q || !Number.isInteger(q.answer)) {
    return { skipped: "この日のクイズがありません", userId: user.id, day };
  }

  const passed = choice === q.answer;
  const mark = "①②③④"[q.answer] || `${q.answer + 1}`;
  const replied = await reply(token, [{
    type: "text",
    text: passed
      ? "⭕ 正解です！🎉"
      : `❌ 残念…　正解は ${mark} ${q.choices?.[q.answer] ?? ""} でした`
  }], send);
  return { userId: user.id, action, day, choice, passed, replied };
}
```

### 3-6. 원고 검사 — `content-check.mjs`

quiz 는 **선택 항목**. 있으면: `question` 비지 않음 / `choices` 2~4개 문자열 /
`answer` 정수·범위 안. 검사 실패는 전체 중단 (seed 의 「전부 검사하고 1건째를
넣는다」 원칙 그대로 — 20일째에 떨어져 19일치만 들어가는 일이 없게).

### 3-7. 관문 — `tools/verify-quiz.mjs` (신규, DB·npm install 불요)

가짜 conn 을 넘겨 SQL 과 호출을 들여다봅니다 (verify-push 와 같은 방식). 시나리오는
지시서 4항 + 변조 2건:

1. 3의 배수가 아닌 날 → `pickReviewQuiz` 가 **불리지 않는다**
2. 3의 배수 → SQL 에 `day_number <= ?` 와 바인드값 = 보내는 일차 (미학습 배제)
3. 30일차(절목) → 복습이 **쉰다**
4. 퀴즈 0건 → 본편 통수 그대로, 에러 없음
5. 뽑힌 메시지의 data 에 **answer 가 실려 있지 않다**
6. `action=review&day=99` (미학습일 자칭) → skipped, reply 없음
7. 정답/오답 각각 → reply 1통, **DB 쓰기 0건**

관문 목록 갱신 4곳: `CLAUDE.md` 검증 / `STATUS.md` §4 / `README.md` /
`deploy.yml` step 추가 — 「페이지 추가 시 4곳」과 같은 종류의 함정이므로 같은 커밋에서.

### 3-8. 백필 (원고 작업, 코드와 분리)

원고는 `server/content/` (서버에만 존재). 일별 JSON 에 `quiz` 필드를 더하고
서버에서 `node db/with-env.mjs db/seed-content.mjs` 재실행 (upsert 라 몇 번이든 안전).
**퀴즈 문안 작성을 제가 초안으로 만들어 드릴 수는 있으나** (그날 문법·단어 기반),
유료물이므로 품질 기준·감수 방식은 대표님 결정입니다. 코드가 먼저 나가도 됩니다 —
quiz 가 0건인 동안은 아무에게도 안 보일 뿐입니다 (Fallback).

## 4. 순서 (구현 시)

1. `[x]` 003 + migrate.mjs + repo(learning) + content-check (+seed 연결)
2. `[x]` render + push-daily + postback
3. `[x]` verify-quiz 신설 (12항목), 기존 17종 회귀 확인 — 전부 PASS
4. `[x]` 관문 목록 4곳 갱신 — 실측 합계 18종 521항목 (README·overview 의 낡은 16종 표기도 같이 정정)
5. `[ ]` 커밋·push → cPanel 재배포 (Update from Remote → Deploy, 판정은 restart.txt)
6. `[ ]` 백필 (별건, 원고 준비되는 대로)

## 5. 트레이드오프

- **RAND() 재현성** — 같은 아침의 재시도는 조립된 메시지로 retryKey 재송이라 문제없음.
  다른 날 같은 문제가 또 나올 수는 있음(무작위의 성질). 「최근 출제 제외」는 저장이
  필요해서 **안 함** — 무상태 원칙이 우선
- **절목일 스킵** — 30일차엔 복습이 안 나감. 절목 퀴즈 발신이 구현될 때까지 30일차는
  퀴즈 없는 날이 됨. 공백 3주 정도로 예상, 허용
- **무저장** — 복습 정답률 통계는 없음. 필요해지면 그때 폴리시(제2항)와 함께 설계
- **5/5통** — §1 의 상한 도달. 다음 확장 시 재계산 필수

## 6. 제외 이유

- **절목 퀴즈 발신** — 수신·채점부는 3-2 의 `getTemplate` quiz 파싱만으로 살아나므로,
  발신은 범위를 좁혀 따로 (진도 확인 후 계획). 이번 diff 를 작게 유지
- **저녁 배신** — 복습 성격이 겹치지만, 저녁은 「같은 문법 재확인」으로 이미 역할이
  있음. 섞으면 저녁 로직도 관문도 같이 커짐
- **privacy.html** — 저장 항목 증가 없음 → 불변 (늘리는 순간 제2항 동시 수정 규칙 발동)
