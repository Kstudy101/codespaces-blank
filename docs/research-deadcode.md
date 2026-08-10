# research-deadcode.md — 죽은 코드·중복·복잡도 전수 조사

작성: 2026-08-10 / 대상: `Kstudy101/codespaces-blank` (`b39b6eb`)
방법: 추적 중인 193개 파일 중 `.mjs`/`.js` 전부를 심볼 단위로 상호 참조 + `.html`/`.css` 셀렉터 대조
+ `tools/verify-*.mjs` 19종 실기 실행

> 이 문서는 **조사만** 한다. 착수 순서는 §7, 계획서가 필요한 항목은 §7에 명시.
> 요청: 「기존 기능 100% 보존하면서 죽은 코드·중복·복잡도를 정리」 — 먼저 진단.

관련: [research-audit.md](research-audit.md) · [research-lp-pivot.md](research-lp-pivot.md) · [STATUS.md](../STATUS.md) · `CLAUDE.md`

---

## 0. 요약

| 구분 | 결과 | 위험 | 착수 |
|---|---|---|---|
| 관문 19종 | **전부 통과** (조사 시작 시점·종료 시점 모두) | — | — |
| ① LP 사이드바 철거 잔재 | 1건 (`.note` 고아 CSS) | 없음 | 즉시 |
| ② 완전 미사용 export | **18건** — 그중 **10건은 직전 커밋 `b39b6eb`의 잔재** | 낮음 | 즉시 |
| ③ 과잉 export (내부 전용) | **18건** | 없음 | 즉시 |
| ④ 거대 함수 | 80행 초과 **10개**, 최대 514행 | **높음** | 계획서 필수 |
| ⑤ 조·석간 배송 중복 | 약 70행 | **높음** | 계획서 필수 |
| ⑥ 문서 드리프트 | 1건 (`CLAUDE.md`의 `verify-kana` 설명) | 없음 | 즉시 |
| 주석 처리된 옛 코드 | **0건** | — | 해당 없음 |
| TODO / FIXME / HACK | **0건** | — | 해당 없음 |
| 고아 CSS (`page.css`) | **0건** (클래스 24개 전부 사용 중) | — | 해당 없음 |

**이 저장소는 「지저분한 코드」가 아니다.** 주석 처리된 옛 코드도, 방치된 TODO도, 고아 CSS도
사실상 없다. 실제로 나온 것은 **기능을 뺀 커밋들이 남긴 꼬리**와 **처음부터 컸던 핸들러 함수**
두 종류다. 따라서 「전면 리팩토링」이 아니라 **①②③⑥의 국소 정리 + ④⑤의 별도 계획**이 맞다.

---

## 1. 조사 방법과 그 한계

### 1.1 심볼 상호 참조

`git ls-files` 로 추적 파일만 골라(= `dist/`·`server/content/` 등 gitignore 대상 제외)
`.mjs`/`.js` 전부를 읽고, 각 파일의 `export` 심볼이 **다른 파일에 이름으로 등장하는지**를 본다.
등장하지 않으면 다시 **자기 파일 안에서의 등장 횟수**로 두 갈래로 나눈다.

| 분류 | 조건 | 뜻 |
|---|---|---|
| **A 완전 미사용** | 타 파일 0회 · 자기 파일 1회(=선언 그 자체) | 죽은 코드 |
| **B 과잉 export** | 타 파일 0회 · 자기 파일 2회 이상 | 내부 전용인데 공개 표면에 나와 있음 |

### 1.2 이 방법이 놓치는 것 — 반드시 같이 읽을 것

- **문자열로 동적 호출하는 경우**를 못 잡는다. 이 저장소는 `node:vm` 으로 사이트 1부를
  실행하는 자리가 있어(`verify-kana`·`verify-fortune-server`) 특히 조심해야 한다.
  → 보완: 13건 전부를 **추적 파일 전체(`.yml`/`.sql`/`.py`/`.sh` 포함)** 에 다시 grep 해
  **전부 1회(=선언 자신)** 임을 확인했다. §2 표의 「전체 grep」 열.
