# plan-outage-billing.md — 돈과 콘텐츠가 걸린 2건: LINE 장애 시 일수 소각 / 결제 실패 시 무권리

상태: **조사·설계 완료, 승인 대기.** 코드 수정 없음 (2026-08-05 작업지시서 §4 — 설계 보고까지가 범위).

트레이드오프가 있어 구현 전 판단이 필요한 2건이다. 각 절에 ①사실(코드 실측),
②안별 장단, ③권고안, ④승인 시 수정될 파일을 적었다.

---

## 1. LINE 장애 시 유료 일수 소각 (지시서 §4-1)

### 1-1. 사실 — 코드로 확인한 것

| 위치 | 내용 |
|---|---|
| `lib/repo/learning.mjs` L131 | `advanceDay`는 **확보와 일수 소비를 한 문장**에서 한다 (`current_day = ?, days_used = days_used + 1 ... WHERE current_day = ?`). 나누면 그 사이에 죽었을 때 하루가 공짜 — 의도된 설계(STATUS §8-2) |
| `db/push-daily.mjs` L462 | **송신 전에 확보**한다. 실패 시 `logFailed`만 남기고 되돌리지 않는다 |
| `db/push-cron.sh` | cron은 **매시** 돈다. 몇 시에 보낼지는 배치가 JST를 보고 결정 (`--not-before=7`) |
| `lib/repo/pushlogs.mjs` `sentToday` | `status='sent'`만 센다. **failed는 「보냈다」로 치지 않는다** |
| `db/push-daily.mjs` L141 `retryKey` | `sha256(userId:day:type:DATE)` — **day가 들어가므로** 매시 다른 날짜를 시도하면 키도 매번 달라져 LINE측 중복 제거가 걸리지 않는다. 뒤집으면: **같은 날짜의 재송신은 같은 키**가 된다 (같은 JST일 내에서. DATE도 키에 들어 있다) |

이 다섯 개가 겹치면, LINE 5xx가 이어지는 아침에:

```
07:00  day 6 확보(소비) → LINE 500 → logFailed   ← 6일차 소각
08:00  sentToday=false → day 7 확보(소비) → 실패  ← 7일차 소각
09:00  …매시 1일씩
```

사용자에게 아무것도 도착하지 않은 채 선불 일수만 매시 줄어든다.

### 1-2. 안별 검토

#### (A) 실패 재송신 — 소각을 0으로

`deliverOne` 선두(sentToday 검사 뒤)에 자기복구를 하나 넣는다:

```js
/* 마지막으로 확보한 날(current_day = N)이 아직 배달되지 않았으면
   (learning×N의 'sent'가 없고 'failed'만 있으면), 새로 확보하지 않고
   N일차를 다시 조립해 재발송한다. */
const N = Number(u.current_day) || 0;
if (N >= 1 && !(await pushlogs.everSent(conn, u.id, "learning", N))
           &&  (await pushlogs.everFailed(conn, u.id, "learning", N))) {
  const tpl = await learning.getTemplate(conn, u.track, N);
  if (tpl) {
    const messages = renderDay(tpl, u); /* + 운세는 기존 조립 경로 재사용 */
    await send(u.line_user_id, messages, { retryKey: retryKey(u.id, N, "learning") });
    await pushlogs.logSent(conn, u.id, { dayNumber: N, pushType: "learning" });
    return `재송신:${N}일차`;
  }
}
```

- **소각 0.** 확보(=소비)된 날을 배달 완료까지 물고 늘어진다. 새 확보는 배달이
  끝난 뒤에만 일어나므로, 장애 중 매시 1일 소각 자체가 사라진다.
- **「발송 전 확보」 규칙과 충돌하지 않는다** (지시서의 전제 조사).
  재송신이 다루는 날은 **이미 확보(소비)가 끝난 날**이다. 확보 없는 발송이
  생기는 게 아니라, 발송 없는 확보를 회수하는 방향이므로 이중 발송
  방지 장치를 뒤집지 않는다. 무료 하루도 생기지 않는다(소비는 확보
  시점에 이미 끝났다).
