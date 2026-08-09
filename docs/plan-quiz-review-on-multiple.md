# plan-quiz-review-on-multiple — 3의 배수 아침은 🔁만 (A안)

작성: 2026-08-10. 상태: **승인 · 구현**

## 배경
가속 시험에서 3일차에 `🔁 ふくしゅうクイズ`가 안 나옴.
원인: 신양식 데일리 ❓(`quizTail`)가 있으면 복습 뽑기를 쉬는 ㉑ 규칙.
대표 승인 **A안** — 3의 배수 아침엔 데일리 ❓를 접고 `🔁`만 (퀴즈 1통 유지).

## 접근
`quizSection` 판정에「오늘은 복습 아침인가」를 넣는다.

```js
const reviewMorning = next % 3 === 0 && !atCheckpoint && !warned;
let messages = renderDay(tpl, u, {
  quizSection: !atCheckpoint && !warned && !reviewMorning
});
// 이후 기존: !quizTail 이면 pickReviewQuiz → renderReviewQuiz
```

| 아침 | 데일리 ❓ | 🔁 | 🎯 |
|---|---|---|---|
| 평일 | ○ | — | — |
| 3·6·9… | — | ○ | — |
| 30/50/75 | — | — | ○ |
| 기한예고 | — | — | (절목이면 ○) |

## 수정 파일
| 경로 | 내용 |
|---|---|
| `server/db/push-daily.mjs` | `quizSection` + 주석 |
| `tools/verify-push.mjs` | 신양식 평일=❓ / 3배수=🔁 관문 분리 |
| `docs/plan-newformat.md` | §1-2 한 줄 정정（참조） |
| `STATUS.md` | 한 줄 |

## 트레이드오프
- 3의 배수엔「오늘 문법」❓가 안 나가고 과거 풀 1문이 나감（원래 복습 약속）.
- 절목·예고 규칙은 불변. 퀴즈 2건 금지도 유지.

## 제외
- 재송신（장애 회수）경로의 quizSection
- 웰컴 문구
- 30일 절목 원고 보강（별건 — 서버 `quiz` 유무 확인）

## 체크리스트
- [x] `push-daily` A안
- [x] `verify-push` / `verify-quiz`
- [x] STATUS · plan-newformat 정정
