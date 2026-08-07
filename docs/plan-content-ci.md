# plan-content-ci.md — 원고 FTPS·DB 시드 CI 자동화

작성: 2026-08-07 / 조사: [research-content-ci.md](research-content-ci.md)  
**승인: 작업지시서 ⑮** (2026-08-06 대표, 기준 `c0952b3`)

> **상태: 단계 A·B·§7·템플릿 C 구현 중/완료. private repo 생성·Secrets·실기 시험은 대표.**

관련: STATUS A0·A1·D1 / [plan-upload-content](plan-upload-content.md) / [plan-deploy-auto](plan-deploy-auto.md)  
템플릿: [content-repo-template/](content-repo-template/)

---

## 0. 지시서⑮가 확정한 것 (이전 대안표 폐기)

| 요청이었던 것 | 확정 |
|---|---|
| `deploy.yml` 에 FTPS·seed | **하지 않음** (Xserver 전용) |
| Actions 에서 `with-env` / DB Secrets | **금지** (§0-2) |
| ChemiCloud SSH | **금지** (§0-1) |
| 원고를 공개 repo 에 | **금지** (§0-3) |
| 구조 | **private repo → FTPS → UAPI Deploy → `.cpanel.yml` seed** (§2) |
| 선행 | **§3 quiz 보존 없이 시드 자동화 금지** |

---

## 1. 구현 체크리스트 (지시서⑮ §9)

| # | 담당 | 내용 | 상태 |
|---|---|---|---|
| 1 | 개발 | §3 quiz `IF(VALUES(quiz) IS NULL, …)` + 관문 + 보존 로그 | [x] |
| 2 | 대표 | 지시서⑬ FTP 계정 (A0) | 대표 |
| 3 | 개발 | §4 `.cpanel.yml` `--check` → seed, 빈 content 성공 | [x] |
| 4 | 대표 | private repo + §6-2 Secrets 6개 | 대표 |
| 5 | 개발 | §5-2 워크플로 템플릿 (`docs/content-repo-template/`) | [x] 템플릿 |
| 6 | 대표 | 원고 1개로 전 경로 시험 (§10-3) | 대표 |
| — | 개발 | §7 바이트 검사 (`checkManuscriptBytes`) | [x] |
| — | 개발 | `tools/trigger-chemi-deploy.sh` (cpanel.sh 만 사용) | [x] |

---

## 2. 수정 파일 (공개 저장소)

| 경로 | 내용 |
|---|---|
| `server/lib/repo/learning.mjs` | quiz 보존 SQL + `listQuizKeys` |
| `server/db/seed-content.mjs` | 빈 skip·바이트검사·보존 건수 로그 |
| `server/lib/content-check.mjs` | `checkManuscriptBytes` (§7) |
| `.cpanel.yml` | 2단계 seed + 빈 content 성공 |
| `tools/verify-server.mjs` | §3·§4 관문 |
| `tools/verify-render.mjs` | §7 관문 |
| `tools/trigger-chemi-deploy.sh` | 신규 |
| `docs/content-repo-template/**` | private 로 복사할 워크플로 |
| `docs/research-content-ci.md` | 조사 (유지) |

**건드리지 않음:** `deploy-server.yml` · 관문 19종 목록 자체 · 결제·리치메뉴 (§11)

---

## 3. Secrets (지시서⑮ §6 — 대표용)

### 공개 repo — 추가 없음
`CPANEL_HOST` / `CPANEL_USER` / `CPANEL_TOKEN`

### private repo — 신설 6개
`FTP_HOST` · `FTP_USER` · `FTP_PASS` · `CPANEL_HOST` · `CPANEL_USER` · `CPANEL_TOKEN`

### 등록하지 않음
SSH 키 · DB 비밀번호 · 메인 cPanel 비밀번호

---

## 4. 완료 보고 항목 (§10) — 커밋 후 채움

1. 커밋 해시 A/B/C
2. §3 관문 로그 (verify-server quiz 보존)
3. §4-3 빈 content — seed exit 0 / yml skip 문구
4. §4-2 깨진 원고 — `--check` 실패 (대표 실기)
5. §5-2① 공개 규칙 참조 (템플릿이 `engine/` checkout)
6. §7 Latin-1 검출 로그 (verify-render)
7. 배포 로그에 본문 없음 (설계: problems 는 일차+사유만)
8. 관문 증가분

**2·3번만으로도 실익** — FTPS 후 `deploy-server` Run 이면 seed 자동.
