# 라이브 검증·판단 지시서 — 실판매 모드 (C4)

> STATUS: **C4 보류** — [STATUS.md](../STATUS.md) §C·§F.
> **선행:** A3 ✓ · C2 `/tokushoho` ✓ · C3 리치メニュー ✓
> **2026-08-08:** 체험 3일·무결제 차단 확인 후 `SALES_MODE=open` **진행 보류**.

## 판단

| 조건 | 확인 |
|---|---|
| A3 통과 | [plan-journey.md](plan-journey.md) §4 체크리스트 전부 |
| `TOKUSHOHO_URL` | `https://www.kstudy101.jp/tokushoho` → **200** |
| `REFUND_POLICY` | tokushoho §返品·キャンセル 과 **동일 문구** |
| C3 | LINE 토ーク 하단에 리치메뉴 4칸 표시 |

## cPanel 환경변수 (대표)

1. `SALES_MODE` = **`test`** 유지 — A3 완료까지
2. A3 완료 후 **`open`** 으로 변경
3. Node.js 앱 **Restart**

## A3 통과 후 smoke (선택)

```bash
# cPanel Terminal
bash ~/kstudy101-line/db/run.sh db/smoke.mjs
```

## 실판매 전 최종 확인

- [ ] 테스트 계정이 아닌 일반 계정에서 ［受講料］→ 가격표 표시
- [ ] Stripe Checkout → 테스트/본番 카드 정책 확인
- [ ] webhook → `creditPurchase` → 1일차 즉시 배송

## 되돌리기

문제 발생 시 `SALES_MODE=closed` 로 즉시 되돌리고 Restart.
