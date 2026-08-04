# 과금 계획서 — 선불 횟수권 (2026-08-04 전면 개정)

작성: 2026-08-03 / **개정: 2026-08-04 — 모델이 바뀌었습니다**
선행: [research-line-flow.md](research-line-flow.md) (연동 실기 검증), [research-audit.md](research-audit.md)

> **상태: 구현 완료 (2026-08-04). 단, 아직 팔 수는 없습니다.**
> 코드는 전부 들어갔고 관문 17종이 통과합니다. 그러나 **⑤⑥⑦이 정해지지
> 않으면 결제 동선이 열리지 않게 막아두었습니다**. 이건 미완성이 아니라
> 의도한 잠금입니다 — 표시 의무를 채우기 전에 팔리는 쪽이 훨씬 무겁습니다.

| 결정 | 결과 |
|---|---|
| ① 무료 체험 | **유지.** 단 「코스를 고른 뒤」로 옮김 (§2) |
| ② 가격 | 현행 `PACKAGES` 그대로 |
| ③ 「만료 2일 전」 | **잔여 2회**로 구현 |
| ④ 동시 진행 코스 | **1개** (`users.active_track`) |
| ⑤ **특정상거래법 본명·주소** | **미정 → `TOKUSHOHO_URL` 이 비어 결제 잠김** |
| ⑥ **환불 규정** | **미정 → `REFUND_POLICY` 가 비어 결제 잠김** |
| ⑦ **리치메뉴 이미지** | **미정 → 설치 도구가 멈춤** |
| ⑧ 이탈 장부 | 「사건만」 담는 표로 구현 |

> 과금은 되돌리기가 특히 어렵습니다 — 잘못 청구한 돈은 사과로 끝나지 않습니다.

---

## 0. 무엇이 바뀌었는가

초판(2026-08-03)은 **정기구독(월 자동갱신)** 을 전제했습니다.
지시하신 것은 **선불 횟수권** 입니다. 다른 물건입니다.

| | 초판 (폐기) | 이번 (지시) |
|---|---|---|
| 과금 | 월 자동갱신 | **코스별 선불. 산 일수만큼만** |
| 해지 | 해지 처리 필요 | **해지라는 개념이 없음** — 안 사면 끝 |
| 만료 | `current_period_end` (날짜) | **잔여 일수 0** |
| 코스 | 1개 고정 | **완주 후 다른 코스·재수강** |
| 결제 진입 | LINE 메시지 | **리치메뉴 → 코스 선택 → 가격표** |
| 결제 직후 | 다음 아침부터 | **시각 무관, 즉시 1일차** |

### 0.1 이 변경으로 가벼워지는 것

**자동갱신이 아니므로, 특정상거래법의 「정기구매」 특유의 요건이 빠집니다.**
초판 §3.2가 무겁게 다룬 최종확인화면의 「갱신 주기」·「해지 방법」 표시는
갱신도 해지도 없으므로 해당하지 않습니다.

**다만 통신판매로서의 특정상거래법 표기 페이지는 그대로 필요합니다.**
본명·주소·전화번호 문제는 **줄지 않습니다**(§7, 결정 ⑤).
그리고 이건 제 판단이므로 **실제 운용 전에 확인이 필요합니다.**

### 0.2 이 변경으로 무거워지는 것

**한 사람이 여러 코스를 순차로 듣게 됩니다.** 지금 스키마는 그걸 막고 있습니다.

```sql
-- server/db/schema.sql:161
UNIQUE KEY uq_progress_user (user_id),        -- 1인 1행. 코스가 바뀔 수 없다
```
```js
// server/lib/repo/learning.mjs:97
`UPDATE learning_progress SET track = ? WHERE user_id = ? AND track IS NULL`
//                                                          ↑ 한 번 정하면 못 바꿈
```

여기가 이번 작업에서 제일 큰 덩어리입니다(§3).

---

## 1. 이용자에게 보이는 흐름

```
친구추가
  └─ 인사말 1통  (Kstudy101 이란 무엇인가 / 이름으로 배운다 / 하루 2회)
  └─ 리치메뉴가 화면 아래에 상시 표시

리치메뉴
  ├─ [강좌 안내]   커리큘럼·서비스 제공 내역
  ├─ [수강료]      ← 여기서 결제가 시작된다
  ├─ [내 진도]     지금 몇 일차 / 잔여 몇 일
  └─ [문의]

[수강료] 누름
  └─ ① 코스 선택        초급 / 중급 / 고급
        └─ ② 가격표 표시  (＝최종확인화면. 분량·총액·제공시기·환불)
              └─ ③ [결제하기] → Stripe Checkout (카드번호는 우리를 지나지 않음)

결제 완료 (Stripe webhook)
  ├─ 일수 적립
  ├─ ★ 시각과 무관하게 즉시 1일차 발송
  └─ 다음날부터 아침 7시 / 저녁 6시

잔여 2일  → 만료 예고 Push + [추가 구매]
잔여 0일  → 배신 정지. 이탈 장부에 기록

재결제
  └─ "이어서 하시겠습니까? / 1일차부터 다시 하시겠습니까?"
        ├─ 이어서   → 멈춘 다음 일차부터
        └─ 처음부터 → 1일차부터 (일수는 새로 산 만큼)

101일 완주
  └─ 수료 안내 + 다음 코스 권유 (중급 1일차부터 / 초급 재수강)
```

