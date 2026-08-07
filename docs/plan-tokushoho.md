# plan-tokushoho.md — 特定商取引法に基づく表記ページ (C2)

> STATUS: **C2** — [STATUS.md](../STATUS.md) §0.

작성: 2026-08-07 / 근거: [plan-billing.md](plan-billing.md) §7.1 · A5 env 입력 완료

> **상태: 문안 승인·구현 (2026-08-08).** `TOKUSHOHO_URL` = `https://www.kstudy101.jp/tokushoho`
> 배포 후 200 확인. `REFUND_POLICY` 는 아래 §1.1-9 와 **동일**하게 cPanel에 맞출 것.

---

## 1. 확정 표기（2026-08-08 大代表承認）

| # | 항목 | 확定文案 |
|---|---|---|
| 1 | 販売事業者 | Kstudy101（「名前で学ぶ韓国語」運営） |
| 2 | 所在地 | 請求があった場合、遅滞なく開示いたします。 |
| 3 | 電話番号 | 請求があった場合、遅滞なく開示いたします。 |
| 4 | メール | [お問い合わせフォーム](/contact) |
| 5 | 販売価格 | LINE［受講料］表示 + 7/14/30/60/101日 패키지（税込） |
| 6 | 代金以外 | 通信料はお客様負担 |
| 7 | 支払 | クレジットカード（申込時1回・自動更新なし） |
| 8 | 提供時期 | 入金後すぐ1日目、以降毎朝7時・毎夕6時（JST） |
| 9 | 返品・キャンセル | **お届け開始後の返金は承っておりません** |

## 1-old. 대표님이 채워야 할 표기 (plan-billing §7.1) — §1 로 대체됨

| 넣는 것 | 넣지 않는 것 |
|---|---|
| `tokushoho.html` (정적, `privacy.html` 과 동일 레이아웃) | Stripe Checkout 별도 확인 페이지 (폐기됨 — LINE 가격표가 최종확인) |
| `build-site.sh` PUBLIC · `set-site-url.py` TARGETS · `sitemap.xml` · `deploy.yml` 스모크 | `privacy.html` 개정 (구매 기록은 이미 §2에 있음) |
| `verify-pages` 에 `/tokushoho` 200 검사 추가 | env 값 변경 (A5·C1 완료) |

## 1. 대표님이 채워야 할 표기 (plan-billing §7.1)

아래를 **일본어 문안**으로 확정해 주시면 HTML에 그대로 넣습니다.
(법인이 아니면 **본명·자택 주소·전화**가 페이지에 공개됩니다.)

| # | 항목 | 비고 |
|---|---|---|
| 1 | **販売事業者名** (또는 運営者名) | 개인사업자면 본명 |
| 2 | **所在地** | 자택 주소 가능 |
| 3 | **電話番号** | 연락 가능한 번호 |
| 4 | **メールアドレス** | contact 폼과 동일해도 됨 |
| 5 | **販売価格** | 「各コースの料金は LINE の［受講料］メニューに表示」+ PACKAGES 요약표 |
| 6 | **商品代金以外の必要料金** | 통신료 등 |
| 7 | **支払方法・支払時期** | 신용카드 · 신청 시 |
| 8 | **役務の提供時期** | 결제 직후 1일차, 이후 매일 아침 7시(JST) |
| 9 | **返品・キャンセル** | A5 `REFUND_POLICY` 와 **동일 문구** (가격표에도 노출) |

`TOKUSHOHO_URL` 이 사이트 외 URL(예: BASE·STORES)이면 **C2 전체 scope 밖** — STATUS §C 에서 제외.

## 2. 구현 초안 (승인 후)

`contact.html` / `privacy.html` 과 같은 `page.css` · site-head 패턴.

```html
<!-- tokushoho.html — 구조만. 표기 값은 §1 확정 후 채움 -->
<h1 class="page-title">特定商取引法に基づく表記</h1>
<table class="legal-table">
  <tr><th>販売事業者</th><td><!-- §1-1 --></td></tr>
  <tr><th>所在地</th><td><!-- §1-2 --></td></tr>
  ...
</table>
```

수정 파일 (4곳 + verify):

```
신규  tokushoho.html
수정  tools/build-site.sh          PUBLIC +=
수정  tools/set-site-url.py        TARGETS +=
수정  sitemap.xml                  /tokushoho
수정  .github/workflows/deploy.yml  스모크 /tokushoho 200
수정  tools/verify-pages.mjs       (있으면) 링크·200
```

## 3. 검증

- [ ] `bash tools/build-site.sh` 후 `dist/tokushoho.html` 존재
- [ ] 관문 19종 회귀
- [ ] 배포 후 `curl -s -o /dev/null -w "%{http_code}" https://www.kstudy101.jp/tokushoho` → **200**
- [ ] LINE 가격표 「販売者の表記」 URL 과 실 페이지 일치

## 4. 제외 (scope 밖)

- Stripe 테스트 (A3) · 리치메뉴 등록 (C3) · `SALES_MODE=open` (C4)
- 가격표 문안 변경 (이미 `checkout.mjs` · `REFUND_POLICY` 로 분리)

## 5. 체크리스트

- [x] §1 표기 9항 확정 (대표 2026-08-08)
- [x] `TOKUSHOHO_URL` 이 `kstudy101.jp` 인지 확인 (대표)
- [x] 본 계획 승인
- [x] HTML + 4곳 + verify 구현
- [ ] 사이트 배포 (main push)
