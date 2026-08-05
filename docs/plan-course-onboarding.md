# plan-course-onboarding.md — 코스 선택을 온보딩 말미에 (선택 즉시 무료 체험)

작성: 2026-08-06 / 지시: 착수 대기 4건 §2 / 기준 커밋: `cc17aaa` 이후

> **상태: 승인 대기. 승인 전 구현 금지.** 문면 3건(§7)은 대표 확정 대상.
> 대표 결정 재확인(§2-1): **「체험 신청 즉시 1일차 발송」 유지** — 이전 지시의
> deliverNow 제거는 취소, postback 체험 분기는 현행 배포분 그대로.

---

## 0. 무엇이 바뀌나

지금: 온보딩(이름→생년월일→요약확인)이 끝나도 **코스는 리치메뉴 [受講料]에서
스스로 찾아 골라야** 시작된다. 게다가 [受講料]는 `salesAllowedFor`(법정표시
4종+SALES_MODE) 뒤에 있어 **판매가 닫혀 있으면 무료 체험조차 시작할 수 없다** —
온보딩을 완주해도 「質問に全部答えたのに何も来ない」로 끝나는 막다른 길.

후: 온보딩 말미에 **코스 선택 단계(track)** 를 추가. 고르면 그 자리에서 무료
체험이 시작되고 **1일차가 즉시 도착**한다. 이 단계는 무료이므로 판매 게이트를
타지 않는다 — **Stripe가 언제 열리든 이용자는 강좌를 시작할 수 있다 (§4-가,
이번 변경의 최대 이득).**

## 1. 흐름 (지시 2-2)

```
① 이름 확인 → ② 생년월일 확인(요약확인 포함) → ③ 코스 선택
    └ 고르면 곧: 체험 개시 처리 → 개시 안내 1통 + 그 자리에서 1일차
[2일차 아침] → [2일차 저녁 복습] → 결제 유도 1통 (신규, §6)
[3일차] 마지막 무료분 → (기존 잔여 0 → 재구매 안내 경로로 합류)
```

## 2. 상태 기계 (지시 2-3)

- `STEPS` 말미(요약 확인 `birth` **뒤**)에 **`track`** 추가:
  ```js
  STEPS = ["name", "reading", "bdate", "btime", "bplace", "bgender", "birth", "track"]
  PENDING.track = (u) => !!u.birth_date && !!u.birth_confirmed && !u.active_track
  ```
  값에서 도출, **열 추가 0** (원칙 유지). birth_confirmed 뒤에만 — 확인이 끝나야
  「시작할 준비가 된 사람」이고, 그 전에 끼어들면 요약 확인과 순서가 섞인다
- **`BLOCKING_STEPS` 에는 넣지 않는다** — 코스 미선택자는 이미 배치가 스킵
  (`listDeliverable` 의 `active_track` JOIN). 막을 필요가 없는 것을 막으면
  기존 이용자 흐름만 다친다
- 문면·quickReply 는 **`checkout.mjs` 의 `askCourse` 재사용** — 002에서 옮겨간
  것을 onboarding 쪽에 다시 복사하지 않는다 (사본 금지와 같은 결). `messageForStep("track")`
  이 `askCourse({ owned })` 를 부르는 형태. askCourse 의 버튼 data 는 기존
  `action=plan&track=…`(가격표행)이므로, **이 단계 전용의 `action=trackpick&track=…`
  버튼 변형이 필요** — askCourse 에 opts 를 더해 data 만 갈아끼운다 (문면 공유·행선지 분리)

## 3. 선택 시 처리 (지시 2-3)

`action=trackpick` (postback 신설):

- **기존 함수를 부른다**: `startTrialFor(conn, user, track)` — 내부가 이미
  `startTrial(grant 3일) + ensureProgress + setActiveTrack` 순서. 새 경로 없음
- 성공 → 개시 안내 1통(§7-가) reply → **`deliverNow`** (현행 체험 분기와 동일
  주입 패턴 `{ deliver }`). 対象外·原稿なし엔 기존 한마디 그대로
- **체험을 이미 쓴 사람**(`startTrialFor` → `kind:"used"`): 체험을 다시 주지
  않고 **`setActiveTrack` 만** 세운 뒤 유료 안내([受講料] 유도)로 응답.
  active_track 이 서므로 다음 아침부터 배치 대상이 되고, 잔여 0이면 기존
  재구매 안내 경로가 이어받는다

## 4. 두 개의 가드 (지시 2-4 — 필수)

- **(가) 판매 게이트를 타지 않는다** — `trackpick` 분기는 `salesAllowedFor` 를
  호출하지 않는다. 무료이므로 법정표시 4종·`SALES_MODE`와 무관. 관문으로
  「trackpick 분기에 salesAllowedFor 부재」를 정적 검사 (반대 방향의 관문 —
  plans/plan/buy 는 게이트 필수, trackpick 은 게이트 금지)
- **(나) 원고 보유일수 가드** — 체험 가드와 **같은 함수**(`TRIAL_DAYS >
  countTemplates(track)`) 사용. 원고 3일 미만 코스는 askCourse 선택지에서 제외.
  **고를 코스가 0개면 그 사실을 안내**하고 단계는 pending 인 채 유지(무한 대기
  화면 금지 — 원고가 들어오면 다음 접점에서 자연히 다시 물음)

