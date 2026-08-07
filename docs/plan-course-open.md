# plan-course-open.md — 세 코스 동시 개방 전 확인 (지시서⑭ §5)

> 2026-08-07 작성. 지시서⑭ §8-3 「Claude Code: §5-1·§5-3 확인, §5-4 근본 수정」에 대한 답.
> **상태: §5-1·§5-3 조사 완료 / 수정은 승인 대기 — 코드 미작성.**
> 관련: [plan-course-onboarding.md](plan-course-onboarding.md) · [plan-billing.md](plan-billing.md) · [STATUS.md](../STATUS.md)

---

## 0. 결론 4줄

1. **§5-1 대표님 이해는 정확합니다.** 배달은 `active_track` 하나뿐이고, 구매하면 그쪽으로 전환됩니다.
2. **되돌릴 수단은 없습니다.** 「내 진도」는 ▶ 를 보여줄 뿐 버튼이 없고, 자동 복귀는 **차단 후 재추가** 한 경로뿐입니다 — §1-2 에 돈이 묶이는 시나리오.
3. **§5-3 은 지적하신 그대로입니다.** `plans` 는 `TRACKS` 전체를 그대로 냅니다. **단계 0 직후 반드시 헛걸음이 납니다.**
4. **§5-4 는 이미 다른 손이 작업 중입니다** (작업 트리에 미커밋, 「지시서⑮」 인용). 저는 건드리지 않았습니다 — §3.

---

## 1. §5-1 — 배달은 한 번에 한 코스뿐

### 1-1 확인 ① 이해가 맞는가 → **맞습니다**

`server/lib/repo/users.mjs:180-183`

```sql
FROM users u
JOIN learning_progress   p ON p.user_id = u.id AND p.track = u.active_track
JOIN course_entitlements e ON e.user_id = u.id AND e.track = u.active_track
WHERE u.status IN ('trial','active') AND u.active_track IS NOT NULL
```

`course_entitlements` 는 코스별로 여러 행을 가질 수 있지만, 배달 대상 조회는 **`active_track` 과 일치하는 한 행만** JOIN 합니다. 저녁 복습(`pushlogs.mjs:189-199`)도 같습니다.

`active_track` 을 바꾸는 곳은 **정확히 4곳**입니다 (전수 확인).

| 위치 | 언제 |
|---|---|
| `checkout.mjs:382` `startTrialFor` | 체험 시작 (계정당 1회) |
| `checkout.mjs:441` `creditFromStripe` | **구매 성립 시 — 자동 전환** |
| `checkout.mjs:535` `applyResume` | 재구매 직후의 「계속/처음부터」 |
| `postback.mjs:529` `trackpick` | 온보딩의 코스 선택 (체험 소진 시엔 코스만 세움) |

### 1-2 확인 ② 되돌릴 수단이 있는가 → **없습니다. 그리고 이것이 문제입니다**

- 「내 진도」(`statusMessage`, `checkout.mjs:646-656`)는 보유 코스를 나열하고 현재 코스에 `▶` 를 붙이지만, **`quickReply` 가 없습니다** — 읽는 화면이지 고르는 화면이 아닙니다.
- `resume` 는 **재구매 직후에만** 나옵니다(`checkout.mjs:451-461`). 그 코스의 「계속/처음부터」이지, 코스 전환 메뉴가 아닙니다.
- `trackpick` 은 온보딩 track 단계에서만 발신됩니다(`onboarding.mjs:461`).
- 자동 복귀는 `entitlements.firstWithRemaining` 인데, 호출자가 **`follow.mjs:123` 하나뿐**입니다 — **차단했다가 다시 추가한 사람**에게만 걸립니다.

**돈이 조용히 묶이는 시나리오** (지금 코드로 실제로 일어납니다):

```
초급 30일권 구매 → 10일 수강 (초급 잔여 20일)
  ↓
중급 7일권 구매 → active_track = intermediate 로 자동 전환
  ↓
중급 7일 소진 → 잔여 0 → 배달 대상에서 이탈
  ↓
초급 잔여 20일은 살아 있으나 아무도 그쪽으로 되돌려 주지 않음
  ↓ 되돌리는 길
  (ㄱ) 초급을 또 산다   (ㄴ) 차단했다가 다시 추가한다
```

**(ㄴ)가 유일한 무료 복구 수단인 상태를 이용자에게 안내할 수는 없습니다.**

### 1-3 확인 ③ 2026-08-05 결정과 모순되는가 → **전제가 반대입니다**

지시서는 그 결정을 「코스를 **나중에 바꿀 수 있다**」로 적으셨는데, 기록은 반대입니다.

