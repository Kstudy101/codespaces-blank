# plan-profile.md — 프로필 편집 페이지 + gender 신설 (지시서 §3·§4)

> STATUS: **A4 → B1** — [STATUS.md](../STATUS.md) §0.

작성: 2026-08-05 / 근거: [research-onboarding-gap.md](research-onboarding-gap.md) / 기준 커밋: §2 수정 커밋 뒤

> **상태: 승인 대기.** 착수 전제 2건이 대표님 몫입니다:
> ① §4 답 — gender 를 대운 계산에 **반영(①)** 할지 **저장만(②)** 할지
> ② §5 문안 — privacy 수정 초안(1차 보고에 제시)의 확정·게시
> 승인 전까지 코드를 쓰지 않습니다.

---

## 0. 범위

| 넣는 것 | 넣지 않는 것 |
|---|---|
| `/profile` 편집 페이지 (서버가 렌더) | 사이트 무료 진단 STEP1-5 (불변 — 지시) |
| LINE Login 재사용 인증 | 새 인증 방식·토큰 링크 |
| 이름(§0.5)·생년월일·출생시간·성별·출생지 수정 | LINE 표시명 동기화 (§0.5 금지) |
| migration 004 (`saju_profiles.gender` 정비) | 대운 계산 변경 (§4-① 채택 시에도 **별도 계획**) |
| 저장 후 LINE 확인 1통 | 온보딩 미완료자용 편집 (안내로 유도만) |

## 1. 조사 — 이미 있는 것

- **인증**: `linelogin.mjs` 의 OAuth 전체(state 1회용·해시 저장·30분 만료)가 연동에서 가동 중.
  편집도 같은 경로를 타되 콜백의 「용도」만 구분 (연동 state 와 편집 state 를 섞으면
  연동 대기건이 편집으로 소비되는 사고 — state 발급 시 purpose 를 함께 저장)
- **gender 열은 이미 있습니다** — `saju_profiles.gender` 는 base schema 부터 존재,
  기본 `'U'`(未回答). privacy 도 「未回答を表す値だけをお送りし」로 그 사실을 공개 중.
  **004 의 일은 열 추가가 아니라 「실제 값을 받기 시작하는 것」** — ENUM 정의가
  실값('M'/'F' 등)을 허용하는지 확인·정비가 전부일 수 있음 (구조 변경 최소)
- **저장 경로**: `users.updateName` / `users.upsertSajuProfile` 재사용.
  upsert 는 생년월일 변경 시 `birth_confirmed` 를 자동으로 내리므로(기존 동작),
  편집으로 생년월일을 바꾸면 다음 접점에서 ②확인이 자연히 다시 나옴 — 원하는 동작
- **이름**: `kana2hangul.mjs` + Phase 1 의 확정 흐름 재사용 (§0.5 — name_kr 정본,
  변경 시에만 かな 재입력 → 변환 → 미리보기 → 확정)

## 2. 설계 개요

```
LINE 리치메뉴/「情報を変更」 → GET /profile/start → LINE Login (state, purpose=edit)
 → callback → 세션 쿠키(단명, HttpOnly) → GET /profile : 현재값 프리필 폼
 → POST /profile : 검증 → updateName / upsertSajuProfile → LINE 확인 1통
 → 사주·운세는 다음 아침 배신부터 자동 반영 (매일 프로필에서 계산)
    name_kr 변경은 그날 저녁 복습·다음 아침부터 즉시 반영
```

- 페이지는 `server/` 가 렌더 (`pages.mjs` 패턴). 사이트(dist) 쪽은 **무변경** —
  「사이트 폼 불변」 지시와, 페이지 추가 시 4곳 수정 함정을 둘 다 회피
- 프리필: 인증된 user_id 로 `users`+`saju_profiles` 로드. **빈 폼 재입력 금지가 존재 이유**
- 검증: 생년월일은 사이트와 같은 범위(1930~2030, 절기표와 동일), 시간은 임의,
  출생지는 기존 형식. 이름 변경은 かな만 (Phase 1 과 동일 규칙)

## 3. migration 004 (002 교훈 반영)

- 실상 확인 먼저: 본번 `SHOW CREATE TABLE saju_profiles` 로 gender ENUM 현황
- 필요 시에만: 데이터 정규화 → 구조 변경 순. NULL/'U' 허용 유지, 재실행 안전
  (errno 삼킴 목록 내에서), FK·인덱스 접촉 없음 확인
- 기존 사용자 'U' 유지 — 수집될 때까지 현행 계산 (§4-① 채택 시에도)

## 4. 검증 (관문)

- 인증 없음 / 타인·만료 state / 온보딩 미완료 접근 → 3종 거부
- 프리필이 본인 값인지 (다른 user_id 값이 안 섞이는지)
- 저장 → LINE 확인 1통 왕복 / name 변경이 §0.5 흐름(변환·미리보기·확정)을 타는지
- 기존 19종 전량 회귀

## 5. 트레이드오프

- 편집 페이지를 서버 렌더로 두면 사이트 배포(4곳 수정)와 무관해지지만,
  서버 재기동이 페이지에도 영향 — 허용 (이미 연동 콜백이 같은 성질)
- 세션 쿠키 도입은 새 상태 — 수명을 짧게(예: 15분), HttpOnly/SameSite 로 제한