## 5. 기한 예고 억제 (지시 2-5 — 필수)

즉시 1일차로 `remaining` 3→2가 되는 순간, 현행 `expiringNotice` 조건
(`remaining - 1 === EXPIRING_AT(2)`)이 **체험 첫 아침 통에 「あと 2 日です」를
붙인다** — 방금 시작한 사람에게 곧 끝난다고 말하는 셈.

- **체험 중(trial 이력만 있고 구매 0) 이용자에게는 아침 `expiringNotice` 를 억제**
- 결제 유도는 **2일차 저녁 1회로 일원화** (§6)
- **유료 구매자의 예고는 현행 유지** — 판별은 `purchases` 유무(기존
  `billing`/`entitlements` 조회 재사용, 열 추가 0)

## 6. 2일차 저녁 결제 유도 (지시 2-6 — 신규)

- **저녁 배치**(push-evening)에서 그날 복습을 **보낸 뒤** 1통 추가
- 조건: 체험 중 && `current_day === 2`
- **통산 1회만** — `push_logs` 의 `upsell` 타입으로 기록해 재발송 차단
  (§3의 잔여 0 안내와 같은 타입이지만 `day_number=2` 로 구별 가능)
- **일수 불소비** — 저녁 배치의 불변식(`advanceDay` 미호출)을 깨지 않는다.
  관문이 감시 (verify-evening 확장)
- **판매 불가 상태 분기** — 유도의 quickReply 가 「準備中」으로 이어지면
  헛걸음. `salesAllowedFor(user)` 를 **발송 전에** 보고:
  - 판매 가능 → §7-다 문면 + [受講料] quickReply
  - 판매 불가 → **발송 보류** (그날 저녁엔 안 보냄. 판매가 열린 뒤의 접점은
    잔여 0 재구매 안내가 담당) — 문면을 바꿔 보내는 안보다 단순하고, 살 수
    없는 사람에게 결제 이야기를 꺼내지 않음. **대표 확정 대상** (§7)

## 7. 문면 3건 (대표 확정 대상 — 초안)

**(가) 개시 안내** (즉시 발송 반영판, 지시 초안 그대로):

```
初級（초급）で始めます！

このあとすぐ「1 日目」をお届けします。
明日からは、毎日この時間にお届けします。
　朝 7 時　文法 ＋ 会話 ＋ 単語 3 語（＋ 今日の運勢）
　夕 6 時　その日の文法をもう一度（復習）

まずは 3 日間、無料でお試しいただけます。

お名前から始まる韓国語、どうぞ楽しんでいってください！
```

**(나) 코스 변경 불가 안내** — 「선택 화면에」(고른 뒤 말하면 늦다):
askCourse 문면에 1행 추가·유지: 「あとから変更できませんので、じっくりお選びください。」
(체험 1회 제한과 정합 — 코스를 바꾸는 유일한 길은 추가 구매)

**(다) 2일차 저녁 결제 유도** — 판매 가능할 때만:

```
無料でお試しいただける 3 日分のうち、明日が最後の 1 日です。

初級（초급）は 2 日目まで進みました。

続けてお受け取りになる場合は、下から日数を追加できます。
追加された日数は、いまの続きに足されます。
```

- 판매 불가 시: **발송 보류** (§6) — 이 선택 자체도 확정 부탁

## 8. 검증 계획 (지시 2-8)

- 「체험 즉시 발송」 기존 관문 4건(verify-billing)을 **새 사입(trackpick →
  즉시 발송)도 검사**하도록 확장 — 기존 trial 분기 검사와 병렬
- 부분 상태 × 단계 도출 전수에 `track` 포함 (verify-onboarding 확장):
  birth_confirmed 전엔 track 안 물음 / active_track 있으면 종결(締め) /
  체험 사용자·미사용자 분기 / 원고 0 코스 제외
- 저녁 유도: 1회만·일수 불소비·판매 불가 시 보류 (verify-evening 확장)
- 기한 예고 억제: 체험 중 억제·유료자 유지 (verify-push 확장)
- 기존 19종 회귀

## 9. 수정 파일 (예상)

| 경로 | 변경 |
|---|---|
| `server/lib/onboarding.mjs` | STEPS+track·PENDING·messageForStep / onboardingDone 의 미구매 문면은 track 단계로 대체되므로 정리 |
| `server/lib/handlers/checkout.mjs` | askCourse 에 data 변형 opts + 원고 0 코스 제외 |
| `server/lib/handlers/postback.mjs` | `action=trackpick` 신설 (startTrialFor·deliverNow 재사용) |
| `server/db/push-daily.mjs` | 체험 중 expiringNotice 억제 |
| `server/db/push-evening.mjs` | 2일차 저녁 유도 (조건·1회·보류 분기) |
| `tools/verify-billing·onboarding·evening·push` | §8 |

## 10. 제외 (scope 밖)

- 코스 변경 기능 (변경 불가가 정책 — 문면으로 안내)
- §3(결제 경로 보강)·§4(배치 장애 대응) — 별도 배포 단위 (같은 지시서의 다른 절)
- 판매 개시 대기 화면(§7 보류 중 문면) — 기존 보류 그대로
