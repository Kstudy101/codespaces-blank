# plan-accel-day — 配信の加速試験

작성: 2026-08-10. 상태: **구현**（대표 승인）

## 목적
실시계로 7일·30일을 기다리지 않고, 테스트 계정 1명에 대해  
**체험 7일（＋6일 저녁 권유）** 과 **30일 절목 퀴즈**까지 연속 확인.

## 사용

```bash
# 下見（LINE に送らない。朝の文面だけ 1〜30）
node db/with-env.mjs db/accel-day.mjs --user=<ID> --to=30 \
  --reset-to=0 --ensure-entitled=30

# 実送信（テスト LINE のみ）
node db/with-env.mjs db/accel-day.mjs --user=<ID> --to=30 \
  --reset-to=0 --ensure-entitled=30 --send
```

体験 7 日＋勧誘だけなら `--to=7 --send`。

## 付随修正
| 파일 | 内容 |
|---|---|
| `push-daily.mjs` / `push-evening.mjs` | `push_logs.sent_at` を `--date` の 07:00 / 18:00 に揃える（夕が朝を見つける） |
| `push-evening.mjs` | `--user=`（1 人道） |
| `pushlogs.logFailed` | `sentAt` オプション |

## 注意
- **本番ユーザーに --send しない**
- dry-run 時は夕スキップ（ログが無い）
- `--ensure-entitled` は `grant`（買いの偽物行は作らない）
- 無料通数を一気に消費する（--send 時）

## 除外
- verify 新関門（手元ツール）
- cron 変更
