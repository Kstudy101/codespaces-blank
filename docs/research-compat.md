# research-compat.md — gender ↔ 대운 ↔ privacy ↔ 웹/LINE 호환성 검토

작성: 2026-08-07 / 기준 커밋: `e544921` / 근거: 소스 실측
(STATUS §0 대기 4번 · plan-profile · plan-line-onboarding · 지시서⑩/⑤)

> **코드는 쓰지 않는다.** 이 문서는 사실 보고다.
> 대표님 결정(① 대운 반영 / ② 저장만 유지) 전제 없이 구현에 들어가지 말 것.

---

## 0. 한 줄 판결

**코드는 이미 ②(저장만)이다.** gender 는 LINE 직접 유입에서만 묻고 DB에
남기며, `saju.js` / `fortune.js` / `fortune.mjs` 어디에도 읽히지 않는다.
**대운(大運) 계산 함수 자체가 저장소에 없다.** ①을 고르면 「스위치를 켠다」가
아니라 **공유 엔진에 새 하위 시스템을 만드는 일**이다.

privacy 의 「現時点では保存のみ」는 코드와 맞다.
다만 지시서⑩(`'N'` 도입) 이후 **「答えない → 未回答のまま」문장만 사실과 어긋난다.**

---

## 1. 값의 의미 (실측)

| 값 | 의미 | 누가 넣는가 |
|---|---|---|
| `M` / `F` | 답함 | LINE `bgender` 버튼 |
| `U` | **아직 안 물음** (기본) | 사이트 연동 항상 · 신규 행 기본값 |
| `N` | **물었고 「答えない」** | LINE `bgender` 의 `v=N` (구버블 `v=U` 는 postback 이 `N` 으로 변환) |

출처:

- `server/db/migrations/005-gender-not-answered.sql` 머리말 (지시서⑩)
- `server/lib/onboarding.mjs` `askGender()` — 버튼 3종 `M`/`F`/`N`
- `index.html` linkFields — `gender:'U'` 고정, 화면에도 안 냄 (`label:null`)
- `tools/verify-fortune-server.mjs` — gender 를 바꿔도 운세 JSON 동일을 관문이 지킴

---

## 2. 스키마·마이그레이션 호환

| 위치 | ENUM | 비고 |
|---|---|---|
| `schema.sql` `saju_profiles.gender` | `M,F,U` | 라이브 표는 migration 으로만 진화 — 의도적 |
| `schema.sql` `pending_links.gender` | `M,F,U` | **005 가 안 건드림** |
| `migrations/004-trial-end-pushtype.sql` | (gender 무관) | `push_type` 에 `trial_end` |
| `migrations/005-gender-not-answered.sql` | `M,F,U,N` | **`saju_profiles` 만** |

`verify-server.mjs` 가 「005 는 4종 · 코드 화이트리스트 4종 · schema.sql 에는
`'N'` 이 없어야 함」을 대조한다. schema 에 `'N'` 을 쓰면 관문이 막는다.

### 잠복 1 — `pending_links` ENUM 뒤처짐

`link.mjs` 의 `normalizeProfile` 화이트리스트는 `M|F|U|N` 이다.
사이트는 항상 `U` 만 보내므로 지금 경로에서는 터지지 않는다.
그러나 API 로 `N` 이 들어오면 `pending_links` INSERT 가 ENUM 거부로
죽을 수 있다 (sql_mode 에 따라 조용한 잘림도 가능 — 둘 다 나쁨).

### 문서 충돌 — plan-profile 의 「migration 004」

`docs/plan-profile.md` 와 `docs/research-onboarding-gap.md` 가 아직
「gender 정비 = migration **004**」라고 쓴다. 현실은:

- **004** = `trial_end` (코스 온보딩, 이미 적용)
- **005** = gender `'N'` (지시서⑩, 이미 적용)

프로필 편집에서 gender 쪽 추가 SQL 이 필요하면 **006 이상**이다.
「004 를 다시 쓴다」는 사고로 이어진다.

---

## 3. 계산 경로 — gender 는 입력도 출력도 아니다

### 3-1. 엔진 (`saju.js` / `fortune.js`)

