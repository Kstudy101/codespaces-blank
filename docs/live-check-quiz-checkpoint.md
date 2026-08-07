# 라이브 검증 지시서 — 절목 퀴즈 (E2)

> STATUS: **E2** — [STATUS.md](../STATUS.md) §0.
> 코드·관문 통과 (2026-08-05). **30/50/75일 `quiz` 입고** 후 30·50·75일차 아침에 확인.

작성: 2026-08-08 / 근거: [plan-quiz-checkpoint.md](plan-quiz-checkpoint.md)

## 전제

- 절목 발신·채점·답장 코드 배포 완료
- 3코스 × 30/50/75 = **9문** `quiz` — 로컬 `seed-content.mjs --check` ✓
- 서버 DB 반영: D1c 경로 (E1과 동일 배포)
- 해당 일차에 도달한 테스트/실계정 필요 (30일차 = 수강 29일 후 아침)

## §1. 발송 (30·50·75일 아침)

| # | 확인 | 기대 |
|---|---|---|
| 1 | 본편 2 + 운세 1 **뒤** | `🎯 節目クイズ（N日目）` 1통 |
| 2 | quickReply | `action=quiz&day=N&choice=i` |
| 3 | 같은 아침 복습 퀴즈 | **없음** (`action=review` 없음) |
| 4 | `tpl.quiz` 없는 절목일 | 퀴즈 없이 본편만 (현재 9문 입고로 해당 없음) |
| 5 | `push_logs` | 송신 성공 시 `push_type='quiz'` 1건 |

## §2. 채점·답장

| # | 조작 | 기대 |
|---|---|---|
| 1 | 정답 선택 | `⭕` + 「N学期 修了！」(semester에 맞는 문구) |
| 2 | 오답 선택 | `❌` + 정답 표시 |
| 3 | 비절목일 `day` 변조 | skipped, reply 없음 |

## §3. DB (채점 직후)

```sql
SELECT quiz_pass_log FROM learning_progress
 WHERE user_id = <ID> AND track = '<track>';
```

합격 시 해당 semester 키가 `true`. 불합격 시 `false` 또는 키 없음.

## §4. 기한예고와 겹치는 아침 (드묾)

잔여 2일 + 절목일이 겹치면 아침 **5통** (본편2+운세+예고+절목퀴즈). LINE 상한 5 — **초과 없음** 확인.

## §5. 보고

- 코스별 30/50/75 중 확인한 일차
- §1〜§4 통과/실패 · `quiz_pass_log` 스크린샷
- 서버 seed 후 9문 반영 확인
