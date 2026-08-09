# plan-push-cost — push 비용 절감（말풍선 통합 · 휴면 세그먼트）

작성: 2026-08-10. 상태: **초안 · 구현 전（승인 대기）**

근거 리서치: [research-push-cost](research-push-cost.md)

---

## 0. 한 줄 결론

| 아이디어 | 공식 Messaging API 과금 | 권고 |
|---|---|---|
| A. 아침 말풍선 Flex 통합 | **절감 ≈ 0%**（push 1회=수신자 1통） | UX용으로만 검토. **비용 1순위 아님** |
| B. 휴면／무반응 유저 제외 | **잔여 일수가 남은 채** 안 보는 사람에게만 추가 절감 | **이미 있는「일수 소진 정지」와 별개**. 필요성은 대표 판단 |
| F3. 하루 1 push | 활성 1인 2→1 ≈ 반 | 습관 설계 변경. 별 결정 |

### 0-a. 대표 지적（2026-08-10）— 「B는 이미 있다」

**일수로 멈추는 경로는 이미 구축되어 있습니다.** 맞습니다.

| 이미 있음 | 동작 |
|---|---|
| 체험 7일 · 구매 없음 | `days_entitled` 소진 → 아침 `日数切れ` · 저녁 대상에서도 빠짐 |
| 유료 일수 소진 | 동일（`remaining <= 0`） |
| 블록 | `unfollowed` → 배신 제외 |

계획 B가 말하는 「휴면」은 그게 **아닙니다.**  
B의 대상은 **잔여 일수가 아직 있는데**（예: 30일권 산 뒤 톡을 안 연다）  
그 잔여가 닳을 때까지 **매일 아침·저녁 push가 계속 나가는** 경우입니다.

- 체험만 쓰는 사람: 최대 약 **7일 × 2통** 이면 어차피 끝 → B의 추가 이득이 작음  
- 장기권·안 보는 유료: 잔여가 클수록 B 이득이 큼  

→ 「체험 종료／결제 일수 종료」만으로 충분하면 **B는 안 해도 됨**.  
→ 「산 일수가 남아 있는데 안 보는 사람」까지 끊고 싶을 때만 B.

