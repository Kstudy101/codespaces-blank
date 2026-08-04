# research-quiz.md — 「3일 주기 누적 무작위 퀴즈」 지시서 검토

작성: 2026-08-04 / 대상: 대표님 지시서 (3일 주기 누적 무작위 퀴즈 발신) / 기준 커밋: `0743a34`

> 결론: **지시서 그대로는 구현에 들어갈 수 없습니다.** 막는 것은 두 가지 —
> ① 무작위로 뽑을 퀴즈 원고가 DB 에 한 건도 없고, 담을 열조차 없다
> ② 기존 수신부(postback)가 30/50/75 절목 전용으로 만들어져 있어, 3일 주기
> 퀴즈의 응답을 **조용히 버린다**
> 아래 결정 3건이 정해지면 계획서를 쓸 수 있습니다.

---

## 1. 치명 — 퀴즈 원고가 존재하지 않습니다

지시서 Step 1 은 「조건 만족 퀴즈를 무작위 추출」을 전제하지만, 뽑을 대상이 없습니다.

`content_templates` 의 실제 열 (schema.sql):

```
day_number / semester / grammar_point / grammar_tip_kr /
dialogue_template / vocab_3 / requires_name_slot / updated_at (+ 001 이 track 추가)
```

**quiz 열이 없습니다.** [postback.mjs](../server/lib/handlers/postback.mjs) 의 채점부는
`tpl.quiz.answer` 를 읽으려 하지만, 그 밑에 이렇게 적혀 있습니다:

> 正答の置き場所は P4 の入稿設計で決まる（content_templates のどこに持たせるか）。
> **決まるまでは null を返し**、「採点できない」を呼ぶ側に伝える。

즉 절목 퀴즈(기존 설계)조차 지금은 채점 불능이고, `seed-content.mjs` 도 quiz 를
다루지 않습니다. **어느 설계로 가든 퀴즈 원고의 형식 확정과 입고가 선행입니다.**

## 2. 치명 — 기존 수신부와 정면 충돌

지시서 요구사항 5 「postback.mjs 및 setQuizResult 와 정상 연동될 것」은
현재 코드로는 성립하지 않습니다. 세 겹으로 어긋납니다.

**① 절목이 아니면 채점을 거부합니다** — [postback.mjs](../server/lib/handlers/postback.mjs):

```js
if (!(await learning.isCheckpoint(conn, day))) {
  return { skipped: `${day} 日目は節目ではありません`, ... };
}
```

`quiz_checkpoints` 는 30/50/75 세 줄이고, `migrate.mjs` 는 그 세 값이 아니면
스키마 검증을 **실패**시킵니다. 3·6·9…일차 퀴즈의 답은 여기서 조용히 버려집니다.
이 방어는 실수가 아니라 설계입니다 — postback data 는 이용자 단말을 거쳐 돌아오므로
변조 가능하고, 「30일차 퀴즈라고 자칭해도 우리 표로 확인한다」가 원칙입니다.
느슨하게 풀면 이 방어가 무너집니다.

**② 저장 구조가 학기 단위입니다** — `setQuizResult(conn, uid, track, semester, passed)` 는
`quiz_pass_log` 에 `{"semester1": true}` 형태로 넣습니다. 3일 주기 결과를 여기에
넣으면 **9일차 복습 퀴즈의 오답이 semester1 절목 합불 기록을 덮어씁니다.**
학기 합불은 수료 판정 재료라, 이건 「동작은 하는데 조용히 틀리는」 종류입니다.

**③ 30일차가 겹칩니다** — 30 % 3 = 0. 절목 퀴즈가 구현되는 날, 같은 날에 퀴즈가
두 건 나가고 둘 다 `action=quiz&day=…` 로 돌아와 채점이 뒤섞입니다.

## 3. 경미 — 지시서의 사실 오류

