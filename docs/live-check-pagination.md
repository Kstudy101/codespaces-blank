# 라이브 검증 지시서 — 다중 이용자 페이지네이션 (E4)

> STATUS: **E4** — [STATUS.md](../STATUS.md) §0.
> 코드·관문 통과. **배신 대상 500명 초과** 시 전원 수신 확인.

작성: 2026-08-08 / 근거: [push-daily.mjs](../server/db/push-daily.mjs) · [users.mjs](../server/lib/repo/users.mjs)

## 배경

`listDeliverable` 기본 `LIMIT 500`. `push-daily.mjs` 는 `PAGE=200` 으로 offset 페이지네이션하여 **501人目以降も配る** 構造（`findDeliverable` は 1人専用で 501 人目問題を避ける）。

관문·smoke は 가짜 conn 으로 SQL 을 검증. **500명超の実人数** は本番条件。

## 전제

- 배신 대상(`listDeliverable`) **501명以上**
- cron morning/evening 정상 (`crontab -l` 3행)
- 특정 `--user` / `--limit` 없이 본番 배치

## §1. 배치 로그

| # | 확인 | 기대 |
|---|---|---|
| 1 | `push-daily.mjs` stdout | `対象 N 人` 에 **N ≥ 501** |
| 2 | exit code | `0`（`送信失敗` 0） |
| 3 | `~/logs/` | morning cron 오류 없음 |

## §2. 수신 (표본)

| # | 방법 | 기대 |
|---|---|---|
| 1 | **501番目以降**の利用者を 2〜3 名特定（`ORDER BY u.id` の後ろ） | 当該朝の本編が届く |
| 2 | id が PAGE 境界付近（200, 400, 501） | いずれも届く |

```sql
-- 501人目付近の id（例）
SELECT u.id FROM users u
  JOIN … -- listDeliverable と同条件
 ORDER BY u.id LIMIT 1 OFFSET 500;
```

（実際は `db/who.mjs` や phpMyAdmin で末尾 id を確認）

## §3. 실패 패턴（出たら bug）

- 501人目以降だけ毎朝届かない
- ログの `対象` が 500 で頭打ち

## §4. 500人未満のとき

**本検証は保留**で可。コード上のページネーションは verify-push / smoke で担保済。

## §5. 보고

- 対象人数 N · 確認した user id（501以降）
- §1〜§2 通過/失敗