- `Saju.pillars({ y, m, d, hour, minute, city })` — gender 인자 없음
- `Fortune.of(mine, today)` — 일운 점수. 대운·순행/역행 없음
- 저장소 전수 검색: `大運` / `대운` / `daeun` / `daewoon` / `順行` / `逆行`
  은 **문서·privacy 에만** 있고 엔진 코드에는 0건

### 3-2. LINE 배신 (`server/lib/fortune.mjs`)

```js
const mine  = Saju.pillars({ y: by, m: bm, d: bd, hour: bh, city });
const today = Saju.pillars({ y: ty, m: tm, d: td, hour: 12, city });
const r = Fortune.of(mine, today);
```

`user.gender` 를 읽지 않는다. `DELIVERABLE_SQL` 이 `j.gender` 를 실어 와도
엔진에 안 넘어간다.

### 3-3. 사이트 (`index.html`)

같은 `Saju.pillars` / `Fortune.of` 호출. gender 미전달.
웹↔LINE 운세가 지금 같은 이유: **둘 다 gender 를 무시**하기 때문
(CLAUDE.md 「사본을 두면 갈라진다」의 대칭 — 입력이 같으면 결과가 같다).

### 3-4. 관문이 지키는 불변식

`verify-fortune-server.mjs`:

> gender は運勢を変えない（'N' 追加が結果に触れない・지시서⑩）

M/F/N/U 네 값이 동일 JSON 이어야 PASS. ①을 택하는 날 이 관문은
**뒤집거나 범위를 나눠야** 한다 (대운이 일운에 섞이는지부터 제품 결정).

---

## 4. privacy 정합 (어긋난 적 4번 — 이번이 5번째 후보)

`c11242f`(2026-08-05) 확정판이 목적·저장만을 밝혔다. 표와 본문 요지:

| 주장 | 코드와 맞는가 |
|---|---|
| 장래 大運 용도 · **現時点では保存のみ** | ✅ |
| LINE 토크 답변만 저장 · 사이트는 未回答(`U`) | ✅ |
| 「答えない」도 고를 수 있다 | ✅ (`v=N`) |
| 「答えない」→「**未回答のまま変わりません**」 | ❌ **005 이후 거짓** — DB 에는 `'N'` |
| 「答えないのままでもすべての機能をご利用いただけます」 | ✅ (저장만인 동안) |

문제 문장 (`privacy.html` 본문):

> （「答えない」も選べます。その場合は「未回答」のまま変わりません）。

실상: 「答えない」는 `'N'` 으로 **바뀐다.** `'U'`(미질문)와 `'N'`(거부)을
가르는 것이 005 의 존재 이유다. 문장이 그 구분을 다시 뭉갠다.

`verify-onboarding.mjs` 는 「保存のみ」「未回答」「答えた場合のみ」는 보지만,
위 「未回答のまま」거짓 문장은 **아직 안 잡는다.**

온보딩 문면(`askGender`)은 「現在は保存のみで、運勢の計算にはまだ使っていません」
로 코드·privacy 목적과 일치.

---

## 5. 경로별 동작 요약

```
사이트 진단 → LINE 연동
  gender 항상 'U' (미질문) → pending_links → saju_profiles
  bgender 단계 스킵 (ohaeng_main 있음 → PENDING.bgender 거짓)
  운세: gender 무시

LINE 직접 유입
  … → bgender (U 이고 미확인일 때만)
  M/F/N 저장 → 요약 확인 → birth_confirmed
  운세: gender 무시 (저장만)

아침 배신 fortuneFor(user, date)
  pillars + Fortune.of — gender 필드 미사용
  관문: M/F/U/N 결과 동일
```

요약 확인 라벨 맵 (`summaryConfirm`):

```js
const g = { M: "男性", F: "女性", U: "答えない" }[u.gender] || "答えない";
```

`'N'` 은 `|| "答えない"` 로 표시되어 동작은 한다.
다만 진짜 `'U'`(미질문)도 「答えない」로 보인다 — 요약 화면에
미질문이 남는 정상 경로가 거의 없어 실해는 작지만, 맵에 `N` 을
넣지 않은 **표시 호환 구멍**이다.