---

## 2. 먼저 정할 것 — 무료 체험을 남길 것인가  ⟵ **결정 ①**

지시하신 흐름에 **무료 체험이 없습니다.** 지금 코드는 친구추가만 하면
자동으로 3일치를 줍니다.

```js
// server/lib/handlers/follow.mjs:94
const trial = await billing.startTrial(conn, user.id);   // 무조건 3일
```

| | (가) 체험 폐지 — 순수 선불 | (나) 체험 3일 유지 |
|---|---|---|
| 흐름 | 지시하신 그대로 | 결제 전에 3회를 먼저 보냄 |
| 코드 | `startTrial` 제거, 기본 일수 0 | 지금 그대로 |
| 이탈 | 개인화 결과물을 못 보고 판단 | 3회 받아보고 판단 |
| 원고 | — | 초급 1〜3일차가 사실상 무료 샘플이 됨 |

**제 의견** — 이 상품은 「내 이름이 예문에 나온다」가 팔 거리인데, 그건
설명보다 **한 번 받아보는 편이 훨씬 강합니다.** 그래서 (나)를 조금
더 권합니다. 다만 이건 가격 정책이므로 대표님 판단입니다.

지시하신 흐름을 글자 그대로 따르면 **(가)** 입니다. **답을 주시면 그대로 갑니다.**

---

## 3. 데이터 모델 — 여기가 이번 작업의 핵심

### 3.1 코스별로 쪼갠다

지금은 「사람 1명 = 진도 1개 = 일수 1개」입니다.
앞으로는 **「사람 1명 × 코스 3개」** 가 됩니다.

```
지금                              앞으로
users 1 ── 1 learning_progress    users 1 ── N learning_progress  (코스별)
      1 ── 1 subscriptions              1 ── N course_entitlements(코스별)
              total_days_entitled
```

### 3.2 ★ 가장 중요한 한 가지 — `days_used` 를 따로 둔다

「1일차부터 다시」를 넣는 순간, **진도와 소비 일수를 분리하지 않으면
무료로 계속 받을 수 있게 됩니다.**

```
잔여 = days_entitled - current_day     ← 이렇게 두면
30일 구매 → 10일차까지 수강 → "처음부터" → current_day = 0
                                         → 잔여가 30일로 되살아남
                                         → 10일치를 공짜로 받은 셈
```

그래서:

```
days_entitled  산 일수의 누계.        구매로만 늘어난다
days_used      실제로 보낸 일수의 누계. 절대 줄지 않는다   ← 잔여는 이걸로 센다
current_day    콘텐츠 몇 일차인가.     "처음부터"면 0으로 되돌린다

잔여 = days_entitled - days_used
```

「처음부터」를 골라도 **잔여는 줄어든 채로 유지**됩니다. 다시 듣는 것도
일수를 씁니다 — 그게 정직하고, 설명도 됩니다.

### 3.3 마이그레이션 `002-per-course-billing.sql`

`schema.sql` 은 고치지 않습니다(`CREATE TABLE IF NOT EXISTS` 라 기존 표에 안 먹힘).
`migrations/` 에 더합니다 — `migrate.mjs` 가 `EXPECTED_COLUMNS` 로 적용 여부를
이름으로 확인하므로, 흘리지 않고 넘어가는 일이 없습니다.

