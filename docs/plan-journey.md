# plan-journey.md — 이용자 여정 개편 (지시서 2026-08-05)

작성: 2026-08-05 / 대표 결정 7건 반영 지시서의 실행 기록 / 기준 커밋: `0b62d51` 이후

> **상태: §1-1·§1-2·§2·§3 구현 완료.** §1-3 은 문면 초안 제시 후 **승인 대기**.
> §4 는 §1-1 배포·확인 후 별도 배포로. §5 는 [plan-line-onboarding.md](plan-line-onboarding.md)
> 승인 대기. §7 은 대표 지시 대기(착수 금지).

---

## 구현 완료 항목

### §1-1 SALES_MODE (checkout.mjs / postback.mjs / app.mjs)

- `salesMode()`: `closed`(기본·오기도 closed 로 수렴) / `test` / `open`
- `salesAllowedFor(user)`: 법정표시 4종은 **필요조건 유지** + 모드.
  `test` 는 `SALES_TEST_USERS`(콤마, users.id 또는 line_user_id) 명단만
- `plans` / `plan` / `buy` 3곳 전부 같은 판정 (관문이 소스에서 강제)
- 기동 시 `SALES_MODE=test` 면 큰 소리로 경고 — 본번에 test 잔류가 유일한 실패 모드

### §1-2 원고 보유일수 = 판매 상한

- `learning.countTemplates(conn, track)` 신설
- `priceList`: `days > 보유일수` 패키지 미표시, 전멸 시 null → `coursePreparing(track)`
- `buy`: 가격표에 없는 pkg 를 data 로 자칭해도 상한에서 차단 (변조 방어)
- `trial`: `TRIAL_DAYS > 보유일수` 면 체험도 시작 안 함
- 관문: 「판매 최대 일수 ≤ 원고 일수」 — 원고를 늘리면 자동으로 위 패키지가 열림

### §2 체험 = 신청 즉시 1일차

- `action=trial` 성공 → `deliverNow` (creditFromStripe 와 같은 주입 패턴,
  `handlePostback` 의 `deliver` opt). 「このあとすぐ 1 日目が届きます」가 사실이 됨
- 조용히 실패하는 종류(対象外·原稿なし)에는 「準備ができしだい」 1통 —
  「곧 도착」이라 말한 직후의 무음을 안 남김. 名前待ち는 deliverOne 이 스스로 안내
- `sentToday` 가 이중 발송을 막음 (기존 구조 그대로)

### §3 잔여 0 → 재구매 안내 (에피소드당 1회)

- `push-daily` 잔여 0 분기: `lapses.openIfAbsent` 의 **created 일 때만**
  `upsellNotice` 1통 + `push_logs(upsell)` 기록 — upsell 타입의 첫 정식 사용
- 문면: 어디까지 진행 / 추가하면 이어짐 / 진행은 안 사라짐 / 受講料 quickReply
- 일수 소비 없음(advanceDay 훨씬 앞), 다음날부터는 created=false 라 침묵

## §1-3 거짓 문구 4건 — 초안 (승인 대기, 코드 미반영)

| 위치 | 초안 |
|---|---|
| message.mjs 정지 안내 | 「配信を止めたいときは、このトークをブロックしてください。すぐに止まります。\n再開をご希望のときは、ブロックを解除のうえ、下のメニューの［受講料］から日数をお求めください。進んだところは消えません。」 |
| pages.mjs 연동 완료 | 「連携できました。このあと LINE のトークで、お名前と生年月日の確認をお送りします。\n毎日のお届けは、LINE の［受講料］でコースをお選びいただくと始まります（はじめての方は無料体験からどうぞ）。」 |
| pages.mjs 친구추가 유도 | 「友だち追加のあと、LINE の［受講料］からコースを選ぶと、無料体験（3 日間）を始められます。」 |
| follow.mjs 인사 | 사이트 실물 버튼 라벨과 동일 문자열로 (「LINE で続きを受け取る」— index.html 실측 후 반영) |

※ 재개 로직(§7 보류)이 정해지기 전까지, 재개 방법은 「추가 구매」로만 안내
(현행 코드로 사실인 유일한 문장 — 재추가만으로 재개된다는 약속을 제거).

## §4 Stripe 테스트 — 착수 대기 (배포 순서)

> STATUS: **A3** (실판매 판단은 **C4**) — [STATUS.md](../STATUS.md) §0.

1. 이번 커밋(§1 가드) 배포 → `SALES_MODE` 미설정 = closed 확인 (실사용자 차단 실측)
2. 대표: cPanel 환경변수에 `SALES_MODE=test` + `SALES_TEST_USERS=<대표 id>` + 테스트 키 2종
3. 검증 경로: 가격표 → Checkout → 테스트 카드 → 웹훅 서명 → `creditPurchase` → 즉시 1일차
4. 재전송 내성: 같은 세션 id 웹훅 2회 → `payment_ref` UNIQUE(1062)로 이중 적립 없음 실측
5. 취소·실패 카드·`payment_status != paid` 3케이스 확인 후 보고
6. **§1 배포와 같은 배포에 키를 넣지 말 것** (지시서 §8)

## 검증

- [x] verify-billing 44→51 (SALES_MODE 3모드·3곳 게이트·상한·체험 4종)
- [x] verify-push 40→42 (upsell 1회·재발송 억제·일수 불소비)
- [x] 19종 557항목 전량 통과

## 남은 것

| | 상태 |
|---|---|
| §1-3 문면 반영 | 초안 승인 대기 |
| §4 | §1 배포 확인 후, 키는 대표 투입 |
| §5 | [plan-line-onboarding.md](plan-line-onboarding.md) 승인 대기 |
| §6 원고 | 대표 작업 (중·상급 각 30일). 코드는 §1-2 가 자동 반영 |
| §7 | 대표 지시 대기 — 착수 금지 |