---

## 6. 결정지 — ① 반영 vs ② 저장만

### ① gender 를 대운 계산에 반영

| | |
|---|---|
| 성격 | **신규 구현** (엔진에 대운 없음) |
| 필수 위치 | 공유 `saju.js` 한곳 — server 사본 금지 (vm 규칙) |
| 웹↔LINE | 사이트는 계속 `U` → **기본값·스킵·사이트도 질문** 중 제품 결정 필수. 서버만 gender 를 쓰면 운세가 갈라지고, 양쪽 다 그럴듯해서 대조 전엔 모른다 |
| `U` / `N` | 005 구분을 유지한 채 「미질문·거부 시 대운을 어떻게 할지」를 정해야 함. 다시 `U` 로 뭉개면 온보딩이 재발 |
| privacy | **반영 전에** 「保存のみ」삭제 · 「全機能」표 행 · 答えない 문장 개정 (`plan-line-onboarding.md` §6) |
| 관문 | `verify-fortune-server` 의 gender 불변식 폐기/재작성 · saju 대운 관문 신설 |
| plan-profile | 편집 UI 와 **별도 계획** (plan-profile 본문도 「대운은 별도」라고 이미 적음) |

일운(`Fortune.of`)에 대운이 꼭 들어가야 하는지도 미결이다.
「10년 대운 표시」와 「매일 점수 입력」은 범위가 다르다.

### ② 저장만 유지 (현행 의도 · 코드 실상)

엔진·배신 불변. 남는 일은 **문서·폴리시 위생 + (승인 시) 프로필 편집**:

| 할 일 | 왜 |
|---|---|
| privacy 「未回答のまま」→ `'N'` 사실에 맞게 | 폴리시↔코드 드리프트 |
| plan-profile / research-onboarding-gap 의 「004」정정 | 다음 migration 사고 방지 |
| live-check 「答えない → gender=U」→ `N` | 지시서⑩ 회귀를 「통과」로 위장 |
| plan-line-onboarding ENUM·§2-3 (재질문 트레이드오프) | `'N'` 으로 이미 해소 — 문서만 옛것 |
| (선택) `pending_links.gender` 4종 | normalize 화이트리스트와 표 정합 |
| (선택) `summaryConfirm` 맵에 `N` | 표시 정확 |

프로필 편집(`plan-profile`)은 ② 위에서도 의미가 있다 —
저장·수정 UI 이지, 대운 스위치가 아니다.

---

## 7. STATUS 대기 4번의 정확도

STATUS.md:

> 4. plan-profile 의 전제 2건 — gender 대운 반영 ①/② + privacy 문안

| 전제 | 지금 |
|---|---|
| ①/② 결정 | **여전히 대표 몫 · 미결** |
| privacy 문안 | `c11242f` 로 **게시됨**. 다만 005 이후 「答えない≠未回答」한 줄 수정이 남음 — 「초안 확정」과 「005 정합」은 다른 일 |

기준 커밋 표기(`db20b17`)는 HEAD(`e544921`)보다 뒤처져 있으나,
대기 4번의 실체는 위와 같다.

---

## 8. 이 검토에서 고치지 않는 것 (scope 밖)

- 대운 알고리즘 설계·구현
- 프로필 편집 페이지 구현
- privacy / plan / live-check 문구 수정 (대표가 ②를 확인하거나
  「폴리시만 먼저」라고 지시하기 전)
- `pending_links` migration
- 운세 엔진 사본을 server 에 두는 어떤 시도도

---

## 9. 대표님께 묻는 것 (이 검토의 산출)

1. **①인가 ②인가.**  
   - ②면: 코드 변경 없이 폴리시·문서 정합만 계획하면 된다.  
   - ①면: 대운을 **어디에 쓰는지**(표시만 / 일운 점수 입력)부터
     별도 계획. plan-profile 과 묶지 말 것.
2. ②를 유지한다면, privacy 한 줄(「未回答のまま」)을
   **지금 고칠지** / 프로필 계획에 실을지.
3. plan-profile 착수 전제에서 「privacy 문안」을
   **해소된 것으로 볼지**(005 정합 한 줄은 별도).
