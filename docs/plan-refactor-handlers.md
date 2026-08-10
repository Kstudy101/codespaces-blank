# plan-refactor-handlers.md — 거대 함수 정리 (④)

작성: 2026-08-10 / 대상: `Kstudy101/codespaces-blank` (`a8b669a`)
근거: [research-deadcode.md §4](research-deadcode.md)

> **승인됨 (2026-08-10, 대표).** §5 의 제안대로 `deliverOne()` 은 **영구 제외**로 결정.
> 이 결정은 이번 작업 한정이 아니다 — 앞으로도 「읽기 좋게 나눈다」를 이유로는 손대지 않는다.
> 손댈 이유가 생긴다면 그것은 기능 변경이고, 그때 별도 계획서를 쓴다.

관련: [research-deadcode.md](research-deadcode.md) · `CLAUDE.md` 「이 저장소에서 특히 조심할 것」

---

## 0. 요약

| | |
|---|---|
| 대상 | `handlePostback()` 514행 — **이번 계획의 유일한 대상** |
| **제외** | `deliverOne()` 374행 — §5에서 **하지 말자고 제안**한다 |
| 방식 | 동작 0 변화. 분기 본문을 **파일 안에서** 이름 붙인 함수로 옮기고, 본체는 표로 고른다 |
| 검증 | 관문 19종 + `verify-webhook`·`verify-onboarding`·`verify-billing`의 정적 검사 |
| 되돌리기 | 커밋 1개. 어긋나면 `git revert` |

---

## 1. 왜 이 함수만 대상인가

[research-deadcode.md §4](research-deadcode.md) 가 80행 초과 10개를 뽑았지만,
그중 손댈 값어치가 있으면서 **위험이 낮은 것은 `handlePostback` 하나**다.

| 함수 | 행수 | 판단 |
|---|---:|---|
| `handlePostback` | 514 | **대상.** 분기 나열이라 상태를 건드리지 않고 나눌 수 있다 |
| `deliverOne`(조간) | 374 | **제외.** §5 |
| `consume`·`completeLink`(관문 안) | 234·195 | 제외. 관문 코드이고, 길이가 곧 검사 항목 수다 |
| `handleMessage` | 195 | 제외. 200행 아래이고 분기가 6개뿐 |
| `run`(`js/name-learn-data.js`) | 155 | 제외. 배포되지 않는 관문 정본(§7 범위 밖) |
| `completeLink`(본번) | 121 | 제외. 트랜잭션 1개가 통째로 들어 있어 나누면 경계가 흐려진다 |
| `main`(CLI 2개) | 114·109 | 제외. CLI 진입점은 길어도 위에서 아래로 읽힌다 |
| `pillars` | 86 | 제외. 역법 계산. 관문 `verify-saju`가 값으로 고정 |

---

## 2. `handlePostback` 은 지금 어떻게 생겼나

