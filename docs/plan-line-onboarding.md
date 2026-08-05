# plan-line-onboarding.md — LINE 직접 유입: 대화창에서 전 항목 수집 (지시서 §5)

작성: 2026-08-05 / **갱신: 2026-08-05 대표 지시(문면 확정+계획서 갱신 지시서 §2) 반영** /
근거: 지시서 정정 1·2 + [research-onboarding-gap.md](research-onboarding-gap.md)

> **상태: 조건부 승인 (2026-08-05 리뷰) — 수정 5건 반영 완료, 착수 가능(재승인 불요).**
> **배포 게이트: privacy 제2항 게시가 코드 배포보다 먼저** (성별 수집 시작 시점).
> 반영된 대표 결정: 2-1 (가) / 2-2 요약 확인·birth 재사용 / 2-4 (A) 권고 /
> 리뷰 수정 1~5 (아래 각 절에 표시).

---

## 0. 무엇이 바뀌나

지금: 사이트 진단을 거치지 않고 친구추가만 한 이용자는 **이름도 사주도 없어**
배신이 시작될 수 없고, 이름은 push-daily 의 안내(2회 후 침묵)가, 사주는 아무도
묻지 않습니다. 사실상 사이트 왕복이 필수.

후: 이름·생년월일·출생시간·출생지·성별 5항목을 **대화창에서 직접** 수집.
사이트 경유자는 이미 있는 값은 건너뜀 (판정은 값의 유무 — §0.5).

## 1. 수집 방법 (지시서 표 + 정정 반영)

| 항목 | 방법 | 구현 메모 |
|---|---|---|
| 이름 | かな 1행 텍스트 → 서버 변환 → 「〇〇 で OK?」 | **기존 `askReading`·`confirmName`·`kanaNameToHangul` 재사용.** 신설 없음 |
| 생년월일 | LINE `datetimepicker` (mode=date) | `initial/min/max` = 1930-01-01~2030-12-31 (절기표 범위). postback `params.date` 수신. 정규화 벗어난 값은 서버에서 재검증·거부 |
| 출생시간 | `datetimepicker` (mode=time) + 「わからない」 버튼 | 모름 → `birth_time = NULL` → 엔진이 시주 제외 3주로 계산 (**기존 지원 실측**: askBirth 문면 「時刻は未入力（時柱なしで占います）」) |
| 출생지 | **2단계 quickReply**: ①한국/일본 → ②도시 | 정정 1: 위경도 아님. `CITIES` 17개(한 7·일 10) > quickReply 13개 제한이라 2단계 필수. 저장은 `raw_result_json.city` 에 도시 id (fortune.mjs 가 읽는 곳 그대로) |
| 성별 | quickReply 3택 (男/女/回答しない) | 정정 2: `gender ENUM('M','F','U')` 열 기존. **이번엔 저장만** — 대운 계산 반영은 대표 미결(§4 보류 중) |

**[리뷰 수정 1] CITIES 사본을 만들지 않습니다.** `saju.js:297` 이 공개 API 로
`Saju.CITIES` 를 이미 내보내고, [fortune.mjs](../server/lib/fortune.mjs) 가 `node:vm` 으로
saju.js 를 통째 로드 중입니다. **기존 vm 로드에서 꺼내 쓰는 접근자 1개**
(`fortune.mjs` 에 `export function cities() { return load().Saju.CITIES; }`)로
충분 — 사본·패리티 관문·CLAUDE.md 예외 2호 전부 불필요, 사본 금지 원칙이
그대로 지켜집니다.

## 2. 상태 기계 설계 (지시서 필수 항목)

### STEPS 확장 (대표 결정 2-1·2-2 반영판)

```js
STEPS = ["name", "birth_date", "birth_time", "birth_place", "gender", "birth"]
//        기존      신설         신설           신설          신설      기존 재사용(요약 확인)
```

- **단계를 DB 열로 저장하지 않음** — 전부 값의 유무에서 도출. `gender_asked`
  류의 열은 만들지 않습니다(결정 2-1). 「모름/무회답」과 「미질문」의 구별은
  **뒤 항목이 채워졌는가**로:

```js
PENDING = {
  name:        (u) => !u.name_kr,                    /* §0.5: name_kr 존재가 유일 판정 */
  birth_date:  (u) => !u.birth_date,
  /* time: 뒤 항목(출생지)이 차 있으면 「물었고 わからない(NULL)」다.
     비어 있으면 아직 안 물었다. [리뷰 수정 3] 삼항 없이 ──
     둘 다 참인 구간은 STEPS 배열 순서(find 가 앞을 집음)가 해결한다. */
  birth_time:  (u) => !!u.birth_date && u.birth_time === null && !cityOf(u),
  birth_place: (u) => !!u.birth_date && !cityOf(u),
  gender:      (u) => !!cityOf(u) && u.gender === "U" && !u.birth_confirmed
               /* + §2-4 의 경로 판별(안 A 채택 시) */,
  /* 체인 말미의 요약 확인(결정 2-2). 기존 birth 단계 재사용 ──
     새 단계를 만들지 않는다. 전 항목을 한 화면에 보여주고
     「これで始めます / 直したい」. 확정 시 birth_confirmed = 1. */
  birth:       (u) => !!u.birth_date && !u.birth_confirmed
}
```

**요약 확인 1통이 동시에 해결하는 것 (지시서 2-2):**
1. **터미널 문제** — 성별은 체인 마지막이라 「뒤 항목」이 없어 2-1 방식이 안
   통하는데, 요약 확인이 그 뒤에 서면서 터미널이 생김
2. **`birth_confirmed` 의 의미 통일** — 사이트 경유자는 「はい、これで」로,
   LINE 직접 유입은 요약 확인으로. 양쪽 다 「생년월일 정보가 확정됨」
3. **오입력의 잡을 데** — 이름은 개별 확인(「〇〇 で OK?」)이 이미 있어 일관
- 「直したい」 → 어느 항목을 고칠지 quickReply 로 고르게 하고 그 단계로 복귀

**명시할 트레이드오프 (지시서 2-3):** 성별에서 「答えない」를 고른 뒤 요약
확인에 답하지 않고 이탈하면, 재진입 시 성별을 한 번 더 묻게 됩니다
(`gender='U'` + `birth_confirmed=0` 이 「미질문」과 구별되지 않으므로).
약간 어색하지만 치명적이지 않고, **추가 열 0 과 맞바꿀 가치가 있습니다.**

### §2-4. 기존 이용자의 성별 — (A)/(B) 비교 (새 설계 질문)

`PENDING.gender` 를 위처럼 두면, **사이트 경유자 중 아직 생년월일 확인을 안
누른 사람**도 성별 질문을 받습니다. 두 안:

| | 내용 | 대가 |
|---|---|---|
| **(A) 권고** | LINE 직접 유입에게만 새 단계 — 경로 판별을 gender 판정에 추가 | 판별 조건 +1 |
| (B) | 값이 없으면 경로 무관하게 묻기 | 대운 반영이 미정이라 지금 물을 실익이 없음 — 이용자만 번거로움 |

**판별자 실코드 확인 결과 (지시 §2-4 말미):** 사이트 경유자는 연동 시
`raw_result_json`(진단 전체)과 **`ohaeng_main`** 이 저장됩니다
([link.mjs](../server/lib/handlers/link.mjs) `upsertSajuProfile({... ohaengMain, rawResult})`,
[links.mjs](../server/lib/repo/links.mjs)). 다만 `raw_result_json` 을 판별자로 쓰면
**부적절합니다** — 새 체인이 출생지를 `raw.city` 에 중간 저장하는 순간
(fortune.mjs 가 읽는 자리가 거기라서 반드시 저장함) 체인 도중의 LINE 유입자가
「사이트 경유」로 오판되어 남은 단계가 멈춥니다. **판별자는 `ohaeng_main`** —
엔진 산출물이라 사이트 경유자는 처음부터 있고, LINE 체인은 요약 확인 후
엔진(vm) 계산 시점에만 채우므로 체인 내내 안전하게 비어 있습니다.
이 순서 제약(「ohaeng_main 은 최종 확인 후에만 채운다」)을 구현 규칙으로 명문화.

### 사이트 경유자와의 분기

판정이 전부 값의 유무이므로 **분기 코드가 따로 없음** — 사이트 경유자는
name_kr·birth_date·city 가 이미 있어 해당 단계가 자연히 스킵. §0.5 재확인 금지 충족.

### BLOCKING_STEPS — [리뷰 수정 2] `["name"]` 유지

파는 것은 **문법·회화·단어의 101일 강좌**이고 운세는 매일 붙는 부가물입니다.
`birth_date` 로 배송을 막으면 돈을 낸 사람이 레슨을 못 받습니다. `name` 은
회화문을 만들 수 없는 **하드 의존**이라 막고, 생년월일은 **소프트 의존**이라
운세만 빠집니다. 생년월일 미제출자에게도 사주 없이 레슨을 계속 보냅니다.
(Stripe 재심사에서 운세를 유료 배송에서 뺄 가능성도 열려 있어, 이 구분은
그때도 그대로 섭니다.) 「기존 이용자 birth_date 보유 실측」은 불필요해짐.