```sql
-- ---- 1. 진도를 코스별로 -------------------------------------------
-- 지금은 UNIQUE(user_id) 라 1인 1코스. 완주 후 다음 코스로 갈 수 없다.
ALTER TABLE learning_progress DROP INDEX uq_progress_user;

-- 기존 행의 track 은 NULL 일 수 있다(아직 안 고른 사람). 코스별 키로
-- 만들려면 NULL 이면 안 되므로, 먼저 메운다.
--   · 이미 고른 사람  → 그대로
--   · 아직 안 고른 사람 → 결제 전이므로 행 자체를 지운다(§3.5)
DELETE FROM learning_progress WHERE track IS NULL;
ALTER TABLE learning_progress MODIFY COLUMN track
  ENUM('beginner','intermediate','advanced') NOT NULL;
ALTER TABLE learning_progress ADD UNIQUE KEY uq_progress_user_track (user_id, track);

-- 이 코스에서 실제로 보낸 일수. current_day 와 다르다(§3.2).
-- 기존 행은 지금까지 보낸 만큼이 곧 진도이므로 current_day 를 그대로 옮긴다.
ALTER TABLE learning_progress
  ADD COLUMN days_used INT NOT NULL DEFAULT 0 AFTER current_day;
UPDATE learning_progress SET days_used = current_day;

-- ---- 2. 코스별 보유 일수 -------------------------------------------
CREATE TABLE IF NOT EXISTS course_entitlements (
  user_id       BIGINT NOT NULL,
  track         ENUM('beginner','intermediate','advanced') NOT NULL,
  days_entitled INT NOT NULL DEFAULT 0,          -- 구매로만 늘어난다
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, track),
  CONSTRAINT fk_ent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 3. 지금 어느 코스를 듣고 있는가 --------------------------------
-- 동시에 진행하는 코스는 하나(결정 ④). 배치는 이 열만 본다.
-- 다른 코스의 잔여 일수는 course_entitlements 에 남아 있으므로, 돌아올 수 있다.
ALTER TABLE users
  ADD COLUMN active_track ENUM('beginner','intermediate','advanced') NULL AFTER status;

-- ---- 4. 구매를 코스에 묶는다 ----------------------------------------
-- 어느 코스로 산 일수인지가 없으면, 코스별 잔여를 세울 수 없다.
ALTER TABLE purchases
  ADD COLUMN track ENUM('beginner','intermediate','advanced') NULL AFTER user_id;
UPDATE purchases SET track = 'beginner' WHERE track IS NULL;   -- 기존 이력은 초급

-- ---- 5. 배신 종별을 늘린다 ------------------------------------------
-- expiring : 잔여 2일 예고        resume : 재개 여부 확인
ALTER TABLE push_logs
  MODIFY COLUMN push_type
    ENUM('learning','review','quiz','upsell','completion','onboarding',
         'expiring','resume')
    NOT NULL DEFAULT 'learning';

-- ---- 6. 이탈 장부 ---------------------------------------------------
-- 「중간에 만료되고 이력이 없는 이용자」를 보기 위한 표(§6).
CREATE TABLE IF NOT EXISTS lapse_log (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id      BIGINT NOT NULL,
  track        ENUM('beginner','intermediate','advanced') NOT NULL,
  lapsed_at    DATETIME NOT NULL,
  last_day     INT NOT NULL,                     -- 어디까지 받고 멈췄나
  days_bought  INT NOT NULL,                     -- 그때까지 산 일수
  resumed_at   DATETIME NULL,                    -- 다시 샀으면 그때
  KEY ix_lapse_open (resumed_at, lapsed_at),     -- 아직 안 돌아온 사람
  CONSTRAINT fk_lapse_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`migrate.mjs` 의 `EXPECTED_COLUMNS` 에 다음을 더합니다.

```js
["learning_progress", "days_used"],
["users",             "active_track"],
["purchases",         "track"],
["course_entitlements", "days_entitled"],
["lapse_log",         "lapsed_at"]
```

### 3.4 `subscriptions.total_days_entitled` 는 어떻게 되는가

**지웁니다.** 코스별 잔여로 대체되므로 두면 진실이 둘이 됩니다.
다만 지금 **9곳이 읽고 있습니다**(`push-daily` / `message.mjs` / `who.mjs` /
`billing.recountEntitledDays` / `findEntitlementDrift` / `listDeliverable` / `smoke`).
한 번에 바꿔야 합니다 — 남겨두면 어느 쪽이 맞는지 코드가 말해주지 않게 됩니다.

`subscriptions` 표 자체는 **남깁니다.** `trial_start`/`trial_end` 는
결정 ①이 (나)면 계속 쓰고, (가)면 그때 빼는 편이 diff가 작습니다.

> ⚠️ `trial_end` 는 **지금 아무 판정에도 안 쓰이는 죽은 열입니다.**
> 기록도 하고 `listDeliverable` 이 SELECT까지 하는데, 체험을 실제로
> 제한하는 건 `total_days_entitled = 3` 뿐입니다. 즉 지금 체험은
> 「3일」이 아니라 **「레슨 3회」** 입니다.

### 3.5 아직 안 산 사람에게는 진도 행을 만들지 않는다

지금은 친구추가 시점에 `ensureProgress` 로 `track = NULL` 행을 만듭니다.
코스별로 쪼개면 **track이 키의 일부**라 NULL 행이 있을 수 없습니다.

바꿉니다 — **진도 행은 결제 시점에 만듭니다.** 친구추가만 한 사람은
`users` 행만 있고, 배신 대상에서 자연히 빠집니다.

---

## 4. 리치메뉴 → 결제

### 4.1 리치메뉴 (신규. 지금 코드 0줄)

```
┌─────────────┬─────────────┬─────────────┐
│  강좌 안내   │   수강료     │   내 진도    │
├─────────────┴─────────────┴─────────────┤
│              문의하기                     │
└──────────────────────────────────────────┘
```

| 칸 | 동작 |
|---|---|
| 강좌 안내 | postback `action=about` → 커리큘럼·제공 내역 |
| **수강료** | postback `action=plans` → **§4.2** |
| 내 진도 | postback `action=status` → 코스·일차·잔여 |
| 문의하기 | URI → `https://www.kstudy101.jp/contact` |