- **이중 발송 위험**: 같은 JST일 안의 재송신은 retryKey가 기존 실패 시도와
  **동일**하므로, 「실제로는 도착했는데 logSent 전에 죽은」 경우도 LINE측
  중복 제거가 막는다(기존 배치 재기동 보호와 같은 원리). 날을 넘긴
  재송신만 키가 바뀌는데(DATE 포함), 이 창은 기존 코드에도 같은 형태로
  존재한다. ※ LINE의 retry key 보존 기간은 공식 문서 확인이 필요
  — 구현 시 확인 후 주석에 남길 것.
- **원고 없음(未入稿) failed와 섞이지 않는다**: 그 failed는 `dayNumber = next`
  (확보 전 날짜)로 남고, 재송신 조건은 `current_day`(확보된 날) 기준이다.
- **차단자와의 상호작용이 좋다**: 발송 실패로 `markUnfollowed`된 사람이
  §2-1(재추가 복귀)로 돌아오면, 미배달분 N일차가 자동 재송신된다 —
  돈 낸 날이 배달된다.
- 비용: 재조립 경로 ~15줄 + everSent/everFailed 소구 2개 + 관문 케이스.
  재시도 자체는 cron 주기(매시)로 유계이며, 배달되거나 날이 밝을 때까지다.

#### (B) 배송 창 제한 — `--not-after=9`

- `--not-before`가 이미 있으므로 대칭 플래그 추가는 소규모다.
- 장애가 온종일 이어져도 소각은 창 안의 2~3회로 **제한**될 뿐, 소실 자체는
  남는다. 지시서의 평가("손실을 줄일 뿐 살리지 못한다")와 같다.
- 부수 효과는 좋다: (A)를 넣은 뒤에도, 15시에 LINE이 복구되면 15시에
  그날치가 배달되는데, 「아침 강좌」가 오후에 오는 것을 허용할지는
  상품의 성격 문제다. B는 그 상한 시각을 명문화한다.

#### (C) A+B 병용 — **권고**

A가 소각을 0으로 만들고, B가 「그날의 배달은 몇 시까지인가」라는 상품
정의를 코드에 박는다. B의 시각(예: 9시)은 대표님 결정 사항.
B를 뺀 A만으로도 회계적 손실은 사라지므로, 창 제한이 불필요하다고
판단하시면 A 단독도 성립한다.

### 1-3. 승인 시 수정될 파일

- `server/db/push-daily.mjs` — 재송신 분기 + (B라면) `--not-after`
- `server/lib/repo/pushlogs.mjs` — everSent / everFailed (day 지정 판정)
- `tools/verify-push.mjs` — 재현 관문: 확보 후 실패 → 다음 회에 같은 날짜
  재송신·advanceDay 불호출 / 원고 없음 failed로는 재송신 안 됨

---

## 2. 결제 실패 시 「돈은 받고 일수 없음」 (지시서 §4-2)

### 2-1. 사실 — 세 결함의 겹침

1. **`app.mjs` L290 — 200 선반환.** 주석은 「재송으로 이중 적립은
   `purchases.payment_ref` UNIQUE가 막으니 200을 먼저 반환해도 된다」.
   이는 **전부 성공한 뒤의 재송**에만 참이다. 반쯤 성공(아래 2)의 경우
   그 UNIQUE가 **회복을 막는 자물쇠로 반전**되고, 200을 이미 돌려줬으니
   Stripe의 3일 자동 재시도도 오지 않는다. LINE 웹훅의 「200 먼저」와
   달리 결제는 놓친 이벤트의 값이 돈이다.
