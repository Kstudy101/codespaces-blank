# 라이브 검증 지시서 — LINE 직접 유입 온보딩 (§4)

대상: 대표님 · 전제: privacy 제2항 보강판 게시 + 서버 배포 완료 후 · 2026-08-06

> datetimepicker·2단 quickReply 는 실제 탭이 필요해 정적 관문으로 못 잡습니다.
> 복습 퀴즈 라이브 검증과 같은 형식. **모든 조작은 테스트 계정 1개로만** —
> 이 체인은 본인 계정의 상태만 바꾸므로 실사용자 무영향은 구조로 보장되지만,
> 그래도 실사용자 계정으로는 누르지 마십시오.

## 0. 테스트 계정 준비 (phpMyAdmin)

```sql
-- 직접 유입 상태로 되돌린다 (이름·사주를 비움. 테스트 계정 id = <ID>)
UPDATE users SET name_kanji=NULL, name_reading=NULL, name_kr=NULL, name_source=NULL WHERE id=<ID>;
DELETE FROM saju_profiles WHERE user_id=<ID>;
-- 복구용 스냅샷을 먼저 SELECT 해서 복사해 두십시오 (§3)
SELECT * FROM users WHERE id=<ID>; SELECT * FROM saju_profiles WHERE user_id=<ID>;
```

## 1. 체인 왕복 (LINE 토크)

| 순서 | 조작 | 기대 |
|---|---|---|
| 1 | 아무 텍스트 1통 (예: 「はじめ」) | 읽기(かな) 요청이 옴 |
| 2 | かな 1행 (예: タロウ) | 「타로 で OK?」 → はい | 
| 3 | (자동) | **생년월일 picker** 버튼 |
| 4 | picker 로 날짜 선택 | **시간 picker + わからない** |
| 5 | **わからない** 탭 | **국가 2택** (日本/韓国) |
| 6 | 日本 → 도시 목록 | 도시 10개 quickReply, 탭 |
| 7 | (자동) | **성별 3택** — **「答えない」를 탭** |
| 8 | (자동) | **요약 확인** — 5항목이 한 화면에 |
| 9 | **「直したい」** 탭 | 항목 선택 → 시각 선택 → 시간 picker 재출현 → 답하면 요약으로 복귀 |
| 10 | **「これで始めます」** 탭 | 완료 안내(締め — 受講料 유도) |

## 2. 확인 3종

- **중단 복구**: 4단계쯤에서 12시간 방치(또는 다음 아침 배치 후) → 배치·「設定」 키워드·아무 버튼 3경로 중 하나로 **그 단계부터** 재개되는지
- **DB 실측** (전후 SELECT):
  - 9열이 의도대로만 변함 (`name_kr`·`birth_date`·`birth_time=NULL`·`raw_result_json.city`·`gender='U'`·`birth_confirmed=1`)
  - **`ohaeng_main` 이 끝까지 NULL** (판별자 불변식 — 요약 확인 후에도)
- **미학습·변조 무영향**: 배신·운세가 다음 아침 정상 (운세는 city 기반으로 나옴)

## 3. 원상복구

§0 에서 복사한 스냅샷 값으로 UPDATE/INSERT 복원 (또는 사이트 재진단→재연동).

## 4. 보고

각 단계 통과/실패 · 실패 시 화면 캡처 + 그 시점 SELECT · §2 세 확인 결과.