**필요한 것** — 2500×1686 이미지 1장. **대표님이 준비해야 합니다**(결정 ⑦).

```
신규  server/lib/richmenu.mjs      만들기·이미지 업로드·기본 지정
신규  tools/setup-richmenu.mjs     한 번 실행하는 도구
```

리치메뉴는 **한 번 올리면 끝**이라 배치나 배포에 넣지 않습니다.
바꿀 때만 손으로 돌립니다.

### 4.2 「수강료」를 누르면

**한 화면 안에서 두 단계**입니다. 코스를 고르기 전에 가격을 보여주면
어느 가격인지 모르고, 코스만 고르고 끝내면 결제로 못 갑니다.

```
[수강료]
  ↓ postback action=plans
┌────────────────────────────────┐
│ 어느 코스를 들으시겠습니까?      │
│ 初級 초급 / 中級 중급 / 高級 고급 │   ← quickReply 3개
└────────────────────────────────┘
  ↓ postback action=plan&track=beginner
┌────────────────────────────────┐
│ 初級（초급） 수강료               │  ← 이것이 최종확인화면(§7.2)
│ ・7일   980엔                    │
│ ・14일  1,680엔                  │
│ ・30일  2,980엔                  │
│ ・60일  4,980엔                  │
│ ・101일 7,480엔  (전 과정)        │
│                                  │
│ 제공: 결제 직후 1일차, 이후 매일   │
│       아침 7시 / 저녁 6시         │
│ 환불: (결정 ⑥)                   │
│ 판매자 표기: (링크)               │
└────────────────────────────────┘
  ↓ postback action=buy&track=beginner&pkg=30days
  서버가 Stripe Checkout 세션을 만들고 URL 을 1통으로 보냄
```

`PACKAGES` 는 지금 것을 그대로 씁니다(결정 ②에서 바꾸실 수 있습니다).
**코스별로 값이 다르면** `PACKAGES` 를 `{track: {pkg: {...}}}` 로 한 단 늘립니다.

### 4.3 Stripe — SDK 없이

이 저장소의 의존은 `mysql2` 하나뿐이고, 그 덕에 관문 16종이
`npm install` 없이 돕니다. Stripe SDK 를 넣으면 그 성질이 깨집니다.
**필요한 건 2가지뿐이라 `fetch` 로 충분합니다.**

```
신규  server/lib/stripe.mjs           세션 생성 + 서명 검증
신규  server/lib/handlers/checkout.mjs 플랜 표시 · 구매 · webhook 처리
수정  server/app.mjs                   POST /stripe/webhook 경로 추가
```

**① 결제 세션 만들기**

```js
/* Checkout(호스팅 결제 페이지)을 쓰면 카드번호가 우리 쪽을 지나지 않는다.
   privacy.html 이 이미 「クレジットカードの番号を当方が受け取ることは
   ありません」라고 적어두었으므로, 이 방식이 그 문장을 참으로 유지한다. */
export async function createCheckoutSession({ userId, track, pkg, price, days }) {
  const body = new URLSearchParams({
    mode: "payment",
    success_url: `${SITE}/checkout/done`,
    cancel_url:  `${SITE}/checkout/back`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "jpy",
    "line_items[0][price_data][unit_amount]": String(price),
    "line_items[0][price_data][product_data][name]":
      `${TRACK_LABELS[track].ja}（${TRACK_LABELS[track].kr}） ${days}日分`,
    /* 누가 무엇을 샀는지는 webhook 에서 이것으로만 안다.
       세션 id 로 되묻는 왕복을 늘리지 않기 위해 여기 실어 보낸다. */
    "metadata[user_id]": String(userId),
    "metadata[track]":   track,
    "metadata[package]": pkg
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
               "Content-Type": "application/x-www-form-urlencoded" },
    body, signal: AbortSignal.timeout(10_000)
  });
  ...
}
```

**② webhook 서명 검증** — `lib/signature.mjs` 와 같은 모양입니다.
같은 함정 3가지(생 바이트열 / `timingSafeEqual` / 인코딩)가 그대로 있고,
Stripe 는 **재생 공격을 막는 시각 허용치**가 하나 더 붙습니다.

