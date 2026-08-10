# plan-refactor-push.md — 조·석간 배송 중복 정리 (⑤)

작성: 2026-08-10 / 대상: `Kstudy101/codespaces-blank` (`a8b669a`)
근거: [research-deadcode.md §5](research-deadcode.md)

> **이 문서는 계획이다. 승인 전에는 코드를 쓰지 않는다.**

관련: [plan-outage-billing.md](plan-outage-billing.md) · [plan-push-cost.md](plan-push-cost.md) ·
`CLAUDE.md` 「이 저장소에서 특히 조심할 것」

---

## 0. 요약

조사 단계에서 「약 70행 중복」이라고 적었지만, **실물을 열어 보니 그 70행은 한 덩어리가
아니었다.** 성격이 넷으로 갈리고, 각각 답이 다르다.

| 겹치는 것 | 실태 | 제안 |
|---|---|---|
| **A** `tooEarly()` | **7행이 글자까지 동일** | **공통부로 뺀다** ← 본체 |
| **A'** `retryKey()` | **8행이 동일**(꼬리 주석만 다름). 단 모듈 상수 `DATE` 를 잡고 있다 | **공통부로 뺀다 — 단 §1.3 의 형태로** |
| **B** CLI 골격 (`argv`/`flag`/`value`) | 4행이 동일, 그 뒤 상수는 서로 다름 | **빼지 않는다** (§4) |
| **C** `deliverOne` | **이름만 같고 몸이 다르다**(374행 vs 63행) | **합치지 않는다** (§5) |

즉 실제로 뺄 것은 **함수 2개(15행)** 다. 조사서의 「약 70행」은 `sort -u` 로 센 값이라
`}`·`return;`·`try {` 같은 줄까지 포함돼 있었다 — **과대평가였다. 정정한다.**

