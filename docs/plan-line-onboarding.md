# plan-line-onboarding.md — LINE 직접 유입: 대화창에서 전 항목 수집 (지시서 §5)

작성: 2026-08-05 / 근거: 지시서 정정 1·2 + [research-onboarding-gap.md](research-onboarding-gap.md) / 기준 커밋: `0b62d51` 이후

> **상태: 승인 대기.** 온보딩 상태 기계의 개편이라 범위가 큼 — CLAUDE.md 규약대로
> 승인 전 코드 없음. §0.5(이름 정본 원칙)와 사전 지시 7-3(이름 없는 이용자 해소)·
> 7-4(중단 복구)가 이 설계의 골격입니다.

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

CITIES 는 사이트(saju.js)에만 있음 → **kana2hangul 과 같은 방식**: 서버 사본 +
verify 관문이 saju.js 실물과 전수 대조 (id·표기·개수). 사본 금지 규칙의 두 번째
허가 예외로 CLAUDE.md 에 명기.

## 2. 상태 기계 설계 (지시서 필수 항목)

### STEPS 확장

```js
STEPS = ["name", "birth_date", "birth_time", "birth_place", "gender", "birth"]
//        기존      신설         신설           신설          신설      기존(진위 확인)
```

- **단계를 DB 열로 저장하지 않음** — 전부 값의 유무에서 도출 (현행 설계 유지):

```js
PENDING = {
  name:        (u) => !u.name_kr,                       /* §0.5: name_kr 존재가 유일 판정 */
  birth_date:  (u) => !u.birth_date,
  birth_time:  (u) => !u.birth_date ? false             /* 날짜 뒤에만 */
                     : (u.birth_time === undefined),    /* ★아래 「모름」 표현 문제 */
  birth_place: (u) => !!u.birth_date && !cityOf(u),
  gender:      (u) => !!u.birth_date && u.gender === "U" && !u.gender_asked,  /* ★동일 문제 */
  birth:       (u) => !!u.birth_date && !u.birth_confirmed   /* 진위 확인(기존) */
}
```

★ **설계 결정 2건 — 주석 부탁:**
1. **「모름/무회답」과 「아직 안 물음」의 구별.** `birth_time=NULL`·`gender='U'` 는
   양쪽 다 「모름」과 「미질문」을 표현합니다. 도출 원칙을 지키려면:
   (가) 사주 항목은 **일괄 흐름**으로만 묻고(날짜를 답한 직후 시간→출생지→성별을
   연쇄), 개별 재질문은 안 함 — 추가 열 0, 흐름이 순서를 보장 **(추천)**
   (나) `asked_at` 류의 열 추가 — 도출 원칙 훼손
2. **기존 `birth`(진위 확인) 단계와의 관계** — LINE 에서 직접 입력한 값은 입력
   자체가 확인이므로, LINE 수집분은 `birth_confirmed=1` 로 저장해 이중 확인 생략 (추천)

### 사이트 경유자와의 분기

판정이 전부 값의 유무이므로 **분기 코드가 따로 없음** — 사이트 경유자는
name_kr·birth_date·city 가 이미 있어 해당 단계가 자연히 스킵. §0.5 재확인 금지 충족.

### BLOCKING_STEPS

현행: name 만 막음(회화문을 못 만듦), birth 는 안 막음(운세만 빠짐).
제안: **`["name", "birth_date"]`** — 생년월일이 아예 없으면 사주·운세 전부 불능이라
막는 편이 정직. 시간·출생지·성별·진위확인은 안 막음(빠지는 건 정밀도뿐).
※ 단 birth_date 를 막으면 「사이트 경유 없이 이름만 있는」 기존 이용자의 배신이
멈추므로, **기존 이용자 전원이 birth_date 보유인지 배포 전 실측** 필요.

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

## 3. 수정 파일 (예상)

| 경로 | 변경 |
|---|---|
| `server/lib/cities.mjs` | **신규** — CITIES 사본 (saju.js 에서 이식) |
| `server/lib/onboarding.mjs` | STEPS·PENDING 확장 + 각 단계 문면 (datetimepicker·2단 quickReply) |
| `server/lib/handlers/postback.mjs` | `action=bdate/btime/bplace/bgender` 수신·저장 |
| `server/lib/handlers/message.mjs` | (이름 かな 수신은 기존 그대로) |
| `server/lib/handlers/follow.mjs` | 인사 후 첫 질문 진입 |
| `tools/verify-onboarding.mjs` | 단계별 + 부분 상태 + CITIES 패리티 |
| `CLAUDE.md`·문서 | 사본 예외 2호(cities) 명기, 관문 수 갱신 |

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