```js
/* Stripe-Signature: t=1699999999,v1=abc...
   서명 대상은 `${t}.${rawBody}`. JSON.parse 한 것을 다시 stringify 하면
   맞지 않는다 ── lib/signature.mjs 에 적어둔 것과 같은 이유. */
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300 } = {}) {
  if (!Buffer.isBuffer(rawBody)) throw new Error("rawBody 는 Buffer 로");
  const parts = Object.fromEntries(String(header || "").split(",")
    .map((kv) => kv.split("=").map((s) => s.trim())));
  if (!parts.t || !parts.v1) return false;

  /* 오래된 요청을 거절한다. 이게 없으면 한 번 새어 나간 요청을
     언제든 다시 보낼 수 있다. */
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSec) return false;

  const expected = crypto.createHmac("sha256", secret)
    .update(`${parts.t}.`).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(parts.v1, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

**③ 재전송** — Stripe 는 같은 이벤트를 여러 번 보냅니다.
`creditPurchase()` 가 `payment_ref` 의 UNIQUE 위반(1062)으로 이미 막고 있습니다.
`payment_ref` 에 **Checkout Session id** 를 넣습니다.

---

## 5. 결제 완료 후 — 즉시 1일차

### 5.1 왜 즉시 보내야 하는가

결제 직후에 아무것도 안 오면, 그 순간 이용자는 **결제가 됐는지 알 수 없습니다.**
지금 배치는 아침 7시에만 도므로, 밤 10시에 결제한 사람은 9시간을 기다립니다.

### 5.2 두 번 보내지 않는 이유

`deliverOne` 은 이미 `sentToday` 로 그날 발송분을 확인합니다.

```js
if (await pushlogs.sentToday(conn, u.id, "learning", DATE)) return "既送";
```

즉시 발송이 `learning` 으로 오늘 날짜에 기록되므로, **다음 아침 배치는
자동으로 건너뜁니다.** 새 판정을 만들 필요가 없습니다.

```
22:00 결제 → 즉시 1일차 발송 + push_logs(learning, 오늘)
07:00 배치 → sentToday=true → "既送"
익일 07:00 → sentToday=false → 2일차
```

**추가 구매(이미 오늘 레슨을 받은 사람)** 는 즉시 발송이 걸리지 않습니다.
그 경우 「내일 아침부터 이어집니다」로 안내합니다 — 하루 2회 레슨은 원래 없습니다.

```
수정  server/db/push-daily.mjs   deliverOne 을 export 한 채로 재사용
신규  server/lib/handlers/checkout.mjs  결제 완료 → 적립 → 즉시 1회
```

### 5.3 배신 가부 판정이 바뀐다

```js
// 지금 (server/db/push-daily.mjs:260)
const entitled = Number(u.total_days_entitled) || 0;
if (next > entitled) return "日数切れ";

// 앞으로
const remaining = Number(u.days_entitled) - Number(u.days_used);
if (remaining <= 0) return "日数切れ";
```

`listDeliverable()` 도 함께 고칩니다 — `users.active_track` 으로
해당 코스의 진도·잔여만 끌어옵니다.

```sql
FROM users u
JOIN learning_progress    p ON p.user_id = u.id AND p.track = u.active_track
JOIN course_entitlements  e ON e.user_id = u.id AND e.track = u.active_track
LEFT JOIN saju_profiles   j ON j.user_id = u.id
WHERE u.status IN ('trial','active') AND u.active_track IS NOT NULL
```

---

## 6. 만료 예고 · 이탈 장부 · 재개

### 6.1 잔여 2일 예고  ⟵ **결정 ③ 필요**

지시: 「각각 기간만료 2일전에 만료된다는 Push알림」.
횟수권이므로 **「잔여 2회」** 로 읽었습니다. 날짜 기준을 의도하셨다면 알려주십시오.

발송은 그날 레슨 **뒤에** 붙입니다(통지를 따로 울리지 않기 위해).

```js
/* 중복 방지는 새 표를 만들지 않는다. push_logs 의 day_number 에
   「그때의 days_entitled」를 넣어두면, countForDay 로 판정할 수 있다.
   추가 구매로 days_entitled 가 늘면 값이 달라지므로 다시 경고가 나간다
   ── 다음 만료를 또 알려야 하니, 그게 맞는 동작이다. */
if (remaining === 2 && !(await pushlogs.countForDay(conn, u.id, u.days_entitled, "expiring"))) {
  messages.push(expiringNotice(u));                 // 추가 구매 버튼 포함
  await pushlogs.logSent(conn, u.id,
    { dayNumber: u.days_entitled, pushType: "expiring" });
}
```

### 6.2 이탈 장부  ⟵ **결정 ⑧ 필요**

지시: 「중간에 만료되고 이력이 없는 이용자에게는 별도로 이력관리를 하는
장부를 만들고, 확인할수있는 DB를 만듬」.

**이 저장소의 원칙과 부딪치는 곳이 하나 있습니다.** `lib/onboarding.mjs` 는
「導けるものを保存しない」(파생 가능한 것을 저장하지 않는다)를 명시적으로
지키고 있습니다 — 저장하면 실제 상태와 두 개의 진실이 생기기 때문입니다.

「이탈했다」는 지금 `push_logs` + 잔여 일수로 **파생 가능합니다.**
그런데도 표를 두는 것을 권하는 이유는 하나뿐입니다:

> `pushlogs.purgeOlderThan(400)` 이 로그를 지웁니다. 400일이 지나면
> **언제 이탈했는지 복원할 수 없습니다.** 이건 파생이 아니라 소실입니다.

그래서 **「사건」만 담습니다** — 파생 가능한 현재 상태는 담지 않습니다.

```js
/* 잔여가 0이 된 것을 처음 알아챈 배치가 1행만 쓴다.
   두 번 쓰지 않는 것은 UNIQUE 가 아니라 「열려 있는 행이 있으면 안 쓴다」로
   본다 ── 같은 사람이 사고, 다시 떨어지는 일이 반복되기 때문. */