대표 제안의 「말풍선 합치면 40〜50%」는 **말풍선 개수 감각**에는 맞을 수 있으나,  
LINE 월간 메시지 한도／추가 과금 단위와는 **어긋납니다**（[공식](https://developers.line.biz/en/docs/messaging-api/pricing/)）.

실제 활성 1인 과금 ≈ **아침 push 1 + 저녁 push 1 = 2통／일**.
---

## 1. 목표（대표 확인용）

1. 무료／유료 메시지 한도를 **덜 태우면서** 학습 중인 사람에게는 품질 유지
2. 「안 보는 사람」에게 아침·저녁이 계속 나가지 않게
3. 차단·일수 소진 등 **이미 있는 정지 경로**와 겹치지 않게

---

## 2. 대표께 고를 것（구현 전 필수）

### 2-1. 우선순위

| 안 | 내용 |
|---|---|
| **(B→A)** 권고 | 휴면 필터 먼저 → 효과 본 뒤 Flex는 선택 |
| (A→B) | Flex 먼저（비용 착각으로 착수하기 쉬움） |
| (B만) | Flex 보류 |

### 2-2. 「휴면」정의（하나만）

| ID | 정의 | 장점 | 단점 |
|---|---|---|---|
| **H1** | webhook（message／postback）이 **N일** 없음 | 단순·측정 가능 | 「읽기만」하는 사람도 멈춤 |
| **H2** | 저녁「こたえを見る」·퀴즈 postback 이 **N일** 없음 | 학습 반응에 가깝다 | 텍스트만 보내는 사람 오판 |
| **H3** | H1 + **잔여 일수 있음** 만 대상（체험／유료 공통） | 과금 대상만 자름 | — |
| **H4** | 이용자가 ［配信一時停止］를 누름 | 오판 0 | 자발 비율 낮음 |

권고: **H3 + N=7（또는 14）**, 재개는 **아무 message／postback 1회**.  
N 값은 대표 확정.

### 2-3. 멈춤 표현

| 안 | 동작 |
|---|---|
| **(가)** 권고 | `users.status = 'paused'`（ENUM 추가）— `listDeliverable` 에서 제외. 잔여·진도는 유지 |
| (나) | `delivery_paused_at` 열만 — status 는 trial/active 유지 |
| (다) | 배치 SQL 에만 `last_interacted_at < …` — 열 없이 서브쿼리 |

(가)가 verify-server 의 status ENUM 관문과 맞추기 쉽고, 의도도 읽힌다.

### 2-4. Flex（비용 아님 · 할 때만）

| 안 | 아침 묶음 |
|---|---|
| **F0** | 안 함（권고 기본） |
| F1 | 문법+단어 → Flex **1 object**, 운세·부적·❓는 현행（push 횟수 불변） |
| F2 | 레슨 전체+운세 → Flex carousel **1 object**, ❓만 분리 또는 Flex 버튼 |
| F3 | 아침+저녁을 **하루 1 push**로（과금 2→1）— UX·「밤 복습」약속과 충돌 |

F3만 **과금이 반**에 가깝다. 문면·습관 설계 변경이 커서 별 결정.

---

## 3. 계획 B — 휴면 세그먼트（상세）

### 3-1. 접근

1. `users.last_interacted_at`（DATETIME, NULL 허용）  
   - follow／message／postback／link callback 성공 시 `NOW()`（JST 규약에 맞춤）
2. migration: `status` ENUM 에 `'paused'` 추가（스키마·verify-server 동기）
3. `listDeliverable` / `findDeliverable`:  
   `status IN ('trial','active')` 유지 — **paused 는 제외**（가）
4. `maintain` 또는 push-daily 머리:  
   `last_interacted_at < JST_오늘 - N일` 이고 trial/active → `paused`  
   （또는 배치 직전에만 soft-skip — 대표가 (나)를 고르면）
5. 재개: `handleMessage` / `handlePostback` / `handleFollow` 입구에서  
   `paused` → 직전 status 복귀는 어려우므로 **trial/active 중 잔여로 판정**해 되돌리거나,  
   pause 전에 `status_before_pause` 를 저장（열 1개 더）
6. 안내 1통（**push 1회**, 과금 1）: 「反応がしばらくなかったので配信を一時停止しました。続きはトークに何か送ってください」  
   — **통산 1회**（push_logs 타입 신설 `pause_notice`）
7. privacy.html: 「配信停止・再開の記録」이 목적과 맞으면 **같은 커밋**에서 제2항 갱신

### 3-2. 스니펫（예정）

```js
// repo/users.mjs — DELIVERABLE_SQL
WHERE u.status IN ('trial', 'active') AND u.active_track IS NOT NULL
// paused はここに入れない

// push-daily 頭 or maintain
// last_interacted_at が NULL の新規は「フォロー日」を起点（即 pause しない）
```

```js
// handlers 共通（小さく）
await users.touchInteraction(conn, user.id);
if (user.status === "paused") await users.resumeFromPause(conn, user.id);
```

### 3-3. 수정 파일（B）

| 경로 | 내용 |
|---|---|
| `server/db/migrations/00N-pause-delivery.sql` | ENUM + `last_interacted_at`（+ 선택 `status_before_pause`） |
| `server/db/schema.sql` · `migrate.mjs` | 동기 |
| `server/lib/repo/users.mjs` | touch / pause / resume · DELIVERABLE |
| `server/lib/handlers/{message,postback,follow,link}.mjs` | touch（+ resume） |
| `server/db/push-daily.mjs` 또는 `maintain.mjs` | N일 경과 → pause + notice |
| `server/lib/repo/pushlogs.mjs` | `pause_notice` 타입 |
| `tools/verify-{server,push,webhook}.mjs` | 관문 |
| `privacy.html` | 해당 시 |

### 3-4. 트레이드오프（B）

| | |
|---|---|
| 이득 | 무반응 인원 × 2통／일이 사라짐. **비용 레버의 본체** |
| 위험 | N이 짧으면 조용히 읽는 유료 고객을 멈춤 → N=14 보수안 |
| 복잡도 | 열·ENUM·privacy·재개 경로. 007 때처럼 **단계 배포** 권장 |
| 안 하는 것 | 블록 강제, 일수 몰수, 이름 독촉 강화 |

### 3-5. 단계（B）

| # | 내용 | 비고 |
|---|---|---|
| B0 | DB 백업 | |
| B1 | 열만（`last_interacted_at`）+ touch 배선 · **pause 아직 없음** | 하루 쌓기 |
| B2 | pause 로직 + notice + 관문 | N·문면 확정 후 |
| B3 | 라이브: paused 인원·통수 감소를 LINE 消費 API／push_logs 로 확인 | |

---

## 4. 계획 A — Flex 통합（상세 · 비용 목적 아님）

### 4-1. 언제 하나

- 알림이 여러 번 울린다고 불만이 나올 때  
  （참고: **한 push의 messages[] 는 알림 1회** — 이미 본 코드 주석과 동일）
- 화면에서 스크롤을 줄이고 싶을 때
- ❓를 Flex 버튼으로 옮겨 **말미 quickReply 제약**을 풀고 싶을 때（비용 무관）

### 4-2. 접근（F1 예시）

`renderDay` 가 text 2〜3 대신 Flex bubble／carousel **1 message object** 를 반환.  
`push-daily` 의 「꼬리통을 맨 끝으로」로직을 Flex 버튼 모델에 맞게 단순화.  
관문 `verify-render` · `verify-push` 전면 갱신.

### 4-3. 트레이드오프（A）

| | |
|---|---|
| 이득 | UX·미리보기（altText）·버튼 잔존 |
| 비용 | **월간 과금 통수 거의 불변** |
| 위험 | 긴 문법／회화가 Flex 높이·접기 제한에 걸림 · 장애 면적 큼 |
| 선행 | 저녁 Flex 패턴 재사용（이미 1곳） |

---

## 5. 수치 감（과금 통 · 가정）

활성 A명, 휴면으로 빠질 후보 D명, 하루 2 push:

| | 월（30일）과금 통 |
|---|---|
| 현행 | ≈ `(A+D) × 2 × 30` |
| B만（D 제외） | ≈ `A × 2 × 30` |
| F3만（하루 1 push, D 유지） | ≈ `(A+D) × 1 × 30` |
| B+F3 | ≈ `A × 1 × 30` |

말풍선 Flex만: ≈ **현행과 동일**.

---

## 6. 제외（scope 밖）

- 체험 7일 일수 자체 변경（별건 §0-◆）
- 가격표／C4 open
- multicast／narrowcast 로의 일괄 전환（지금 1:1 push + retryKey 설계와 충돌）
- OA Manager 「メッセージ配信」UI 방송（API 경로와 이중화）
- 읽음 여부 추적（LINE이 개인 읽음을 API로 안 줌）

---

## 7. 승인 체크리스트

구현 들어가기 전 대표 답:

- [ ] 우선순위: **B→A / B만 / A→B**
- [ ] 휴면 정의: **H1〜H4** + **N= ? 일**
- [ ] 멈춤 표현: **(가) paused / (나) 열 / (다) SQL만**
- [ ] pause 안내 push: **보낸다 / 안 보낸다**
- [ ] Flex: **F0 / F1 / F2 / F3**
- [ ] privacy 갱신 범위 동의

---

## 8. 구현 체크（승인 후）

- [ ] research 전제（과금=수신자）를 STATUS 30초 요약에 한 줄
- [ ] B1 → B2 → B3
- [ ] 관문 녹·라이브 消費 확인
- [ ] （선택）A 착수
