# 라이브 검증 지시서 (개정판) — LINE 직접 유입 온보딩 + 코스 선택

> STATUS: **A2** — [STATUS.md](../STATUS.md) §0.
> **완료 (2026-08-07 대표 확인).** SALES_MODE 미설정 상태에서 10〜11단계 정상.

대상: 대표님 실행용 · 구판(§4 라이브 지시서) 교체본 · 2026-08-06

## 0. 개정 이유 두 가지

**① 원본의 SQL 순서가 위험했습니다.** 주석은 「먼저 SELECT 하라」인데
코드는 지운 다음 SELECT 로 되어 있었습니다. 순서 그대로 실행하면 백업이
빈 결과를 돌려주고 복구할 값이 사라집니다. **스냅샷을 §1 로 분리**했습니다.

**② 원본은 §2(코스 선택 흐름) 이전 버전입니다.** 마지막이 「受講料 유도」로
끝나는데, 그건 지금 고치고 있는 막다른 곳입니다. 코스 선택 → 즉시 1일차까지
**한 번의 왕복으로 검증**하도록 확장했습니다.

## 실행 전제

- **§2(코스 선택 흐름)와 문면 2건이 배포된 다음** 실행할 것.
  그전에 돌리면 10단계 이하가 전부 없습니다.
- A단계 원고(중급·상급 3일치 + `fortune-lines.json`) 배치 완료 후가
  바람직합니다 — 코스 선택지가 제대로 걸러지는지 함께 볼 수 있습니다.
- **모든 조작은 테스트 계정 1개로만.**

---

## §1. 스냅샷 — 반드시 여기부터 ★

**아래 SELECT 결과를 전부 복사해 안전한 곳에 붙여넣기 전에는 §2 로
내려가지 마십시오.**

```sql
SELECT * FROM users              WHERE id      = <ID>;
SELECT * FROM saju_profiles      WHERE user_id = <ID>;
SELECT * FROM learning_progress  WHERE user_id = <ID>;
SELECT * FROM course_entitlements WHERE user_id = <ID>;
SELECT * FROM subscriptions      WHERE user_id = <ID>;
```

원본은 `users`·`saju_profiles` 두 개만 봤는데, **코스 선택·체험이 붙으면서
진도·수강권·체험 기록까지 바뀝니다.** 다섯 개를 전부 떠야 되돌릴 수
있습니다.

## §2. 초기화 — 문장마다 영향 행수를 눈으로 확인

```sql
UPDATE users SET name_kanji=NULL, name_reading=NULL, name_kr=NULL,
                 name_source=NULL, active_track=NULL
 WHERE id = <ID>;
DELETE FROM saju_profiles       WHERE user_id = <ID>;
DELETE FROM learning_progress   WHERE user_id = <ID>;
DELETE FROM course_entitlements WHERE user_id = <ID>;
DELETE FROM subscriptions       WHERE user_id = <ID>;
```

- `active_track=NULL` 이 필요합니다 — 코스 선택 단계가 「`active_track` 이
  비어 있는가」로 판정하기 때문입니다.
- `subscriptions` 삭제는 **체험을 다시 쓸 수 있게** 하기 위함입니다
  (계정당 1회 제약 해제).
- **각 문장 실행 후 「1 row affected」인지 확인**할 것. WHERE 실수가 한 번
  어긋나면 전원이 지워집니다.

---

## §3. 체인 왕복 (LINE 토크)

| # | 조작 | 기대 |
|---|---|---|
| 1 | 아무 텍스트 1통 (예 「はじめ」) | 읽기(かな) 요청 |
| 2 | かな 1행 (예 タロウ) | 「타로 で OK?」 |
| 3 | 「はい」 | **생년월일 picker** |
| 4 | 날짜 선택 | **시간 picker + 「わからない」** |
| 5 | **「わからない」** | **국가 2택**(日本/韓国) |
| 6 | 「日本」 | 도시 quickReply |
| 7 | 도시 탭 | **성별 3택** |
| 8 | **「答えない」** | **요약 확인** — 5항목이 한 화면에 |
| 9 | **「直したい」** → 시간 | 시간 picker 재출현 → 답하면 **요약으로 복귀** |
| 10 | **「これで始めます」** | **코스 선택**(초급/중급/상급) |
| 11 | 코스 탭 | **개시 안내 + 그 자리에서 1일차** |

### 10단계에서 볼 것

- **선택지가 원고 보유 상황과 일치하는가** — 원고가 3일 미만인 코스는
  나오면 안 됩니다.