if (remaining <= 0) {
  await lapses.openIfAbsent(conn, u.id, u.active_track,
    { lastDay: u.current_day, daysBought: u.days_entitled });
  return "日数切れ";
}
```

재구매 시 `resumed_at` 을 채웁니다. **아직 안 돌아온 사람** = `resumed_at IS NULL`.
`ix_lapse_open` 이 그 조회를 받습니다.

```
신규  server/lib/repo/lapses.mjs   openIfAbsent / markResumed / listOpen
신규  server/db/lapsed.mjs         운영자 조회 도구 (읽기 전용)
```

`db/lapsed.mjs` 는 `db/who.mjs` 와 같은 규칙을 따릅니다 —
**이름도 생년월일도 출력하지 않습니다.** 출력 대상이 cPanel 배치 로그라
나중에 누구나 읽을 수 있기 때문입니다.

### 6.3 재개 — 「이어서 / 처음부터」

재구매한 코스에 **이미 진도가 있을 때만** 묻습니다.
처음 사는 코스는 물을 것이 없으므로 곧바로 1일차입니다.

```js
/* 결제 완료 직후. 물어야 하는가? */
const prog = await learning.getProgress(conn, userId, track);
if (prog && prog.current_day > 0) {
  await push(user, resumeAsk(track, prog.current_day));   // 즉시 발송은 답한 뒤
  return { asked: "resume" };
}
```

```
┌──────────────────────────────────────┐
│ 初級（초급） 30일분을 받았습니다.      │
│                                       │
│ 지난번 12일차까지 들으셨습니다.        │
│ 어떻게 하시겠습니까?                   │
│  [13일차부터 이어서]  [1일차부터 다시]  │
└──────────────────────────────────────┘
     postback action=resume&track=beginner&mode=continue
     postback action=resume&track=beginner&mode=restart
```

```js
/* mode=continue → current_day 그대로
   mode=restart  → current_day = 0 (days_used 는 건드리지 않는다 §3.2)
   어느 쪽이든 답한 순간 그날치를 즉시 보낸다 ── 답했는데 아무 일도
   일어나지 않으면, 방금 낸 돈이 어떻게 됐는지 알 수 없다. */
