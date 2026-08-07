# 라이브 검증 지시서 — 기한 예고 (E3)

> STATUS: **E3** — [STATUS.md](../STATUS.md) §0.
> 코드·관문 통과. **잔여 2일** (`EXPIRING_AT=2`) 시점의 실계정에서 확인.

작성: 2026-08-08 / 근거: [plan-quiz.md](plan-quiz.md) · [checkout.mjs](../server/lib/handlers/checkout.mjs)

## 전제

- 유료 구매 이력 있음 (`billing.hasPurchases`)
- 체험(`trial`) 중이 **아님** — 체험 시작 통에 예고가 붙지 않는 것은 A2에서 확인済
- `days_entitled - days_used` 가 **오늘 배신 후 2** 가 되는 아침
  （`willRemain === EXPIRING_AT`, `next = current_day + 1`）

## §1. 발송

| # | 확인 | 기대 |
|---|---|---|
| 1 | 문면 | `お預かりしている日数が、あと 2 日です。` |
| 2 | 진도 표시 | `N 日目まで進んでいます`（또는 101일 완료 문구） |
| 3 | quickReply | `受講料を見る` → `action=plan&track=…` |
| 4 | 같은 날 복습 퀴즈 | **없음** (예고일 스킵) |
| 5 | 같은 entitlement 기간 | 예고 **1회만** (재발송 없음) |

## §2. DB

```sql
SELECT push_type, day_number FROM push_logs
 WHERE user_id = <ID> AND push_type = 'expiring'
 ORDER BY id DESC LIMIT 5;
```

해당 entitlement 구간에 `expiring` 1건.

## §3. 재현 (테스트 계정)

```bash
# DB에서 days_entitled / days_used 조정 후（백업 후）
node db/with-env.mjs db/push-daily.mjs --user=<ID> --dry-run
```

dry-run 출력에 예고 통 포함 · 복습 퀴즈 없음.

## §4. 보고

- 실계정 또는 테스트 재현 중 어느 쪽으로 확인했는지
- §1〜§2 통과/실패 · 캡처