- **코스 변경 불가 안내**가 선택 화면에 있는가(고른 뒤가 아니라
  **고르기 전**에).

### 11단계에서 볼 것 — 여기가 이번 검증의 핵심

| 확인 | 기대 |
|---|---|
| 개시 안내 문면 | 「このあとすぐ 1 日目」+ 아침 7시·저녁 6시 리듬 + 마무리 인사 |
| **1일차가 즉시 오는가** | 본문 2통 + 운세 1통 |
| **「あと 2 日です」가 붙지 않는가** | ← 체험 시작 통에 기한 예고가 붙으면 **실패**. 기한 예고 억제([plan-course-onboarding §5](plan-course-onboarding.md))가 작동하는지 |
| 통수 | 개시 안내 1 + 본문 2 + 운세 1 = **4통 이내** |
| 운세 내용 | `fortune-lines.json` 의 문면이 한·일 병기로 나오는가 |

### ★ 판매 게이트와 무관함을 함께 증명

**`SALES_MODE` 를 설정하지 않은 채로(=`closed`) 이 검증을 돌리십시오.**
그 상태에서 10~11 이 정상 동작하면, **「Stripe 가 닫혀 있어도 강좌를
시작할 수 있다」**가 실측으로 증명됩니다. 이번 변경의 최대 이득이 바로
이것입니다.

---

## §4. DB 실측 (11단계 직후)

```sql
SELECT name_kr, name_source, active_track, status FROM users WHERE id = <ID>;
SELECT birth_date, birth_time, gender, birth_confirmed, ohaeng_main,
       JSON_EXTRACT(raw_result_json, '$.city') AS city
  FROM saju_profiles WHERE user_id = <ID>;
SELECT track, current_day, days_used FROM learning_progress   WHERE user_id = <ID>;
SELECT track, days_entitled          FROM course_entitlements WHERE user_id = <ID>;
```

| 열 | 기대 |
|---|---|
| `name_kr` | 입력한 かな의 한글 표기 |
| `birth_time` | **NULL**(「わからない」를 골랐으므로) |
| `city` | 고른 도시 id |
| `gender` | **`U`**(「答えない」) |
| `birth_confirmed` | **1**(요약 확인 완료) |
| **`ohaeng_main`** | **NULL** ← 판별자 불변식. 요약 확인 후에도 비어 있어야 함 |
| `current_day` / `days_used` | **1 / 1**(즉시 1일차를 받았으므로) |
| `days_entitled` | **3**(체험) |

## §5. 중단 복구 (개선된 별도 확인)

4단계쯤에서 **답하지 않고 방치**한 뒤, 다음 중 하나로 **그 단계부터**
재개되는지:

- 아무 버튼·텍스트를 보냄(접점 복구)
- 「設定」·「名前」 등 키워드(키워드 복구)
- 다음 아침 배치(배치 복구)

**틀린 단계로 되돌아가거나 처음부터 다시 물으면 실패**입니다.

## §6. 다음날 저녁 — 2일차 결제 유도

시점이 다르므로 따로 확인합니다.

- **D+1 아침 7시** → 2일차 도착
- **D+1 저녁 6시** → 복습 2통 + **결제 유도 1통**

| 확인 | 기대 |
|---|---|
| 문면 분기 | `SALES_MODE=closed` 이면 **문면 B**(버튼 없음·「準備中」). 열려 있고 살 수 있는 패키지가 있으면 **문면 A**(버튼 있음) |
| 1회만 | D+2 저녁에는 오지 않아야 함 |
| 일수 미소비 | 저녁 유도로 `days_used` 불변 |

## §7. 원상복구

§1 의 스냅샷 값으로 복원합니다. `users` 는 UPDATE, 나머지 넷은 행째
지웠으므로 **INSERT 로 되돌립니다.** 복원 후 §1 과 같은 SELECT 를 다시
돌려 **스냅샷과 일치하는지 눈으로 대조**할 것.

복원이 어려우면 사이트 재진단 → 재연동으로도 유사 상태를 만들 수
있습니다(단 그 경우 `id` 이외의 값은 새로 생성됩니다).

## §8. 보고

- §3 각 단계 통과/실패 · 실패 시 화면 캡처와 그 시점 SELECT
- §3 의 11단계 5개 확인 항목(특히 **기한 예고 미부착**)
- §4 실측표 · §5 중단 복구 3경로 중 확인한 것
- §6 결과(다음날) · §7 복원 대조 결과
- `SALES_MODE` 미설정 상태에서 코스 선택이 동작했는지 — **명시적으로 적을 것**
