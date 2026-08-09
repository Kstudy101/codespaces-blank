# plan-preview-day — 시드 직후 레슨 문면 즉시 확인

작성: 2026-08-09. 상태: **구현**

## 목적
아침 배치를 기다리지 않고, 시드된（또는 로컬 JSON）Day N 문면을 **터미널에 그대로** 본다.

## 격리（다른 시스템에 안 감）
| 하지 않음 | |
|---|---|
| LINE 송신 | |
| `advanceDay` / `days_used` | |
| `push_logs` 기록 | |
| HTTP 엔드포인트 | |
| cron / app.mjs 변경 | |

## 사용
```bash
# 서버（시드 후 DB）
bash db/run.sh db/preview-day.mjs --track=beginner --day=2

# 로컬 JSON（DB 없이）
node server/db/preview-day.mjs --file=server/content/beginner-01-15.json --day=2
```