[server/lib/handlers/postback.mjs:144](../server/lib/handlers/postback.mjs#L144).
앞부분 30행이 **공통 준비**이고, 나머지 480행이 **`action` 별 분기 16개의 평평한 나열**이다.

```
144  export async function handlePostback(conn, event, { send, deliver, push, transact }) {
       ── 공통 준비 ──────────────────────────────────
150      userId 없으면 { skipped }
152      parsePostbackData(event.postback.data) → { action, params }
154      users 에 없으면 recoverUser + welcome 으로 조기 반환
169      learning.healProgress (실패해도 계속)
172      const token = event.replyToken
       ── 분기 16개 ──────────────────────────────────
174      if (action === "name")        …  77행
257      if ([bdate,btime,bplace,bcity,bgender,birth].includes(action))  … 3행
263      if (action === "fix")         …  11행
277      if (action === "about")       …   4행
284      if (action === "status")      …   3행
296      if (action === "plans")       …  21행
320      if (action === "plan")        …  53행
384      if (action === "buy")         …  31행
422      if (action === "trackpick")   …  41행
470      if (action === "trial")       …  38行
511      if (action === "resume")      …   6행
526      if (action === "switch")      …   6행
551      if (action === "answer")      …  15행
573      if (action === "review")      …  33행
609      if (action !== "quiz") …  이후 끝까지가 quiz 처리  …  47행
```

읽기 어려운 이유는 분기가 복잡해서가 아니라 **16개가 한 화면 밖으로 흘러서**다.
각 분기는 이미 `{ userId, action, … }` 꼴의 같은 모양을 반환한다.

---

## 3. 접근 방식 — 「표로 고르고, 분기는 이름을 갖는다」

분기 본문을 **같은 파일 안의 이름 붙인 함수**로 옮기고, 본체는 표에서 골라 부른다.
**새 파일을 만들지 않는다** — 파일이 갈리면 `verify-*`가 소스를 정규식으로 읽는 검사
(§4.2)의 대상 경로가 흩어지고, 지금 얻는 이득보다 관문 수정 비용이 커진다.

### 3.1 바뀌는 모양

```js
/* 지금 */
export async function handlePostback(conn, event, opts = {}) {
  … 공통 준비 …
  if (action === "about") {
    const replied = await reply(token,
      [serviceGuide({ nameJa: user.name_reading || user.name_kanji })], send);
    return { userId: user.id, action, replied };
  }
  if (action === "status") { … }
  … 14개 더 …
}
```

```js
/* 계획 */
/* action → 처리. 표에 없는 action 은 지금과 같이 끝까지 흘러
   마지막 기본 처리로 간다. 표에 넣는 것과 분기를 지우는 것을
   같은 커밋에서 하므로, 옮기다 빠뜨리면 관문이 잡는다. */
const ACTIONS = {
  name:      onName,
  fix:       onFix,
  about:     onAbout,
  status:    onStatus,
  plans:     onPlans,
  plan:      onPlan,
  buy:       onBuy,
  trackpick: onTrackpick,
  trial:     onTrial,
  resume:    onResume,
  switch:    onSwitch,
  answer:    onAnswer,
  review:    onReview,
  quiz:      onQuiz,
};

/* 생년월일 계열은 받되 저장하지 않는다(지금과 동일). 표에 6개를
   같은 함수로 넣는 대신 한 곳에 모아 둔다 ── 「쓰지 않는다」가
   목록으로 보이는 편이 낫다. */
const DROPPED = ["bdate", "btime", "bplace", "bcity", "bgender", "birth"];

async function onAbout(ctx) {
  const { conn, user, token, action, send } = ctx;
  const replied = await reply(token,
    [serviceGuide({ nameJa: user.name_reading || user.name_kanji })], send);
  return { userId: user.id, action, replied };
}

export async function handlePostback(conn, event, opts = {}) {
  … 공통 준비 (그대로) …
  const ctx = { conn, event, user, action, params, token, ...opts };
  if (DROPPED.includes(action)) return onDropped(ctx);
  const handler = ACTIONS[action];
  return handler ? handler(ctx) : onUnknown(ctx);
}
```

본체는 **30행 남짓**이 되고, 각 처리는 자기 이름과 3~77행의 몸을 갖는다.
`ctx` 를 만드는 것은 인자 8개를 16번 다시 쓰지 않기 위한 것이고,
**분기 안의 코드는 한 줄도 고치지 않는다** — 통째로 옮기기만 한다.

### 3.2 `quiz` 분기만 모양이 다르다

609행은 `if (action !== "quiz") { … }` 로 **부정형**이라, 실제로는
「여기까지 왔으면 quiz 이거나 미지의 action」이라는 뜻이다. 즉 지금의
`onUnknown` 이 그 안에 섞여 있다. 옮길 때 **둘로 가른다**:

- `action === "quiz"` → `onQuiz`
- 그 외 → `onUnknown` (지금 617~625행이 반환하던 것과 같은 값)

여기가 이번 작업에서 **유일하게 판단이 들어가는 곳**이다. 나머지 15개는 잘라 붙이기다.

---

## 4. 수정될 파일

| 경로 | 변경 |
|---|---|
| [`server/lib/handlers/postback.mjs`](../server/lib/handlers/postback.mjs) | `handlePostback` 514 → 약 30행. `ACTIONS` 표 + `on*` 함수 16개 추가(내용은 이동) |
| [`tools/verify-webhook.mjs`](../tools/verify-webhook.mjs) | §4.2에서 확인한 정적 검사가 걸리면 **정규식만** 조정 |
| [`tools/verify-onboarding.mjs`](../tools/verify-onboarding.mjs) | 〃 |
| [`docs/research-deadcode.md`](research-deadcode.md) | §7 6단계 `[x]` |

**새 파일 없음. `server/lib/handlers/` 아래 파일 수 변화 없음.**

### 4.1 `export` 하지 않는다

`on*` 16개는 전부 **모듈 내부 함수**다. `export` 하면
[research-deadcode.md §3](research-deadcode.md) 에서 방금 정리한 「과잉 export」를
16개 새로 만드는 셈이 된다.

### 4.2 착수 전에 반드시 먼저 할 것 — 관문의 정적 검사 조사

`verify-*` 는 소스를 **정규식으로** 읽는 검사를 여럿 갖고 있다. 확인된 것만:

```js
tools/verify-onboarding.mjs:1057
  const pb2 = stripComments(read("server/lib/handlers/postback.mjs"));
  assert(!/saveSaju/.test(pb2), …);
  assert(!/upsertSajuProfile/.test(pb2.match(/if \(\["bdate"[\s\S]*?\n  }/)[0]), …);
  const drop = pb2.match(/if \(\["bdate"[\s\S]*?\n  }/)[0];
  for (const a of ["bdate","btime","bplace","bcity","bgender","birth"])
    assert(drop.includes(`"${a}"`), …);
```

이 검사는 **`if (["bdate", … ].includes(action)) { … }` 라는 글자 모양 자체**에 걸려 있다.
§3.1처럼 `DROPPED` 배열로 바꾸면 `pb2.match(...)` 가 `null` 이 되어
`[0]` 에서 **TypeError 로 터진다**(빨개지긴 하나 이유가 안 보인다).

→ **작업 순서를 이렇게 못박는다.**

1. `postback.mjs` 를 읽는 모든 관문 검사를 grep 해 목록을 만든다
   (`read("server/lib/handlers/postback.mjs")` · `PB_SRC` 등)
2. 각 검사가 **무엇을 지키려는 것인지**를 한 줄로 적는다
3. 코드를 옮긴 뒤, 그 의도를 **새 모양에 맞춰** 다시 쓴다
4. 옮기기 전 `git stash` 상태에서 관문이 초록임을 확인 → 옮긴 뒤 다시 초록

「검사가 통과하도록 정규식을 느슨하게 한다」는 **금지**다. 그건 관문을 끄는 것이다.

---

## 5. `deliverOne()` 374행은 제외를 제안한다

[research-deadcode.md §4.1](research-deadcode.md) 대로, `CLAUDE.md` 가 이 저장소에서
특히 조심하라고 못박은 두 가지가 **이 함수 안에** 있다.

> - 잔여 일수는 `days_entitled - days_used`. `current_day` 로 세면 안 된다
> - `advanceDay` 는 일자 확보와 일수 소비를 **한 문장에서** 한다.
>   나누면 그 사이에 죽었을 때 하루가 공짜

실제 코드도 그렇게 적혀 있다 — [push-daily.mjs](../server/db/push-daily.mjs) 안에
`days_used もこの 1 文で増える ── 別の文にすると、確保したのに…` 라는 주석이 붙어 있고,
`const remaining = Number(u.days_entitled ?? 0) - Number(u.days_used ?? 0)` 이 그 규칙의 실물이다.

**「읽기 좋게 함수를 나눈다」가 정확히 이 규칙을 깨는 형태다.** 게다가 이 함수는
장애 대응 이력(`plan-outage-billing`)이 층층이 쌓인 곳이라, 374행 중 상당수가
「이렇게 하지 않으면 이런 사고가 난다」는 주석이다. 길이가 곧 사고 이력이다.

제안: **`deliverOne` 은 이번에도, 다음에도 건드리지 않는다.** 손대야 할 이유가
생긴다면 그건 리팩토링이 아니라 기능 변경일 때이고, 그때 별도 계획서를 쓴다.

이 제안에 반대하시면 말씀해 주십시오 — 그 경우 계획서를 다시 씁니다.

---

## 6. 트레이드오프

**얻는 것**

- 본체 514 → 약 30행. 「어떤 action 을 받는가」가 표 하나로 보인다
- 새 action 을 붙일 때 고칠 곳이 표 1줄 + 함수 1개로 명확해진다
- 각 분기가 이름을 가지므로 스택 트레이스에 `onTrial` 처럼 찍힌다(지금은 전부 `handlePostback`)

**잃는 것 / 위험**

- **관문의 정적 검사가 깨진다**(§4.2). 이번 작업 비용의 대부분이 여기다
- `ctx` 객체가 한 겹 늘어난다. 지금은 지역 변수를 그대로 쓰고 있어 더 직접적이다
- diff 가 크다(약 480행 이동). `git diff` 로는 「옮겼을 뿐」임이 보이지 않는다
  → 완화: **이동만 하는 커밋 1개**로 끝내고, 그 커밋에서 다른 것을 같이 고치지 않는다
- 분기 안을 한 줄도 안 고친다고 해도, **잘라 붙이다 1개를 빠뜨리면**
  그 action 이 조용히 `onUnknown` 으로 간다 → 완화: §7의 대조 절차

---

## 7. 검증

- [ ] 착수 전 `git stash` 상태에서 관문 19종 초록 확인
- [ ] `postback.mjs` 를 읽는 관문 검사 전수 목록화(§4.2 1~2)
- [ ] 옮긴 뒤 관문 19종
- [ ] **action 대조** — 옮기기 전후로 아래를 돌려 목록이 같은지 본다
  ```bash
  git show HEAD:server/lib/handlers/postback.mjs \
    | grep -oE 'action === "[a-z]+"' | sort -u > /tmp/before.txt
  grep -oE '^  [a-z]+:' server/lib/handlers/postback.mjs | sort -u > /tmp/after.txt
  ```
- [ ] `handlePostback` 이 30행 이하인지 확인
- [ ] 새로 `export` 된 심볼이 0인지 확인(§4.1) — `research-deadcode.md` 의 검출기 재실행

---

## 8. 제외 (scope 밖)

- **`deliverOne()`** — §5
- **`handleMessage()` 195행** — 분기 6개. 지금 나누면 얻는 것보다 diff 가 크다
- **`server/lib/handlers/` 의 파일 분할** — §3 대로 하지 않는다
- **분기 안의 로직·문면·에러 처리** — 한 줄도 고치지 않는다. 옮기기만 한다
- **`parsePostbackData`·`reply`·`stateOf` 등 헬퍼** — 그대로 둔다
- **주석** — 분기와 함께 통째로 옮기고, 내용은 손대지 않는다
