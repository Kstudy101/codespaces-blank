# research-onboarding-gap.md — 온보딩 「질문 결손」 진단

작성: 2026-08-05 / 지시: 대표님 작업지시서 §1 / 기준 커밋: `ceb2582`
방법: 상태 기계·재연동·배신 대상 SQL 의 전수 코드 추적 + 순수 함수 실측 재현

> **결론 1줄: H1 부분 성립 + 설계 변경 오해 2건 + 진짜 결손 2건.**
> ①·③이 안 나온 것은 결손이 아니라 현행 설계이고, 진짜 문제는
> (A) 마지막 답변 뒤 **종결 안내가 0통**이라 「그대로 종료」로 체감되는 것,
> (B) `learning_progress` 수동 삭제 후 **배신 대상에서 조용히 탈락하고
> 자기복구 경로가 없는 것**입니다. H2 는 기각 — 그 서브플로우는 원래 없습니다.

---

## 1. 「정상 플로우 = 질문 3종」 전제가 낡았습니다

증거의 「예전 기록」은 **migrations/002 이전**의 것입니다.

- **③코스 선택은 002 에서 의도적으로 제거** — 코스는 구매 시(리치메뉴 →
  受講料) 고릅니다. [onboarding.mjs](../server/lib/onboarding.mjs) `STEPS = ["name", "birth"]`,
  주석: 「段に残したままにすると、まだ何も買っていない人に毎朝『コースを
  選んでください』が飛び、押しても買う所へ行けない」. **③ 미출현 = 정상.**
- **① 미출현도 이 계정에선 정상** — `PENDING.name = !name_source && name_kr && display_name`.
  대표 계정은 이전 온보딩에서 `name_source` 가 확정돼 있고, 재연동은
  [link.mjs](../server/lib/handlers/link.mjs) `if (user.name_source) setNameSource("web")` 로
  「재진단 = 선택의 답 그 자체」로 취급해 **다시 묻지 않습니다**.
  §0.5(재확인 금지)와 **정합하는 동작**입니다.
- **② 만 나온 것도 정상** — 재연동의 `upsertSajuProfile` 은 생년월일이
  바뀌었을 때만 `birth_confirmed` 를 내립니다(`IF(birth_date <=> VALUES…)`,
  [users.mjs](../server/lib/repo/users.mjs)). 날짜가 바뀌었거나 saju 행도 지워졌다면 ② 재출현.

순수 함수 실측 (nextStep/blockingStep):

```
대표(재연동+②답변 후)        nextStep=null   ← 물을 것이 없음 = 침묵 종료
재연동(날짜 변경/saju 삭제)   nextStep=birth  ← ② 만 나옴 (대표 체험과 일치)
신규(연동 직후)               nextStep=name   ← ①부터 정상 진행
부분삭제(saju 없음)           nextStep=null   ← 생년월일 없이도 「물을 것 없음」★
```

## 2. 진짜 결손 A — 마지막 답변 뒤 종결 안내 0통

[postback.mjs](../server/lib/handlers/postback.mjs) birth ok=1: `reply(token, [await followUp(...)])`.
`followUp` 은 다음 단이 없으면 **null** → `reply` 는 null 을 걸러 **아무것도 안
보냅니다.** 답했는데 무응답 — 「그대로 종료」 체감의 직접 원인. postback 머리말
스스로 「答えたのに何も起きていないように見える」를 경고해 둔 그 구멍이,
**마지막 단에서만** 열려 있습니다 (중간 단은 다음 질문이 있어서 안 보임).

신규 사용자도 같은 자리에서 침묵으로 끝나므로, 구매(코스 선택)로의 유도가
연동 직후의 serviceGuide 1통에만 실려 있습니다.

## 3. 진짜 결손 B — 부분 삭제 후 조용한 배신 탈락, 자기복구 없음 (H1 의 실체)

배신 대상 SQL ([users.mjs](../server/lib/repo/users.mjs) `DELIVERABLE_SQL`):

```sql
JOIN learning_progress   p ON p.user_id = u.id AND p.track = u.active_track   -- INNER
JOIN course_entitlements e ON e.user_id = u.id AND e.track = u.active_track   -- INNER
```

`learning_progress` 행만 지우면 **INNER JOIN 에서 그 사람이 통째로 사라집니다.**
에러도 로그도 없이 아침 배신이 멈춥니다. 행을 만드는 곳은
`ensureProgress` 뿐이고 호출처는 **구매·체험 시작뿐** — 재연동도, 온보딩
완주도, 웹훅 접점도 재생성하지 않습니다. **대표 계정은 지금 배신 대상이
아닙니다** (active_track·entitlements 는 남아 있는데 진행 행이 없음).