```

**답하지 않으면?** 다음 아침 배치가 `resume` 미답 상태를 보고
같은 질문을 보냅니다(상한 3회, `ONBOARD_NOTICE_MAX` 와 같은 이유).
**일수는 소비하지 않습니다.**

### 6.4 101일 완주 → 다음 코스

```js
if (u.current_day >= TOTAL_DAYS) {
  /* 수료 인사는 지금 아무 데서도 안 나간다 ── push_type 'completion' 은
     ENUM 에만 있고 부르는 곳이 없다(research-line-flow.md §4).
     여기가 마지막 접점이자, 다음 코스를 권할 유일한 자리다. */
  await sendCompletion(conn, u);      // 수료 + [중급 1일차부터] [초급 재수강]
  return "修了";
}
```

「중급 1일차부터」를 누르면 §4.2의 가격표(중급)로 갑니다.
결제 후 중급 진도 행이 새로 생기고 1일차가 즉시 갑니다.

---

## 7. 법적 요건 (줄었지만 남아 있습니다)

### 7.1 특정상거래법 표기 페이지 — **여전히 필수**  ⟵ **결정 ⑤**

자동갱신이 아니어도 **통신판매**이므로 표기 페이지는 필요합니다.

| 항목 | 비고 |
|---|---|
| 사업자명 | **개인사업자면 본명** |
| 주소 | **개인사업자면 자택 주소일 수 있음** |
| 전화번호 | 연락 가능한 번호 |
| 판매가격 | 세금 포함 |
| 대금 이외의 필요요금 | 통신료 |
| 지불 방법·시기 | 「신용카드, 신청 시」 |
| 역무의 제공시기 | **「결제 직후 1일차, 이후 매일 아침 7시」** |
| 반품·환불 | **결정 ⑥** |

> ⚠️ **이건 코드로 못 푸는 문제이고, 착수 전에 정해져야 합니다.**
> 법인이 아니면 개인 정보가 그대로 공개됩니다.

```
신규  tokushoho.html                    특정상거래법 표기
수정  tools/build-site.sh               PUBLIC 배열에 추가
수정  tools/set-site-url.py             TARGETS 배열에 추가
수정  sitemap.xml                       /tokushoho 추가
수정  .github/workflows/deploy.yml      스모크 테스트에 /tokushoho
```

> 4곳 전부 고쳐야 합니다. `research.md` §1.4 가 적어둔 대로,
> `PUBLIC` 에 없으면 **배포되지 않고**, `TARGETS` 에 없으면
> 도메인 이전 때 **이 페이지만 옛 호스트를 가리킵니다.**

### 7.2 최종확인화면 — 가벼워졌습니다

자동갱신이 없으므로 「갱신 주기」·「해지 방법」 표시는 해당하지 않습니다.
남는 것은 **분량 / 총액(세금 포함) / 지불 시기 / 제공 시기 / 환불**이고,
그건 §4.2의 가격표 1통에 전부 들어갑니다.

**즉 LINE 의 가격표 메시지가 곧 최종확인화면입니다.** 별도 웹 페이지가
필요 없어졌습니다(초판 §3.3이 요구한 `/checkout` 확인 페이지는 폐기).

### 7.3 privacy.html

제2항(LINE 배신 서비스)에 이미 「ご購入の記録 — 금액·일수·결제 취급 번호」와
제3자 제공처 「決済サービス」가 적혀 있습니다. **추가 개정은 필요 없습니다.**
`purchases.track` 이 늘지만 코스명은 개인정보가 아닙니다.

---

## 8. 결정이 필요한 것

| # | 항목 | 제안 | 막는 것 |
|---|---|---|---|
| ① | **무료 체험 3일** | 남기는 편이 조금 낫다고 봅니다(§2). 지시대로면 폐지 | 스키마·배치 |
| ② | 가격표 | 지금 `PACKAGES` 유지. 코스별로 다르게 할지 | 가격표 화면 |
| ③ | **「만료 2일 전」의 뜻** | **잔여 2회**로 읽었습니다 | 예고 로직 |
| ④ | 동시 진행 코스 | **1개**(`users.active_track`). 다른 코스 잔여는 보존 | 스키마 |
| ⑤ | **특정상거래법 본명·주소** | **미정 — 착수 자체를 막습니다** | 전부 |
| ⑥ | 환불 규정 | 미정 — 표기에 명시해야 함 | 표기·가격표 |
| ⑦ | 리치메뉴 이미지·문구 | 2500×1686 1장. 대표님 준비 | 리치메뉴 |
| ⑧ | 이탈 장부 | 「사건만」 담는 표 + 조회 도구(§6.2) | 스키마 |

**⑤ 가 정해지지 않으면 유료화를 시작할 수 없습니다.** 초판과 같습니다.
①③④⑧ 은 코드 형태를 정하므로 착수 전에, ②⑥⑦ 은 문안 단계에서 필요합니다.

---

## 9. 구현 결과 (2026-08-04)

계획대로 들어갔습니다. 계획과 달라진 곳만 적습니다.

| 계획 | 실제 | 이유 |
|---|---|---|
| 체험을 없앨지 남길지 미정 | **남기되 코스 선택 뒤로** | 친구추가 즉시 3일이면 중급 희망자에게 초급이 감. 「코스 → 가격표 → [무료로 시작]」 |
| 체험을 코스별로 | **계정당 1회** | 코스만 바꾸면 3×3=9일 무료가 됨. `subscriptions.user_id` 일의성으로 잠금 |
| `/checkout` 확인 페이지 | **폐기** | 자동갱신이 아니라 LINE 가격표 1통이 최종확인화면으로 성립 |
| `tokushoho.html` 작성 | **작성 안 함** | 본명·주소를 모름. 대신 `TOKUSHOHO_URL` 이 비면 결제 자체가 안 열림 |
| `deliverNow` 가 목록에서 찾기 | **`findDeliverable` 1인 조회** | 목록 절삭이면 501번째부터 「샀는데 안 옴」 |
| — | **`deliverOne` 에 track 방어 추가** | 코스 없는 행이 오면 예외 대신 「コース未選択」로 세고 내려옴 |

### 9.1 새로 발견해 막은 것 — 진도와 소비 일수의 분리

계획서 §3.2에 적은 함정이 실제로 코드 전반에 걸렸습니다.
`resetProgress` 가 `days_used` 를 건드리면 **잔여가 되살아납니다.**
관문이 이걸 직접 봅니다:

```
✓ 残りは days_used で数える。current_day では数えない
✓ resetProgress は days_used に触らない
✓ advanceDay は日を確保するのと同じ 1 文で days_used を増やす
✓ 確保に負けたら days_used も増えない
```

`advanceDay` 가 확보와 소비를 **한 문장**에서 하는 것도 같은 이유입니다.
두 문장으로 나누면 「확보했는데 아직 소비 안 한」 순간이 생기고,
거기서 죽으면 하루가 공짜가 됩니다.

### 9.2 착수 순서 (원안)

법적 문안을 스키마보다 **먼저** 둡니다 — 표기해야 할 항목이 화면과
데이터 구조를 정하기 때문입니다. 코드를 먼저 쓰면 나중에 다시 고칩니다.

| 단계 | 내용 | 관문 |
|---|---|---|
| 1 | ①③④⑤⑥⑧ 결정 | — |
| 2 | `tokushoho.html` + 가격표 문안 (§7) | `verify-pages` 확장 |
| 3 | `migrations/002` + repo 개편 (§3) | `verify-server` 확장 |
| 4 | 리치메뉴 (§4.1) | `tools/setup-richmenu.mjs` 수동 |
| 5 | Stripe 세션 + webhook (§4.3) | **`verify-billing.mjs` 신규** |
| 6 | 결제 → 즉시 1일차 (§5) | `verify-push` 확장 |
| 7 | 만료 예고 · 이탈 장부 · 재개 (§6) | `verify-billing` |
| 8 | 수료 → 다음 코스 (§6.4) | `verify-push` |
| 9 | Stripe 테스트 모드 전 경로 1회 + 실카드 1회 | 손으로 |

### 9.1 새 관문 `tools/verify-billing.mjs` 가 볼 것

돈이 걸린 곳은 **틀려도 화면에 안 나옵니다.** 청구는 통하고 로그도 정상이라,
이용자가 말하기 전엔 모릅니다.

```
・같은 Checkout Session 을 두 번 처리해도 일수가 두 번 늘지 않는가
・「1일차부터 다시」로 잔여가 되살아나지 않는가          ← §3.2
・서명이 틀린 webhook 을 거절하는가 (=== 이 아니라 timingSafeEqual)
・오래된 t= 를 거절하는가 (재생 공격)
・코스를 바꿔도 다른 코스의 잔여가 사라지지 않는가
・잔여 0 인 사람에게 레슨이 가지 않는가
・예고가 같은 잔여 수준에서 두 번 가지 않는가
・metadata 의 user_id 를 그대로 믿지 않는가 (존재 확인)
```

---

## 10. 제외 — 이번에 하지 않는 것

| 안 하는 것 | 이유 |
|---|---|
| 정기구독(자동갱신) | 지시가 선불 횟수권. 초판 §2·§4·§6 폐기 |
| 쿠폰·할인·캠페인 | 가격이 아직 안 정해짐(②) |
| 코스 동시 수강 | 결정 ④에서 1개로 잡음 |
| 퀴즈 배신(`push_type='quiz'`) | ENUM 에만 있음. 과금과 무관, 별도 |
| 환불 처리 자동화 | 건수가 적을 것. Stripe 화면에서 손으로 + `payment_status='refunded'` |
| LIFF | 리치메뉴 postback 으로 충분. 넣으면 검증에 브라우저가 필요해짐 |
| 잔여 일수 코스 간 이월 | 산 코스에 묶음(④). 이월을 넣으면 「어느 코스로 샀나」가 무의미해짐 |

---

## 11. 규모

`server/` 를 실제로 크게 건드립니다. 정직하게 적습니다.

```
신규  server/lib/stripe.mjs                    세션 생성 + 서명 검증
신규  server/lib/handlers/checkout.mjs         플랜·구매·webhook
신규  server/lib/richmenu.mjs                  리치메뉴
신규  server/lib/repo/entitlements.mjs         코스별 보유 일수
신규  server/lib/repo/lapses.mjs               이탈 장부
신규  server/db/migrations/002-per-course-billing.sql
신규  server/db/lapsed.mjs                     조회 도구
신규  tools/setup-richmenu.mjs
신규  tools/verify-billing.mjs                 관문
신규  tokushoho.html                           특정상거래법 표기