- **정규식 안에 이름이 박힌 경우**를 「사용」으로 오판한다.
  실제로 `verify-onboarding.mjs` 의 `completeLink`·`consume` 이 그 경우였고
  (`LINK_SRC.match(/export async function completeLink[\s\S]*?\n}\n/)`),
  「같은 함수가 두 파일에 있다」는 후보에서 제외했다.
  **이 오판이 실제로 5건을 숨겼다** — §2.3.
- **`server/content/` 는 gitignore** 라 조사 대상 밖이다. 원고 생성 스크립트
  (`_build-*.mjs`)는 로컬에만 있고 저장소에는 `_build-lib-stub.mjs` 만 있다.

### 1.3 CSS 셀렉터 대조

`page.css` 와 각 페이지 인라인 `<style>` 의 클래스명을, 같은 페이지의 마크업 +
그 페이지가 `<script src>` 로 읽는 `.js` 안의 문자열과 대조했다.

오탐이 한 번 나왔다 — `omikuji.html` 의 `.tone-good`/`.tone-mid`/`.tone-warn` 이
미사용으로 잡혔으나, 실제로는 [omikuji.html:220](../omikuji.html#L220) 에서
`` class="om-grade tone-${esc(r.grade.tone)}" `` 로 **조립**된다. 살아 있다.
→ 클래스명을 템플릿 리터럴로 잇는 자리가 있으면 이 방식은 반드시 오탐을 낸다.

---

## 2. ② 완전 미사용 export — 18건

`export` 되어 있으나 **본번 코드 어디에서도(자기 파일 포함) 호출되지 않고,
관문도 import 하지 않는다.**

| 파일 | 심볼 | 전체 grep | 왜 죽었나 |
|---|---|---|---|
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `timeUnknown` | 1회 | **`b39b6eb` 잔재** (아래 §2.1) |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `birthRedo` | 1회 | **`b39b6eb` 잔재** |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `askBirthCity` | 1회 | **`b39b6eb` 잔재** |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `fixPicker` | 1회 | **`b39b6eb` 잔재** |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `askBirth` | 2회* | **`b39b6eb` 잔재** (§2.3) |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `askBirthDate` | 2회* | **`b39b6eb` 잔재** (§2.3) |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `askBirthTime` | 2회* | **`b39b6eb` 잔재** (§2.3) |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `askBirthPlace` | 2회* | **`b39b6eb` 잔재** (§2.3) |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `summaryConfirm` | 2회* | **`b39b6eb` 잔재** (§2.3) |
| [`server/lib/repo/users.mjs`](../server/lib/repo/users.mjs) | `setBirthConfirmed` | 1회 | **`b39b6eb` 잔재** |
| [`server/lib/repo/learning.mjs`](../server/lib/repo/learning.mjs) | `listProgress` | 1회 | 운영 조회용으로 만들었으나 미연결(추정) |
| [`server/lib/repo/learning.mjs`](../server/lib/repo/learning.mjs) | `listTemplates` | 1회 | 〃 |
| [`server/lib/repo/learning.mjs`](../server/lib/repo/learning.mjs) | `listCheckpoints` | 1회 | 〃 |
| [`server/lib/repo/pushlogs.mjs`](../server/lib/repo/pushlogs.mjs) | `dailySummary` | 1회 | 〃 |
| [`server/lib/repo/pushlogs.mjs`](../server/lib/repo/pushlogs.mjs) | `listFailures` | 1회 | 〃 |
| [`server/lib/repo/links.mjs`](../server/lib/repo/links.mjs) | `countPending` | 1회 | 〃 |
| [`server/lib/repo/billing.mjs`](../server/lib/repo/billing.mjs) | `findByPaymentRef` | 1회 | 〃 |
| [`server/lib/fortune-text.mjs`](../server/lib/fortune-text.mjs) | `resetCache` | 1회 | 시험용 훅으로 보이나 관문이 안 씀 |

「전체 grep」 = 추적 파일 전체(`.md` 제외)에서의 출현 횟수. **1회 = 선언 자신뿐**.
`*` 표시한 2회는 「선언 + [`verify-onboarding.mjs:1052`](../tools/verify-onboarding.mjs#L1052)
의 **금지 목록**」이다 — 언급이지 사용이 아니다(§2.3).
`.md` 에 언급된 것은 `birthRedo` 하나뿐이고, 그 문서가 §2.1의 근거다.

### 2.0 유지해야 하는 것 — 오탐 4건

같은 조사에서 「본번 미사용」으로 잡혔으나 **관문이 실제로 가져다 시험하므로 남긴다.**

| 심볼 | 가져가는 곳 |
|---|---|
| `HANDLED_TYPES` ([`server/lib/webhook.mjs`](../server/lib/webhook.mjs)) | [`verify-webhook.mjs:57`](../tools/verify-webhook.mjs#L57) — `const { … } = await import(…)` 로 받아 222행에서 검사 |
| `engineDir`·`categories` ([`server/lib/fortune.mjs`](../server/lib/fortune.mjs)) | [`verify-fortune-server.mjs:18`](../tools/verify-fortune-server.mjs#L18) |
| `deactivate` ([`server/lib/richmenu.mjs`](../server/lib/richmenu.mjs)) | [`tools/setup-richmenu.mjs:22`](../tools/setup-richmenu.mjs#L22) |

`HANDLED_TYPES` 는 특히 위험했다 — `import {…} from` 만 보는 검출기는 **구조분해 동적 import**
를 못 봐서 「죽음」으로 판정한다. 지웠으면 `verify-webhook` 이 즉시 빨개졌겠지만,
관문이 없는 자리였다면 조용히 깨졌다.

### 2.1 5건은 직전 커밋이 만든 꼬리 — 지우는 게 그 커밋의 마무리다

`b39b6eb` 「Drop birthplace and birth-date questions from LINE onboarding and profile edit」
직전(`a0b182d`)과 비교하면 이렇다.

| 심볼 | `a0b182d` | `b39b6eb`(HEAD) |
|---|---|---|
| `timeUnknown` | 15회 | **1회** |
| `fixPicker` | 4회 | **1회** |
| `birthRedo` | 3회 | **1회** |
| `askBirthCity` | 3회 | **1회** |
| `setBirthConfirmed` | 3회 | **1회** |
| `cityOf` | 7회 | 2회 (→ §3 과잉 export 로 강등) |

`askBirth`·`askBirthDate`·`askBirthTime`·`askBirthPlace`·`summaryConfirm` 5개도 같은 커밋에서
호출부를 잃었다. 이쪽은 §2.3의 이유로 처음 집계에서 빠졌다.

즉 이 5개는 **원래 죽어 있던 코드가 아니라, 방금 호출부만 걷어내고 정의가 남은 것**이다.
`CLAUDE-karpathy.md` §3 「내 변경이 만든 고아는 내가 치운다」에 정확히 해당한다.

> `birthRedo` 는 [research-onboarding-gap.md §4](research-onboarding-gap.md) 가
> 「처음부터 사이트로 유도하는 게 설계」라고 기록해 둔 함수다. 그 설계 자체가
> `b39b6eb` 으로 없어졌으므로, 함수를 지울 때 **그 문서에도 한 줄 남겨야** 한다.
> 문서와 코드가 어긋난 적이 4번 있었다는 `CLAUDE.md` 경고가 여기에 걸린다.

### 2.3 관문의 「금지 목록」이 5건을 숨기고 있었다

[`verify-onboarding.mjs:1052`](../tools/verify-onboarding.mjs#L1052) 는 이렇게 생겼다.

```js
const mfs = ob.match(/export async function messageForStep[\s\S]*?\n}/)[0];
assert(!/askBirthDate|askBirthTime|askBirthPlace|askBirth|summaryConfirm/.test(mfs),
  "messageForStep が生年月日チェーンを呼んでいます");
```

**`!` 로 시작하는 부정 단언 — 「이 이름들이 나오면 안 된다」는 뜻**이다. 그런데 이름 대조식
검출기에게는 「`tools/` 어딘가에 이 이름이 있다 = 쓰이고 있다」로 보인다. 정반대다.

이 5개는 전부 「선언 1회 + 금지 목록 1회」로 **본번 호출부가 0**이다. 지워야 하고,
지우면 금지 목록도 무의미해지므로 **그 단언도 같은 커밋에서** 손봐야 한다
(§7 4단계). 함수가 없어지면 「함수를 부르지 않는다」는 검사는 항상 참이 되어,
관문이 초록인 채로 아무것도 지키지 않게 된다.

### 2.2 나머지 8건 — `repo/` 조회 함수는 「미완성」일 수 있다

`listProgress`·`listTemplates`·`listCheckpoints`·`dailySummary`·`listFailures`·
`countPending`·`findByPaymentRef` 는 전부 **읽기 전용 조회**다. 운영 중 손으로 상태를
들여다보려고 미리 깎아둔 것으로 보이나, 연결한 흔적이 코드에도 문서에도 없다.

- 지우는 쪽: 지금은 죽은 코드다. 필요해지면 git 이력에서 되살리면 된다.
- 남기는 쪽: `repo/` 는 「넘겨받은 `conn.execute()` 만 쓴다」는 규율이 잡힌 계층이라,
  나중에 같은 쿼리를 다시 깎느니 두는 편이 싸다.

**대표 판단 필요.** 조사자 의견은 **삭제**다 — 되살리는 비용이 `git log -S` 한 번이고,
「있는데 안 쓰는 함수」가 다음 사람에게 「어딘가 쓰이겠지」로 읽히는 비용이 더 크다.

`resetCache` 는 성격이 다르다. `fortune-text.mjs` 의 모듈 캐시를 비우는 시험용 훅인데
관문 19종 중 아무도 쓰지 않는다. 캐시를 시험하려면 필요해질 수 있으니
**지울 때 관문에서 필요해지지 않는지 한 번 더 볼 것.**

---

## 3. ③ 과잉 export — 18건

자기 파일 안에서만 쓰이는데 `export` 가 붙어 있다. **`export` 키워드만 떼면 되고 동작은 0 변화.**

| 파일 | 심볼 |
|---|---|
| [`server/lib/richmenu.mjs`](../server/lib/richmenu.mjs) | `createMenu` `uploadImage` `setDefault` `deleteMenu` |
| [`server/lib/content-check.mjs`](../server/lib/content-check.mjs) | `HANGUL` `JAPANESE` `LATIN1_MOJIBAKE` |
| [`server/lib/onboarding.mjs`](../server/lib/onboarding.mjs) | `cityOf` `BLOCKING_STEPS` |
| [`server/lib/render.mjs`](../server/lib/render.mjs) | `weekSlot` `dayKindOf` |
| [`server/lib/session.mjs`](../server/lib/session.mjs) | `COOKIE_NAME` `TTL_MS` |
| [`server/lib/handlers/checkout.mjs`](../server/lib/handlers/checkout.mjs) | `askResume` |
| [`server/lib/linelogin.mjs`](../server/lib/linelogin.mjs) | `loginConfig` |
| [`server/lib/repo/learning.mjs`](../server/lib/repo/learning.mjs) | `packMicro` |
| [`server/lib/repo/util.mjs`](../server/lib/repo/util.mjs) | `isDuplicateKey` |
| [`server/lib/stripe.mjs`](../server/lib/stripe.mjs) | `stripeConfig` |

가장 뚜렷한 예가 `richmenu.mjs` 다. 외부([`tools/setup-richmenu.mjs:21`](../tools/setup-richmenu.mjs#L21))는
`menuDefinition`·`AREAS`·`install`·`listMenus` 넷만 가져간다. `createMenu`·`uploadImage`·
`setDefault` 는 `install()` 이 내부에서 부르는 단계고, `deleteMenu` 는 아무도 안 부른다
(→ 엄밀히는 §2의 A에 가깝지만, 같은 모듈의 다른 함수와 짝이라 여기 둔다).

### 3.1 주의 — 관문이 `export` 문자열을 보는 자리가 있다

`tools/verify-*.mjs` 는 소스를 **정규식으로 읽는** 검사를 여럿 갖고 있다. 예:

```js
const fn = LINK_SRC.match(/export async function completeLink[\s\S]*?\n}\n/)[0];
```

`export` 를 떼면 이런 검사가 **함수를 못 찾아 조용히 깨진다**(정확히는 `[0]` 에서 터진다).
따라서 ③은 「`export` 만 지우고 관문 19종」이 아니라, **심볼마다 `verify-*.mjs` 안에서
`export ... <심볼명>` 패턴을 먼저 grep** 하고 손대야 한다.

---

## 4. ④ 거대 함수 — 80행 초과 10개

| 행수 | 위치 | 비고 |
|---:|---|---|
| **514** | [`server/lib/handlers/postback.mjs:144`](../server/lib/handlers/postback.mjs#L144) `handlePostback()` | 최대 |
| **374** | [`server/db/push-daily.mjs:340`](../server/db/push-daily.mjs#L340) `deliverOne()` | **위험** ↓ |
| 234 | [`tools/verify-onboarding.mjs:138`](../tools/verify-onboarding.mjs#L138) `consume()` | 관문 내부 |
| 195 | [`server/lib/handlers/message.mjs:61`](../server/lib/handlers/message.mjs#L61) `handleMessage()` | |
| 195 | [`tools/verify-onboarding.mjs:445`](../tools/verify-onboarding.mjs#L445) `completeLink()` | 관문 내부 |
| 155 | [`js/name-learn-data.js:586`](../js/name-learn-data.js#L586) `run()` | 공개 안 됨 |
| 121 | [`server/lib/handlers/link.mjs:193`](../server/lib/handlers/link.mjs#L193) `completeLink()` | |
| 114 | [`server/db/migrate.mjs:202`](../server/db/migrate.mjs#L202) `main()` | CLI |
| 109 | [`server/db/accel-day.mjs:120`](../server/db/accel-day.mjs#L120) `main()` | CLI |
| 86 | [`saju.js:207`](../saju.js#L207) `pillars()` | 역법 계산 |

### 4.1 `deliverOne()` 은 함부로 쪼개면 안 된다

`CLAUDE.md` 가 이 저장소에서 특히 조심할 것으로 못박은 두 가지가 이 함수 안에 있다.

> - **잔여 일수는 `days_entitled - days_used`.** `current_day` 로 세면 안 된다
> - **`advanceDay` 는 일자 확보와 일수 소비를 한 문장에서** 한다. 나누면 그 사이에
>   죽었을 때 하루가 공짜

「읽기 좋게 함수를 나눈다」가 **바로 이 규칙을 깨는 형태**다. 374행이라는 숫자만 보고
착수하면 안 되고, 나눌 경계를 계획서에서 먼저 합의해야 한다.

`handlePostback()` 514행은 성격이 다르다 — 포스트백 종류별 `if` 분기의 나열로 보이며,
분기를 표로 빼는 정도는 상태를 건드리지 않는다. 그래도 규모상 계획서 대상이다.

---

## 5. ⑤ 조·석간 배송의 중복 — 약 70행

[`server/db/push-daily.mjs`](../server/db/push-daily.mjs)(814행) 와
[`server/db/push-evening.mjs`](../server/db/push-evening.mjs)(266행) 가
동일한 이름의 함수 셋 — `deliverOne` · `retryKey` · `tooEarly` — 을 각자 갖고 있고,
그 밖에 CLI 인자 파싱 / 시각 게이트(`NOT_BEFORE`) / 도달불가 처리(`isUnreachable` →
`markUnfollowed`) / 로그 출력이 겹친다.

공통부 추출은 가능하지만 **여기는 배송 경로**다. §4.1과 같은 이유로 계획서 대상이며,
`verify-push` · `verify-evening` 을 먼저 읽고 「무엇을 고정하고 있는지」를 확인한 뒤여야 한다.

---

## 6. ⑥ 문서 드리프트 — `CLAUDE.md` 의 `verify-kana` 설명

`CLAUDE.md` 「이 저장소에서 특히 조심할 것」:

> 유일한 예외: `server/lib/kana2hangul.mjs` — 허가된 사본. `verify-kana` 가
> **index.html 실물**과 전수 대조하므로, 한쪽을 고치면 관문이 다른쪽을 강제한다

그런데 [`tools/verify-kana.mjs:12`](../tools/verify-kana.mjs#L12) 는 이렇게 적고 있다.

> 2026-08-10 LP 化で index.html から正本を外した。正本の置き場だけが変わり…

실제 정본은 [`js/name-learn-data.js`](../js/name-learn-data.js) 이고, 그 파일 머리말도
「`verify-name`/`verify-kana` 의 정본. 공개 페이지에서는 읽지 않는다(build-site PUBLIC 밖)」
라고 스스로 밝히고 있다. **관문은 정상 동작한다 — `CLAUDE.md` 쪽 문장이 낡았다.**

LP 전환(`d9b9b33`)으로 index.html 에서 진단 기능이 빠질 때 `CLAUDE.md` 가 따라가지 않은 것이다.
「폴리시와 코드가 어긋난 적이 4번 있다」에 5번째를 추가하지 않으려면 지금 고쳐야 한다.

---

## 7. 착수 순서

`CLAUDE.md` 절차상 ④⑤는 `docs/plan-refactor-*.md` 승인 후에만 손댄다.

- [x] **1단계 — 사이드바 철거 잔재** : [`index.html:84`](../index.html#L84) `.note` 고아 CSS 삭제.
      2026-08-10 세션에서 `class="note"` 사용처 2곳을 지우며 남긴 것. 검증: `verify-pages`.
- [x] **2단계 — ⑥ 문서 드리프트** : `CLAUDE.md` 의 `verify-kana` 설명을 실물에 맞춘다.
      코드 변경 0. 검증: 문장과 `tools/verify-kana.mjs` 머리말 대조.
- [x] **3단계 — ③ 과잉 export 18건** : `export` 키워드만 제거.
      **선행 필수** — §3.1 대로 심볼마다 `verify-*.mjs` 의 정규식에 걸리는지 grep.
      검증: 관문 19종.
- [x] **4단계 — ② 잔재 10건** : `b39b6eb` 이 남긴 `timeUnknown`·`birthRedo`·`askBirth`·
      `askBirthDate`·`askBirthTime`·`askBirthPlace`·`askBirthCity`·`summaryConfirm`·
      `fixPicker`·`setBirthConfirmed` 삭제. 연쇄로 드러난 고아 2개
      (`onboarding.mjs` 의 `cityOf`, `fortune.mjs` 의 `cities`)와
      쓰이지 않던 `import { cities }` 도 같이 제거.
      `verify-onboarding` 의 금지 목록을 §2.3 대로 **파일 전체 검사로 격상**하고,
      함수를 되돌려 넣어 실제로 빨개지는지 확인했다(`askBirth が残っています`).
      onboarding.mjs 519 → 345행. 검증: **관문 19종 통과**.
- [ ] **5단계 — ② 나머지 8건** : `repo/` 조회 7건 + `resetCache`. **§2.2 대표 판단 후.**
      `HANDLED_TYPES` 는 §2.0 대로 **제외**(관문이 씀). 검증: 관문 19종.
- [ ] **6단계 — ④ 거대 함수** : 착수 전 `docs/plan-refactor-handlers.md` 작성·승인.
      `deliverOne` 은 §4.1 경고를 계획서에 그대로 옮길 것.
- [ ] **7단계 — ⑤ 배송 중복** : 착수 전 `docs/plan-refactor-push.md` 작성·승인.

### 범위 밖(scope 밖) — 이번에 건드리지 않는다

- **긴 주석 블록.** 「주석 처리된 옛 코드」로 걸린 건
  [`tools/verify-name.mjs:70`](../tools/verify-name.mjs#L70) 한 줄이고 그마저 설명문이다.
  나머지는 전부 의사결정 기록이며 `CLAUDE.md` 가 「각 파일 머리말에 이유가 있다」고 못박았다.
- **10장 HTML 의 `<head>` 중복**(AdSense·GA4·Clarity). 빌드툴 없음이 이 저장소의 설계이고,
  `verify-pages` 가 10장을 나란히 대조해 지킨다. 묶는 순간 그 관문이 무의미해진다.
- **`server/db/accel-day.mjs`·`check-line.mjs`·`gen-review-quiz.mjs`.** 아무 데서도
  import 되지 않지만 머리말에 실행법이 적힌 **수동 운영 CLI** 다. 죽은 코드가 아니다.
- **`js/name-learn-data.js`.** `build-site.sh` 의 PUBLIC 밖이라 배포되지 않지만,
  `verify-name`/`verify-kana` 의 **정본**이다(§6).
- **`page.css`.** 클래스 24개 전부 사용 중. 손댈 것 없음.