### 중단 복구 (사전 지시 7-4)

- 접점 복구: message/postback 진입 시 `nextStep` 이 남아 있으면 그 질문을 재제시
  (기존 `pendingStep` 패턴 확장)
- 배치 복구: push-daily 의 `askOnboarding` 이 새 단계도 부름 (`ONBOARD_NOTICE_MAX`=3
  상한 그대로 — 블록 방지)
- quickReply 소멸 대책: 「名前」「設定」 키워드 재진입(기존 ASK_SETUP)이 새 단계에도 적용

### 이름 없는 이용자의 봇 해소 (사전 지시 7-3)

친구추가만 한 이용자: follow 인사에서 바로 STEPS 첫 질문(이름 かな)으로 진입.
모든 안내문 말미에 **다음 행동 1개**가 반드시 보이게 (§2 결손 A 의 교훈 —
`onboardingDone` 패턴을 각 단계 문면에 일관 적용).

## 3. 수정 파일 (리뷰 수정 1·4·5 반영판)

| 경로 | 변경 |
|---|---|
| `server/lib/fortune.mjs` | `cities()` 접근자 1개 (기존 vm 로드에서 `Saju.CITIES` 반환) — **사본 없음** |
| `server/lib/onboarding.mjs` | STEPS·PENDING 확장 + **`ONBOARD_COLUMNS`**(수정 4 — PENDING 이 읽는 열의 유일한 출처) + 각 단계 문면 |
| `server/lib/repo/users.mjs` | **`DELIVERABLE_SQL` 에 `j.gender` 추가** (실측: 현재 누락 — 배치 경로의 판정이 조용히 어긋나는 실물) |
| `server/lib/handlers/postback.mjs` | `action=bdate/btime/bplace/bgender` + 요약 확인(기존 birth 재사용)·直したい 복귀 |
| `server/lib/handlers/message.mjs` | `pendingStep` 의 상태 객체에 새 열 포함 |
| `server/lib/handlers/follow.mjs` | 인사 후 첫 질문 진입 |
| `tools/verify-onboarding.mjs` | 아래 관문 2종 + 단계 도출 전수 |

### 관문 2종 (리뷰 수정 4·5 — 「조용한 흘리기」를 정적으로 잡는다)

1. **열 커버리지 관문 (수정 4)**: `ONBOARD_COLUMNS` (name_kr·birth_date·birth_time·
   birth_confirmed·gender·ohaeng_main·raw_result_json)를 한 곳에 두고, 상태를
   만드는 **모든 경로**(DELIVERABLE_SQL / getSajuProfile+COLS / stateOf /
   pendingStep)가 그 열 전부를 SELECT·전달하는지 소스 검사. 하나라도 빠지면
   `undefined` 로 판정이 조용히 어긋난다 — 이미 `DELIVERABLE_SQL` 의 gender
   누락으로 실증됨
2. **ohaeng_main 순서 제약 관문 (수정 5)**: 「LINE 체인 도중 `ohaeng_main` 을
   쓰는 경로가 없다」— bdate/btime/bplace/bgender 핸들러가 `ohaengMain` 을
   전달하지 않음을 정적 검사. 주석이 아니라 관문이 불변식을 지킨다
   (사본 금지·제외 7종·3경로 일치와 같은 부류)

## 4. 트레이드오프

- datetimepicker 는 LINE 전용 UI — 검증 관문에서는 JSON 형만 검사 가능(실 탭은
  라이브 검증으로). 라이브 검증 지시서(복습 퀴즈 때와 같은 형)를 구현 후 제출
- 사주 재계산: LINE 수집분은 raw_result_json 이 사이트 진단 결과가 아니라
  **서버가 조립한 최소형** — fortune.mjs 가 읽는 키(city·zodiac 등)만 채움.
  zodiac 등 파생값 계산은 엔진(vm)으로 — 사본 금지 유지
- 성별 수집 시작 = privacy 제2항 「性別はお訊きしていません」 문장과 충돌 —
  **§5 (plan-profile 때 제시한 초안) 게시가 배포 전제**

## 5. 검증 계획

부분 상태 × 단계 도출 전수(기존 5종 → 확장) / CITIES 패리티 / 각 postback 의
저장·다음 질문 연쇄 / 중단 후 재진입 3경로(접점·배치·키워드) / 기존 19종 회귀