[plan-course-onboarding.md:134](plan-course-onboarding.md) — **(나) 코스 변경 불가 안내 — 확정**

> askCourse 문면에 1행 추가·유지: 「あとから変更できませんので、じっくりお選びください。」
> (체험 1회 제한과 정합 — **코스를 바꾸는 유일한 길은 추가 구매**)

문면·코드·관문(`verify-onboarding.mjs:795`)이 셋 다 이 결정대로입니다.
**따라서 구매 시 자동 전환은 결정과 모순되지 않습니다** — 오히려 결정이 예정한 동작입니다.

다만 **읽는 사람 입장의 어긋남은 남습니다**:

> 「あとから変更できません」이라고 읽었는데, 중급을 사자 **실제로 바뀌었다.**

「변경 불가」는 *무료로는* 못 바꾼다는 뜻이고, 코드는 *사면* 바꿉니다. 이 간극이 §5-1 의 문의로 돌아옵니다.

### 1-4 대표님 결정이 필요한 것 (지시서 §5-1 말미)

「한 번에 한 코스」를 정책으로 확정하실지. **확정하신다면 문면 2곳이 필요합니다.**

| 곳 | 지금 | 넣을 취지(초안) |
|---|---|---|
| `askCourse` (선택 화면) | 「あとから変更できませんので、じっくりお選びください。」 | + 「お届けは**一度に 1 コース**です。別のコースをお申し込みになると、そちらへ切り替わります（進みは残ります）。」 |
| `statusMessage` (내 진도) | 「▶ が、いまお届けしているコースです。」 | + 「切り替えは、そのコースをお申し込みになったときに行われます。」 |

**저는 §1-2 의 시나리오 때문에 「전환 수단」쪽을 권합니다** — 문면만으로는 잔여 20일이 묶이는 것을 막지 못합니다.
다만 그건 **새 기능**이므로 이 지시서의 범위 밖입니다. 별건 계획으로 낼지 알려 주십시오
(가장 작은 형태: 「내 진도」에 보유 코스 전환 quickReply 1개. `applyResume` 가 이미 하는 일이라 새 로직은 거의 없습니다).

---

## 2. §5-3 — `plans` 는 거르지 않습니다 (지적 정확)

### 2-1 실물

```js
// postback.mjs:403-404 — 리치메뉴 [受講料]
const owned = (await entitlements.listByUser(conn, user.id)).map((e) => e.track);
const replied = await reply(token, [askCourse({ owned })], send);   // pick 없음

// checkout.mjs:205 — askCourse 안
const list = pick ? pick.tracks : TRACKS;    // ← pick 이 없으면 3코스 전부
```

거르는 쪽(온보딩)은 이렇게 합니다 — `onboarding.mjs:458`

```js
if (TRIAL_DAYS <= await countTemplates(conn, t)) selectable.push(t);
```

### 2-2 ★ 단계 0 직후 반드시 헛걸음이 납니다

단계 0 이 끝나면 중급·상급은 **원고 3일**입니다. 그때:

| 화면 | 판정 | 결과 |
|---|---|---|
| `plans` (코스 고르기) | **없음** | 중급이 보입니다 |
| `plan` (가격표) | `sellablePackages(3)` → 최소 7일권 > 3 → 빈 배열 | **「準備中」** (`postback.mjs:425-427`) |

즉 **누른 다음에 막힙니다.** 지시서 §5-3 의 예측 그대로입니다.

### 2-3 그런데 「`trackpick` 과 같은 기준」으로는 안 풀립니다

두 기준은 **목적이 다릅니다.**

| | 기준 | 묻는 것 |
|---|---|---|
| `trackpick` 목록 | `TRIAL_DAYS(3) <= 원고일수` | 체험을 **시작**할 수 있는가 |
| `plan` 가격표 | `sellablePackages(원고일수).length > 0` (최소 7일) | **팔** 수 있는가 |

`plans` 에 3일 기준을 넣으면 **중급(원고 3일)이 여전히 목록에 남고, 눌러도 여전히 「準備中」** 입니다. 헛걸음이 그대로입니다.

### 2-4 제안 — `plan` 이 이미 쓰는 판정을 그대로 씁니다

`sellablePackages` 는 이미 **공용 판정**으로 쓰이도록 설계돼 있습니다(`checkout.mjs:106-111` 주석):

> priceList と 体験 2 日目の夕方の勧誘が**同じ判定**を見る ──
> 別々に書くと、片方だけ直した日に「買えないのに『追加できます』」が出る

`plans` 를 **세 번째 사용자**로 만들면, 지시서 §7 의 「`plans` 와 `trackpick` 의 판정을 따로 만들지 마십시오」도 지켜집니다 — 새 판정을 만들지 않고 **있는 것을 재사용**하기 때문입니다.

