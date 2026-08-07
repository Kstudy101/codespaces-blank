# 라이브 검증 지시서 — 프로필 편집 (B1)

> STATUS: **B1 종결** — [STATUS.md](../STATUS.md) §F.
> **2026-08-08:** 구현·배포 완료로 대표 종결. `/profile/start` → **302** (2026-08-07).
> 아래 §1〜§4는 필요 시 참고용（종결 시점에 별도 라이브 미실施）.

작성: 2026-08-07 / 근거: plan-profile.md

## 전제

- server 배포 완료 + migration `006-oauth-states.sql` 적용
- `curl -s https://api.kstudy101.jp/profile/start` → **302** (404면 미배포)
- 테스트 계정은 **온보딩 완료** (`birth_confirmed=1`, 코스 선택済)

## §1. LINE → Web 진입

| # | 조작 | 기대 |
|---|---|---|
| 1 | 토크에 「情報を変更」 입력 | 「下のボタンから」+ **情報を変更** URI 버튼 |
| 2 | 버튼 탭 | LINE Login → `/profile` 편집 폼 (현재값 프리필) |

## §2. 저장 왕복

| # | 확인 | 기대 |
|---|---|---|
| 1 | 프리필 | 이름(かな)·生年月日·出生地가 DB 값과 일치 |
| 2 | かな 변경 | 유효한 かな → 저장 → **LINE 확인 1통** |
| 3 | 무효 かな | 에러 메시지, 저장 안 됨 |

## §3. DB 실측 (저장 직후)

```sql
SELECT name_reading, name_kr FROM users WHERE id = <ID>;
SELECT birth_date, birth_time, gender, birth_confirmed,
       JSON_EXTRACT(raw_result_json, '$.city') AS city
  FROM saju_profiles WHERE user_id = <ID>;
```

`birth_confirmed=1` 유지.

## §4. 미완료 계정

온보딩 미완료 계정에서 「情報を変更」→ **Web 링크 없이** 「まだ登録が完了していません」 안내.

## §5. 보고

- §1〜§4 통과/실패 · 실패 시 캡처
- 배포 커밋 해시 · `/health` · migration 006 적용 확인