수정  server/app.mjs                  POST /stripe/webhook
수정  server/lib/repo/billing.mjs     코스별. total_days_entitled 제거
수정  server/lib/repo/learning.mjs    코스별 진도. setTrack 폐기
수정  server/lib/repo/users.mjs       active_track. listDeliverable 재작성
수정  server/lib/repo/pushlogs.mjs    expiring / resume 종별
수정  server/lib/onboarding.mjs       STEPS 에서 track 제거 (§3.5)
수정  server/lib/handlers/postback.mjs  plans / plan / buy / resume
수정  server/lib/handlers/follow.mjs    리치메뉴 연결
수정  server/lib/handlers/message.mjs   잔여 표시
수정  server/db/push-daily.mjs        잔여 판정 · 예고 · 수료
수정  server/db/push-evening.mjs      active_track
수정  server/db/migrate.mjs           EXPECTED_COLUMNS
수정  server/db/smoke.mjs             total_days_entitled 검사 교체
수정  tools/build-site.sh             PUBLIC 에 tokushoho.html
수정  tools/set-site-url.py           TARGETS
수정  sitemap.xml / .github/workflows/deploy.yml
```

**신규 10 · 수정 16.** 3단계(스키마)와 5단계(Stripe)에서 한 번씩 크게 끊고,
그때마다 승인을 받는 편이 안전합니다 — 3단계를 되돌리려면 본번 DB를
되돌려야 하고, 5단계 뒤부터는 실제 돈이 움직입니다.