```js
/* postback.mjs — action === "plans" */
const owned = (await entitlements.listByUser(conn, user.id)).map((e) => e.track);

/* 買えるコースだけを出す。ここで絞らないと、原稿 3 日ぶんの中級を
   選ばせてから価格表で「準備中」になる ── 押した人には理由が無い。
   判定は plan 分岐と同じ sellablePackages（新しい物差しを増やさない）。 */
const sellableTracks = [];
for (const t of TRACKS) {
  if (sellablePackages(await learning.countTemplates(conn, t)).length) sellableTracks.push(t);
}
if (!sellableTracks.length) {
  return { userId: user.id, action, blocked: "原稿不足",
           replied: await reply(token, [notReady()], send) };
}
const replied = await reply(token, [askCourse({ owned, only: sellableTracks })], send);
```

`askCourse` 에는 **`pick` 과 별개인 `only`** 를 더합니다 — `pick` 은 「시작하기(trackpick)」 문면이고 `plans` 는 「가격표 보기(plan)」 문면이라, `pick` 을 재사용하면 버튼의 `action` 까지 바뀝니다.

```js
export function askCourse({ owned = [], pick = null, only = null } = {}) {
  const list = pick ? pick.tracks : (only || TRACKS);
```

**한 줄 변경**입니다. 기존 호출 2곳의 동작은 바뀌지 않습니다.

### 2-5 트레이드오프

| | |
|---|---|
| 팔 것이 하나도 없으면 목록이 빈다 | `notReady()` 로 분기 (위 코드). 안 넣으면 **선택지 0개짜리 메시지**가 나갑니다 |
| **수강 중인데 목록에서 사라질 수 있다** | 중급을 체험 중인 사람이 [受講料] 를 눌러도 중급이 안 보입니다(팔 게 없으므로). 「準備中」이 낫다고 보시면 `owned` 는 예외로 남기는 변형도 가능 — **대표님 판단** |
| DB 조회 3회 증가 | `countTemplates` × 3. `plan` 분기가 이미 1회 하고 있고, 리치메뉴 탭 빈도라 무시 가능 |

---

## 3. §5-4 — 이미 다른 손이 작업 중입니다 (제가 건드리지 않은 이유)

작업 트리의 `server/lib/repo/learning.mjs` 에 **미커밋 변경**이 이미 있습니다.

```js
       quiz               = IF(VALUES(quiz) IS NULL, quiz, VALUES(quiz))
```
```js
/* 既に quiz が入っている日。seed が「保全した件数」を数えるため
   （指示書⑮ §3 …）*/
export async function listQuizKeys(conn) { … }
```

- 지시서⑭가 지시한 것(`IF(VALUES(quiz) IS NULL, …)` + 보존 로그)과 **같은 내용**입니다
- 주석이 **「지시서⑮」**를 인용합니다 — 제가 받은 ⑭보다 뒤 번호입니다
- 이 세션 도중에 `7ef1b61` 커밋과 `docs/research-content-ci.md` 도 제가 만들지 않은 채 나타났습니다

**같은 작업 트리에서 다른 세션이 동시에 일하고 있습니다.** 제가 여기에 손을 대면 서로 덮어씁니다.
그래서 **읽기만 하고 그대로 두었습니다.**

**아직 없는 것: 관문.** `VALUES(quiz)` / `listQuizKeys` 를 보는 검사는 `tools/` 어디에도 없습니다
(전수 확인). 지시서 §9-10 이 요구한 「관문 증가분」이 이 부분입니다 —
그쪽 세션이 넣을 예정인지 확인되면, 아니면 제가 넣겠습니다.

---

## 4. 대표님께 여쭐 것

```
§5-1  「한 번에 한 코스」를 정책 확정?      예 / 아니오
      확정 시 문면 2곳(§1-4) 넣습니까?      예 / 아니오
      코스 전환 수단을 별건으로 계획?        예 / 아니오  ← §1-2 의 잔여 묶임 때문에 권장
§5-3  §2-4 안(sellablePackages 재사용)으로 고칩니까?   예 / 다른 기준
      수강 중인 코스는 못 팔아도 목록에 남깁니까?      예 / 아니오
§5-4  관문은 제가 넣습니까, 다른 세션이 넣습니까?
```

승인 주시면 §2-4 는 그날 바로 넣고 `verify-webhook`/`verify-onboarding` 에 관문을 답니다
(원고 일수별로 목록이 달라지는 것을 가짜 conn 으로 전수 확인 — 네트워크·DB 불요).