| 지시서 | 실제 |
|---|---|
| `src/push-daily.mjs` | [server/db/push-daily.mjs](../server/db/push-daily.mjs) |
| `src/handlers/postback.mjs` | [server/lib/handlers/postback.mjs](../server/lib/handlers/postback.mjs) |
| 「DB ENUM 업데이트 흐름」 | 불필요 — `push_type` ENUM 에 `'quiz'` 는 001 부터 이미 있음 |
| Flex Message 카드 | 코드베이스 전체가 **text + quickReply(postback)** 뿐. Flex 는 새 형식 도입이고 `verify-render`·`verify-push` 관문도 같이 손대야 함 |
| `current_day % 3 === 0` | `current_day` 는 「몇 일차**까지 보냈나**」(0~101). 오늘 보내는 것은 +1일차. 트리거는 **「오늘 보내는 일차 % 3」** 으로 명시해야 하루 어긋나지 않음 |

`ORDER BY RAND()` 자체는 문제없습니다 — 표가 코스당 최대 101행이라 비용이 없고,
`repo/` 규약(`conn.execute` 만)에도 어긋나지 않습니다. 단, 관문(가짜 conn)에서
검증 가능하도록 무작위 선택은 주입 가능한 형태로 두는 편이 좋습니다.

## 4. 저장 정책 — 이 저장소의 결정사항과의 접점

3일 주기 퀴즈의 결과를 **새로 저장**한다면:

- 저장 항목 추가 → `privacy.html` 제2항을 같은 커밋에서 (핵심 규칙, 어긋난 전례 4회)
- 「導けるものを保存しない」(onboarding.mjs 의 결정) 와의 정합

**권장: 복습 퀴즈는 저장하지 않습니다.** 그 자리에서 정답/오답을 답장으로 알려주고
끝. 절목(30/50/75)만 `quiz_pass_log` 에 남기는 현행 구조를 유지하면 폴리시도
수료 판정도 건드리지 않고, ②의 덮어쓰기 문제도 원천 차단됩니다.

## 5. 결정 필요 — 3건

**결정 ① — 설계 노선**

| | 내용 | 비고 |
|---|---|---|
| (가) | 지시서대로 3일 주기 복습 퀴즈만 | 새 postback action (예: `action=review&day=X&choice=n`) 신설. 절목 채점 경로와 분리 → §2 충돌 전부 회피 |
| (나) | 기존 30/50/75 절목 설계를 먼저 완성 | 수신부는 이미 있음. 그러나 첫 효용이 30일차 — 한 달 뒤 |
| (다) | 둘 다 | (가)+(나). 30일차 중복 규칙 필요 — 권장: 절목일에는 복습 퀴즈를 쉼 |

어느 쪽이든 **새 action 이름으로 분리**하는 것이 §2 의 방어 설계를 지키는 길입니다.
`day` 를 data 에 실어 보내고 채점은 서버가 그 날짜의 원고에서 — 정답을 data 에
싣지 않는 원칙은 그대로.

**결정 ② — 퀴즈 원고의 형식과 입고**

제안: `content_templates` 에 `quiz JSON NULL` 열 추가 —
`{ "question": "...", "choices": ["...","...","..."], "answer": 2 }`.
`answer` 는 서버에서만 읽습니다. 마이그레이션 003 + `seed-content.mjs` 검사 추가 +
초급 50일치 백필(원고 작업). **양은 대표님이 정합니다** — 전 일차에 넣을지,
우선 절목 3일 + 최근 일차만 넣을지.

**결정 ③ — 메시지 형식**

기존 text + quickReply 재사용(제안) vs Flex 카드 신규 도입.
quickReply 는 이미 온보딩·결제가 쓰는 형식이라 관문·렌더러 변경이 최소입니다.
Flex 는 보기엔 좋지만 이 저장소 최초 도입이라 diff 가 큽니다.

## 6. 지시서의 좋은 점 (그대로 계획에 반영할 것)

- **범위 한정 `day_number <= 오늘 보내는 일차`** — 미학습 노출 방지. 맞는 요구이고 반드시 지킵니다
- **Graceful Fallback** — 퀴즈가 없어도 본편 배신은 나간다. 운세(`fortune-lines.json` 없으면 조용히 빠짐)와 같은 패턴으로, 이 저장소의 기존 방식과 일치합니다
- **검증 4항목** — 그대로 관문(`tools/verify-quiz.mjs` 신설)의 시나리오가 됩니다. DB 없이 가짜 conn 으로

## 7. 다음 순서

결정 ①②③ 이 정해지면 → `docs/plan-quiz.md` 작성 (코드 스니펫·파일 경로·트레이드오프 포함)
→ 대표님 주석 → 승인 후 구현.