지시서의 표현대로 「수동 삭제·장애 후 막다른 상태」가 실재합니다.

## 4. H2 기각 — 「入れ直したい」 서브플로우는 사라진 게 아니라 원래 없음

> **2026-08-10 갱신** — `b39b6eb` 으로 LINE 온보딩에서 생년월일 질문 자체가 없어졌고,
> 이 절이 다루는 `birthRedo`·`askBirth`·`summaryConfirm` 등은 호출부를 잃었습니다.
> 정의도 같은 날 제거했습니다([research-deadcode.md §2.1](research-deadcode.md)).
> 아래 기술은 **`b39b6eb` 이전 상태**의 기록으로 읽어 주십시오.

`birthRedo` 는 처음부터 **사이트로 유도**합니다. 주석에 이유가 있습니다:
날짜 해석(1995/4/12·H7.4.12·…)을 LINE 에서도 하면 읽기가 2벌이 되고,
어긋나면 사주가 갈라진다. Phase 1(`4cfab37`)은 **이름 경로만** 이식했고
birth 경로는 무접촉 — git diff 로 확인. 날짜→시간→확인의 LINE 내
서브플로우는 코드 이력 어디에도 없습니다.

## 5. 미결 경보 답 — track=NULL 생성 경로

- 002(이번 `ceb2582` 교정판) 이후 `learning_progress.track` 은 **ENUM NOT NULL**.
- 행 생성은 `ensureProgress` 하나뿐이고 `isTrack()` 검증을 통과한 값만 들어감.
  **NULL 행 생성 경로는 없습니다.** (002 의 DELETE 가 과거 NULL 행을 청소)
- **신규 플로우 온보딩 완주는 본번에서 성립** — 연동→①→②→(침묵·결손 A)→
  리치메뉴 구매→ensureProgress→배신. 단 002 교정 배포(`ceb2582`)의 성공 확인이
  선행 (별건, 배포 지시서의 판정 3종).

## 6. §0.5 와의 정합 메모 (수정 시 반영할 판단 1건)

재연동 시 `completeLink` 가 `updateName` 으로 **name_kr 을 사이트 값으로
덮어씁니다.** §0.5 「재연동과 무관하게 유지」와 표면상 긴장이 있으나,
재진단→재연동은 **본인의 명시적 재입력**이므로 「명시적으로 요청할 때」에
해당한다고 해석하는 것이 자연스럽습니다 (코드 주석도 같은 취지:
「入れ直したなら、その名前が答えそのもの」). 계획서에 이 해석을 명문화
예정 — 대표님이 달리 보시면 주석으로 교정해 주십시오.

## 7. 본번 대조용 SELECT (H1 확정 마무리 — 대표님, phpMyAdmin)

코드 추적상 판정은 위로 충분하지만, 대표 계정의 실제 행 유무로 못 박습니다:

```sql
SELECT id, name_kr, name_source, active_track, status FROM users WHERE line_user_id = '<대표 LINE ID>';
SELECT user_id, birth_date, birth_confirmed FROM saju_profiles     WHERE user_id = <ID>;
SELECT user_id, track, current_day, days_used FROM learning_progress WHERE user_id = <ID>;  -- 0행 예상
SELECT user_id, track, days_entitled FROM course_entitlements       WHERE user_id = <ID>;  -- 행 있음 예상
```

## 8. 수정 방향 (승인 대기 — §2 착수 전)

| 결손 | 안 |
|---|---|
| A 종결 침묵 | followUp 이 null 이면 **종결 1통**: 코스 미구매자는 受講料 유도, 구매자는 「明日の朝からお届けします」 |
| B 자기복구 | 사용자 접점(웹훅 진입 시): `active_track` 있고 그 코스의 entitlement 가 있는데 progress 행이 없으면 `ensureProgress` 로 재생성. 대표 계정 정상화는 배포 후 재온보딩이 이 경로를 실검증 |
| §0.5 단순화 | 이름 질문 판정을 name_kr 기반으로 정리하는 폭은 계획서에서 안 2개로 제시 |

이후 §3(프로필 편집)·§4(gender 004)·§5(privacy) 는 별도 계획서
`plan-profile.md` 로 — §4 대운 질문의 대표님 답과 §5 문안 확정이 선행.