> **이 계획서를 쓰는 도중 세 가지를 잘못 적었다가 실물 확인으로 고쳤다.**
> ①「`retryKey` 는 석간에 정의가 없다」 → **있다. 진짜 사본이다**(A'로 승격).
> ②「석간 코드에 `advanceDay` 가 아예 없다」 → 호출은 없지만 **주석 2곳에 이름이 나온다**.
> 정확히는 「호출이 없고, 관문이 그 부재를 감시한다」다(§5.1).
> ③ 석간 `deliverOne` 은 약 90행이 아니라 **63행**이다.
> 승인 판단이 이 숫자 위에 서므로 남겨 둔다.

---

## 1. A·A' — 진짜 사본은 `tooEarly()` 와 `retryKey()` 둘이다

[push-daily.mjs:124](../server/db/push-daily.mjs#L124) 와
[push-evening.mjs:71](../server/db/push-evening.mjs#L71) 이 **완전히 같다.**

```js
export function tooEarly(jstHour, notBefore) {
  if (notBefore === null || notBefore === undefined || notBefore === "") return false;
  const want = Number(notBefore);
  if (!Number.isInteger(want) || want < 0 || want > 23) {
    throw new Error(`--not-before は 0〜23 で渡してください: ${notBefore}`);
  }
  return Number(jstHour) < want;
}
```

주석만 다르다 — 조간은 「7시 이후로 한 이유」, 석간은 「18시 이후로 한 이유」.
**주석의 차이는 사본을 정당화하지 않는다.** 인자로 받는 값이 다를 뿐 판정은 같다.

이게 위험한 이유는 `CLAUDE.md` 가 말하는 「양쪽 다 그럴듯해서 대조 전엔 모른다」에
정확히 해당하기 때문이다. 한쪽의 경계 판정을 고치고 다른 쪽을 잊으면,
**조간은 7시에 나가고 석간은 안 나가는 날**이 생기고 로그에는 아무 이상이 없다.

### 1.1 어디에 두는가

새 파일을 만들지 않는다. 이미 있는 [`server/lib/jst.mjs`](../server/lib/jst.mjs) 에 둔다 —
`jstDate`·`jstDateTime` 이 사는 곳이고, `tooEarly` 는 **일본 시각 판정**이므로 같은 성격이다.

```js
/* server/lib/jst.mjs 에 추가 */

/* cron が地方時で動く共用サーバーなので、何時に配るかはこちらで決める。
   「N 時ちょうどだけ」ではなく「N 時以降」なのは、N 時の回が落ちた日に
   N+1 時が拾えるようにするため。二度送らないのは push_logs が見ている。
   朝(7)も夕(18)も判定は同じ ── 2 か所に写しがあると、片方だけ直した日に
   一方だけ配られる。それはログに異常として出ない。 */
export function tooEarly(jstHour, notBefore) { … 위 본문 그대로 … }
```

```js
/* server/db/push-daily.mjs · push-evening.mjs */
-import { jstDate, jstDateTime } from "../lib/jst.mjs";
+import { jstDate, jstDateTime, tooEarly } from "../lib/jst.mjs";

-export function tooEarly(jstHour, notBefore) { … }   ← 삭제
```

### 1.2 `export` 를 유지해야 한다 — 관문이 가져간다

```js
tools/verify-push.mjs:19
  import { deliverOne, retryKey, tooEarly, tooLate, fortuneSection }
    from "../server/db/push-daily.mjs";
```

`verify-push` 는 `tooEarly` 를 **`push-daily.mjs` 에서** 가져와 경계값 8개를 검사한다
(`tooEarly(6,7)===true`, `tooEarly(7,7)===false`, 잘못된 인자에 throw 하는지 등).
`verify-evening` 도 마찬가지다.

→ 두 파일에서 **재수출(re-export)** 한다. 그래야 관문을 안 고치고 옮길 수 있다.

```js
/* push-daily.mjs · push-evening.mjs */
export { tooEarly } from "../lib/jst.mjs";
```

이게 [research-deadcode.md §3](research-deadcode.md) 에서 정리한 「과잉 export」와
모순되지 않는다 — 저건 **아무도 안 쓰는** export 를 지운 것이고, 이건 **관문이 실제로
가져가는** export 다. §2.0 의 `HANDLED_TYPES`·`engineDir` 과 같은 자리다.

### 1.3 A' — `retryKey()` 는 사본이지만, 그냥 옮기면 안 된다

두 정의는 꼬리 주석을 빼면 **완전히 같다**.

```js
export function retryKey(userId, day, type) {
  const h = createHash("sha256").update(`${userId}:${day}:${type}:${DATE}`).digest("hex");
  …
}
```

문제는 마지막 `${DATE}` 다. `DATE` 는 **각 파일의 모듈 상수**
(`const DATE = value("date", jstDate())`)라, 함수를 그대로 다른 파일로 옮기면
스코프를 잃는다. 인자로 받게 고치면 `retryKey(userId, day, type, date)` 가 되는데,
관문이 **3인자로 부른다**:

```js
tools/verify-push.mjs:185
  assert(sentOpts && sentOpts.retryKey === retryKey(USER.id, 3, "learning"), …);
```

→ 인자를 늘리면 관문을 고쳐야 하고, 그러면 「검사를 그대로 두고 옮기기만 한다」는
이 작업의 안전판이 사라진다. **날짜를 묶어 두는 형태로 뺀다.**

```js
/* server/lib/pushkey.mjs (신규 · 약 20행) */

/* 同じ人・同じ日・同じ種別なら毎回同じ UUID になる。こちらの記録が
   残る前に落ちても、LINE 側が二重配信を弾ける。
   朝と夕で種別だけ違い、作り方は同じ ── 写しを 2 か所に置くと、
   片方だけ直した日に一方だけ二重配信を弾けなくなる。 */
export function makeRetryKey(date) {
  return function retryKey(userId, day, type) {
    const h = createHash("sha256").update(`${userId}:${day}:${type}:${date}`).digest("hex");
    …
  };
}
```

```js
/* push-daily.mjs · push-evening.mjs — 양쪽 동일 */
-export function retryKey(userId, day, type) { … }        ← 삭제
+import { makeRetryKey } from "../lib/pushkey.mjs";
+export const retryKey = makeRetryKey(DATE);
```

호출부(`retryKey(u.id, today, "learning")`)도 관문도 **한 글자도 안 바뀐다.**

> `jst.mjs` 가 아니라 새 파일에 두는 이유: `retryKey` 는 시각이 아니라 **LINE 재시도 키**라
> 성격이 다르고, `node:crypto` 를 끌고 온다. `jst.mjs` 는 지금 의존이 없다.
> 파일 1개가 느는 것과 성격이 다른 함수를 섞는 것 중에서는 전자가 낫다고 본다.
> — **이 판단은 대표님 몫입니다.** `jst.mjs` 에 같이 두라고 하시면 그렇게 합니다.

---

## 2. `tooLate()` 는 어떻게 하는가 — 조간에만 있다

[push-daily.mjs:139](../server/db/push-daily.mjs#L139) 의 `tooLate()` 는 `tooEarly` 와
구조가 판박이지만 **석간에는 없다**. 「그 날의 배달은 몇 시까지인가」를 상품으로
명문화한 것(`plan-outage-billing` 승인 C의 B)이라, 조간에만 있는 게 맞다.

**같이 옮기지 않는다.** 사본이 아니므로 이번 작업의 대상이 아니다.
지금 같이 옮기면 「석간에도 상한을 둘까」라는 **상품 판단**이 리팩토링에 섞인다.

---

## 3. 수정될 파일

| 경로 | 변경 |
|---|---|
| [`server/lib/jst.mjs`](../server/lib/jst.mjs) | `tooEarly` 추가 (+9행) |
| `server/lib/pushkey.mjs` | **신규.** `makeRetryKey` (+20행) — §1.3 |
| [`server/db/push-daily.mjs`](../server/db/push-daily.mjs) | 두 정의 삭제, import + 재수출 (−15행) |
| [`server/db/push-evening.mjs`](../server/db/push-evening.mjs) | 〃 (−15행) |
| [`docs/research-deadcode.md`](research-deadcode.md) | §5 「70행」을 §0 대로 정정, §7 7단계 `[x]` |

**관문 수정 없음**(§1.2 재수출이 그것을 위한 것). 관문을 안 고치고 끝나는 게
이 작업이 안전한 이유다 — 검사가 그대로면, 옮기기가 값을 바꿨는지 검사가 답한다.

---

## 4. B — CLI 골격은 빼지 않는다

두 파일 모두 이 4행이 같다.

```js
const argv  = process.argv.slice(2);
const flag  = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => { … };
```

그런데 **그 아래가 갈린다** — 조간은 `LOG_AT = "${DATE} 07:00:00"`, 석간은 `18:00:00`.
`DRY`·`LIMIT`·`DISABLED` 는 같지만 `NOT_BEFORE` 의 기본 의미가 다르다.

공통 모듈로 빼면 「인자 4개는 공통, 상수 5개는 각자」라는 반쯤 갈린 구조가 되고,
**CLI 진입점을 위에서 아래로 읽을 수 없게 된다**. 4행을 아끼려고 읽는 순서를 잃는
거래는 남는 게 없다. `server/db/accel-day.mjs`·`migrate.mjs` 도 같은 4행을 갖고 있어,
빼기 시작하면 4개 파일이 새 모듈에 묶인다.

**제안: 그대로 둔다.** 이견 있으시면 말씀해 주십시오.

---

## 5. C — `deliverOne` 두 벌은 합치지 않는다

조사 도구가 「같은 이름의 함수가 두 파일에 있다」로 잡았지만, **몸이 다르다.**

| | `push-daily.mjs` | `push-evening.mjs` |
|---|---:|---|
| `deliverOne` | **374행** | **63행** |
| 내용 | 운세+문법+회화+단어, 일수 소비, 업셀, 완주, 장애 재조준 | 복습·복습퀴즈, 체험 종료 권유 |
| `advanceDay` | 부른다 | **부르지 않는다** |

### 5.1 「부르지 않는다」가 관문으로 고정돼 있다

석간이 일수를 소비하지 않는 것은 **상품 규칙**이다 — 「진행하는 것은 조간뿐.
석간 복습과 절목 퀴즈는 덤이라 보유 일수가 줄지 않는다」(온보딩 안내문에도 그렇게 적혀 있다).

그리고 그 규칙은 주석이 아니라 **관문이 소스를 읽어 강제**하고 있다.

```js
tools/verify-evening.mjs:103
  assert(!/advanceDay|resetProgress/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    …);
```

`push-evening.mjs` 의 소스에서 주석을 걷어낸 뒤 **`advanceDay` 라는 글자가 있으면 실패**한다.
즉 지금은 「석간이 일수를 줄이는 사고」가 **구조적으로 불가능**하다.

두 `deliverOne` 을 하나로 합치면, 합쳐진 함수는 반드시 `advanceDay` 를 갖게 되고
이 검사는 **성립할 수 없게 된다**. 검사를 지우고 합치는 것은
「지키던 것을 지키지 않기로 하고, 그 대신 아무것도 두지 않는」 거래다.

`CLAUDE.md` 의 「`advanceDay` 는 일자 확보와 일수 소비를 한 문장에서」도 같은 자리다.

**제안: 합치지 않는다.** 이름이 같은 것이 헷갈린다면 개명이 답이지만,
그건 관문 import 를 건드리므로 이번 범위 밖으로 둔다.

---

## 6. 트레이드오프

**얻는 것**

- 배달 시각 판정과 재시도 키가 저장소에 **1벌씩**이 된다.
  한쪽만 고치는 사고가 구조적으로 불가능해진다
- `verify-push`·`verify-evening` 이 같은 실물을 검사하게 된다(지금은 각자의 사본)
- 순변화 −1행(파일 1개 증가). diff 가 작아 리뷰가 쉽다

**잃는 것 / 위험**

- 재수출이 한 겹 늘어 「`push-daily` 의 `tooEarly` 는 실은 `jst.mjs` 것」이라는
  간접이 생긴다 → 완화: `jst.mjs` 쪽 주석에 조·석간 양쪽이 쓴다고 명시
- 얻는 게 작다. **15행짜리 작업**이라 "리팩토링"이라 부르기도 민망하다
  → 다만 이 15행이 `CLAUDE.md` 가 경고한 「조용히 갈라지는 사본」의 교과서적 형태다
- `makeRetryKey` 는 함수를 돌려주는 함수라 한 겹 간접이 는다. 대신 호출부와 관문이
  한 글자도 안 바뀐다 ── 그 거래로 본다(§1.3)
- `jst.mjs` 가 시각 포맷 유틸에서 「배달 정책 판정」까지 갖게 된다.
  성격이 살짝 넓어진다 → 대안은 새 파일이지만, 함수 1개로 파일을 만들 값어치는 없다

---

## 7. 검증

- [ ] 착수 전 관문 19종 초록 확인
- [ ] 옮긴 뒤 관문 19종 — **특히 `verify-push`·`verify-evening`**
- [ ] `tooEarly`·`retryKey` 본체가 저장소에 **1개씩**인지 확인
  ```bash
  git grep -c "function tooEarly" -- '*.mjs'      # 1 이어야 한다
  git grep -c "createHash(\"sha256\")" -- 'server/db/*.mjs'   # 0 이어야 한다
  ```
- [ ] **재시도 키의 값이 안 바뀌었는지** — 옮기기 전후로 같은 인자에 같은 UUID 가 나오는지
  대조한다. 값이 바뀌면 그날 하루 이중 배송을 못 막는다
- [ ] 두 진입점에서 여전히 import 가능한지 확인(재수출)
  ```bash
  node -e "import('./server/db/push-daily.mjs').then(m=>console.log(typeof m.tooEarly))"
  ```
- [ ] `research-deadcode.md` §5 의 「약 70행」을 §0 대로 정정

---

## 8. 제외 (scope 밖)

- **`deliverOne` 통합** — §5. 석간에 `advanceDay` 가 없다는 보증을 잃는다
- **석간 `deliverOne` 의 분할** — 63행이라 나눌 값어치가 없다
- **CLI 인자 골격** — §4
- **`tooLate`** — §2. 조간 전용이고 상품 판단이 섞인다
- **`isUnreachable`·`markUnfollowed` 처리 흐름** — 두 파일에서 모양이 비슷하나
  실패 시 무엇을 기록하는지가 달라, 합치면 로그가 뭉개진다
- **`push-daily.mjs` 814행의 분할** — [plan-refactor-handlers.md §5](plan-refactor-handlers.md)
  에서 제외로 제안한 것과 같은 이유
