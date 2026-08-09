# research-push-cost — LINE push 비용과 본 저장소의 실제 단위

작성: 2026-08-10. 상태: **리서치**（구현 전）

관련: [plan-push-cost](plan-push-cost.md) · STATUS §0（체험 7일 LINE 통수 메모）

---

## 1. LINE 이 세는 것（공식）

[Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/):

> The number of messages is counted by **the number of people** you send a
> message to. … **The number of message objects in a request doesn't affect**
> the number of messages sent.

| 송신 | 월간 통수에 잡힘 |
|---|---|
| `push` / multicast / broadcast / narrowcast | **예** |
| `reply`（webhook 응답） | **아니오** |

1명에게 push 1회（messages 배열에 text 5개）→ **과금 1통**.  
Flex 1개로 합쳐도 → **여전히 과금 1통**.

일본 플랜 예（공식 페이지）: Light 5,000 / Standard 30,000 무료, 초과는 플랜별 단가.

---

## 2. 이 시스템이 하루 몇 「과금 통」을 쓰나

코드: `pushMessage` = push（과금）. `replyMessage` = reply（비과금）.

| 시각 | 경로 | push 횟수／인 | 말풍선（UX） |
|---|---|---|---|
| 아침 | `push-daily` | **1** | 신양식 보통 3〜5（문법·단어·운세·부적·❓） |
| 저녁 | `push-evening` | **1** | 보통 1（Flex ふりかえり）, 체험 권유일 +1 |
| 이벤트 | link / checkout / trial 직후 등 | 수시 | — |
| 친구추가 웰컴 | `reply` | **0** | 2 |

**활성 학습자 1인 · 평일 기준 ≈ 과금 2통／일**（아침+저녁）.  
말풍선 5개를 Flex 1개로 합쳐도 **과금은 2통 그대로**.

체험 7일 × 2 = **약 14 과금통／인**（STATUS ◆-4 의 「14통」은 이 의미에 가깝고,  
「말풍선 합산」으로 읽으면 과대）.

---

## 3. 배신 대상이 누구인가（지금）

`users.listDeliverable`（`repo/users.mjs`）:

```sql
WHERE u.status IN ('trial', 'active') AND u.active_track IS NOT NULL
  + progress / entitlements JOIN（잔여 일수 있는 코스）
```

- **블록** → unfollow → `unfollowed` → 다음날부터 제외（이미 있음）
- **일수 소진** → remaining 으로 아침이 「日数切れ」
- **이름 미등록** → 안내 최대 2회 후 침묵（진행 정지）
- **휴면（말 없음·퀴즈 안 품）이어도 status 가 trial/active 면 매일 아침·저녁 push**

→ 「반응이 없는 사람에게 정기 push」를 끊는 세그먼트는 **아직 없음**.

상호작용 시각을 담는 열도 없음. 휴면 판정하려면  
`last_interacted_at`（또는 push_logs + postback 집계）신설이 필요하다.

---

## 4. 말풍선 통합（Flex）의 실익

| 기대 | 공식 과금 기준 |
|---|---|
| 「3〜5 → 2〜3 말풍선으로 40〜50% 절감」 | **과금 통수에는 거의 안 먹힘**（이미 push 1회=1통） |
| 알림 1번·화면 밀도 | UX 이득은 있음 |
| ❓ quickReply 는 **묶음 마지막 message object** 에서만 열림 | Flex 안에 버튼을 넣으면（저녁과 같이）말미 제약에서 해방 가능 — 이건 비용이 아니라 **조립 자유도** |

저녁은 이미 Flex 1통（`renderReviewQuestion`）. 아침만 text 다단.

---

## 5. 진짜로 과금을 줄이는 레버

1. **수신자 수 × push 일수** 줄이기（휴면 제외·일시정지）
2. **저녁 push 생략**（세그먼트별）→ 1인당 2→1
3. 이벤트 push 최소화（이미 드묾）
4. reply 경로 유지（웰컴·퀴즈 채점은 이미 reply）

---

## 6. 출처

- LINE Developers: [Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/)
- 본 저장소: `server/lib/line.mjs`, `db/push-daily.mjs`, `db/push-evening.mjs`, `lib/repo/users.mjs` `DELIVERABLE_SQL`, `lib/render.mjs` `renderDay`