2. **`billing.creditPurchase`가 트랜잭션이 아니다.**
   `INSERT purchases` → `entitlements.grant` → `UPDATE subscriptions` 순서.
   INSERT 뒤에 죽으면 결제 기록만 남고 일수는 0. 재송이 와도 1062 →
   `{created:false}` → `duplicate:true`로 **조용히 무시**된다.
3. **감시측**: `findEntitlementDrift`는 이번 §3에서 maintain이 일 1회
   호출하도록 착수했다(2026-08-05, 커밋 14b57f4). 단 **사각 2곳**이 남는다
   — DRIFT_SQL이 `FROM course_entitlements`로 시작하므로,
   (i) **첫 구매**가 반쯤 실패해 e행 자체가 안 생긴 경우,
   (ii) `startTrial` 반쯤 실패(subscriptions행만 생김)의 경우.
   특히 (ii)는 subscriptions.user_id UNIQUE 때문에 **체험을 영원히
   재시도할 수 없는** 상태가 된다.

### 2-2. 안별 검토

#### (A) 웹훅 응답 정책 변경 — 실패 시 non-2xx

- Stripe는 non-2xx면 최대 72시간 지수 백오프로 재시도한다. 회복의
  기회가 생긴다.
- **성공 경로 지연 검토 결과**: 현재 후처리에는 LINE 발송(구매 알림·
  「이어서/처음부터」 질문)과 `deliverNow`(1일차 조립+발송)까지 들어
  있다. 이를 전부 응답 전에 하면 웹훅 타임아웃 → 불필요한 재시도가
  된다. **분리 설계**가 필요하다: DB 필수부(creditPurchase = 台帳+日数)
  까지만 동기로 하고 그 성패로 200/500을 정한 뒤, 메시지·즉시배달은
  지금처럼 비동기로 남긴다. 「200 먼저」를 「필수 DB 쓰기 직후」로
  옮기는 것.
- **주의**: A 단독으로는 불충분하다. 재시도가 와도 half-done 상태면
  1062 → duplicate 무시로 회복이 안 된다. **B와 병용해야** 재시도가
  의미를 갖는다 (트랜잭션이면 half-done이 없으므로, 실패 = 행 없음 =
  재시도가 처음부터 다시 쓴다).

#### (B) 트랜잭션 도입 — **근본 수리**

- `withTransaction`은 `lib/db.mjs`에 구현돼 있고 **호출처 0**. 넘기는
  conn은 `execute`/`beginTransaction`/`commit`/`rollback`을 갖고, repo는
  받은 conn의 `execute()`만 쓰므로 **「conn.execute()만」 규약과 호환**
  된다(확인 완료). 감싸는 범위의 SQL은 전부 DML이라 MySQL 암묵
  커밋도 없다.
- **관문 호환성이 설계 포인트다.** 핸들러가 db.mjs(=mysql2)를 직접
  import하면 가짜 conn으로 도는 관문이 깨진다. 주입으로 푼다:

```js
/* handlers/checkout.mjs */
export async function creditFromStripe(conn, ev,
  { deliver = null, send = pushMessage, transact = (fn) => fn(conn) } = {}) {
  ...
  const credited = await transact((tx) =>
    billing.creditPurchase(tx, user.id, ev.track, ev.packageType, {...}));
```

  본번(app.mjs)은 `transact: withTransaction`을 넘기고, 관문은 기본값
  (그냥 같은 conn으로 실행)으로 SQL 순서를 지금처럼 검증한다.
- 감싸는 단위: `creditPurchase` 전체(INSERT+grant+subscriptions)와
  `startTrial` 전체(INSERT+grant). `ensureProgress`/`setActiveTrack`까지는
  묶지 않는다 — 그쪽은 접점 자기복구(healProgress·§2-1)가 이미 줍는
  종류이고, 지켜야 할 불변식은 「**台帳이 있으면 日数도 있다**」 하나다.

#### (C) 드리프트 감시 확장 — 사각 2곳을 닫는 안전망

`maintain`의 ③에 역방향 대조 2본을 추가한다:

```sql
-- 台帳(purchases)은 있는데 보유(e)가 없다/모자란다 → 첫 구매 half-done 검출
SELECT p.user_id, p.track, SUM(p.days_granted) AS bought, COALESCE(e.days_entitled,0) AS held
  FROM purchases p LEFT JOIN course_entitlements e
    ON e.user_id = p.user_id AND e.track = p.track
 GROUP BY ... HAVING held < bought + 체험분;

-- 체험 기록(subscriptions.trial_track)은 있는데 그 코스의 e행이 없다 → startTrial half-done 검출
SELECT s.user_id, s.trial_track FROM subscriptions s
  LEFT JOIN course_entitlements e
    ON e.user_id = s.user_id AND e.track = s.trial_track
 WHERE s.trial_track IS NOT NULL AND e.user_id IS NULL;
```

과거에 이미 발생했을지 모르는 half-done도 이것으로 드러난다(B는 앞으로를
막고, C는 과거분을 찾는다).

#### 권고

**B+C를 1단계로**(근본 + 안전망), **A는 2단계로**(응답 분리 설계와 함께).
B가 들어가면 half-done 자체가 사라지므로 A의 가치는 「트랜잭션 전체가
실패하는 계열 장애(DB 접속 단절 등)에서 Stripe 재시도가 회복 경로가
된다」로 좁혀진다. 그래도 유익하지만, 응답 분리를 동반해야 하므로
따로 승인받는 편이 diff가 작다.

### 2-3. `checkout.session.async_payment_succeeded` 미처리 건 (함께 보고)

**사실**: `lib/stripe.mjs` `readCheckoutEvent`는
① `checkout.session.completed`만 받고, ② `payment_status !== 'paid'`면
버린다. 콘비니·은행이체는 completed가 **unpaid로** 오고(→②에서 버려짐),
입금 시점에 `async_payment_succeeded`가 오는데(→①에서 버려짐), 결과는
「입금됐는데 일수는 영원히 0」. **Stripe 대시보드에서 결제수단을 켜는
것만으로 발생**하며 코드 변경이 필요 없다는 점이 위험의 본체다.

**대응 제시** (판단 요청):

- **(가) 지금 닫는다** — `readCheckoutEvent`가
  `async_payment_succeeded`도 같은 형태로 받게 한다 (~3줄. 이
  이벤트의 session 구조는 completed와 같고 payment_status='paid'로
  온다). payment_ref가 session id이므로, completed(paid)와 이중으로
  와도 1062가 막는다 — 기존 이중 방지에 그대로 올라탄다.
- **(나) 현상 유지 + 운영 수칙 명문화** — 「Stripe 대시보드에서 카드 외
  결제수단을 켜지 않는다」를 STATUS §8에 박는다. 코드 0줄이지만,
  대시보드 설정 하나에 「돈 받고 미배달」이 걸려 있는 상태가 남는다.

권고는 **(가)**. 방어가 3줄이고 기존 유니크 제약에 올라타므로 부작용
표면이 좁다.

### 2-4. 승인 시 수정될 파일

- `server/lib/handlers/checkout.mjs` — transact 주입 + creditPurchase/
  startTrial 호출을 트랜잭션으로 (B)
- `server/app.mjs` — `transact: withTransaction` 전달 (B) / 응답 분리 (A, 2단계)
- `server/db/maintain.mjs`·`server/lib/repo/billing.mjs` — 역방향 대조 (C)
- `server/lib/stripe.mjs` — async_payment_succeeded 수용 (2-3 (가))
- `tools/verify-billing.mjs` — 재현 관문: grant 직전 사망 시나리오에서
  재시도로 회복되는지 / async 이벤트 수용

---

## 3. 제외 (scope 밖)

- 지시서 §6의 이월 항목 전부 (아침 배치 페이지네이션 등)
- 위 안들의 구현 — 이 문서는 설계까지. 주석(메모) 반영 후 승인을 기다린다.
