# 리서치 — 컨텐츠 추가 경로 (원고·퀴즈·운세 문면)

작성: 2026-08-07 / 선행: [STATUS.md](../STATUS.md) §0·§6 · [plan-p4-content.md](plan-p4-content.md) · [curriculum.md](curriculum.md)

> 코드·원고는 쓰지 않는다. 「컨텐츠를 더 넣으려면 무엇을 구축할지」를
> 결정하기 위한 현황 조사다.

---

## 1. 한 줄 요약

**배신·검증 파이프는 이미 있다.** 부족한 것은 CMS가 아니라
(1) 아직 안 쓴 원고 자체, (2) 로컬→서버 입고를 실수 없이 반복하는
**운영 하네스**, (3) 빠진 날·퀴즈·운세 문면을 한눈에 보는 **재고 가시성**이다.

---

## 2. 지금 있는 것 (건드리지 말고 쓸 것)

| 층 | 경로 | 역할 |
|---|---|---|
| 스키마·입고 API | `content_templates` + `learning.upsertTemplate` | PK `(track, day_number)`, semester 자동 |
| 형태 검사 | `server/lib/content-check.mjs` | 슬롯·단어 3·받침 프로브 렌더·중복 문법 |
| 입고 | `server/db/seed-content.mjs` | 전부 통과 후 upsert / `--check` / `--track=` |
| 퀴즈 차입 | `server/db/merge-quiz.mjs` | sidecar → 일별 JSON, 커리큘럼 범위 검사, 기본 dry-run |
| 운세 문면 검사 | `fortune-text.checkLines` | 6×5 + 십신 10. 파일은 DB 안 탐 |
| 아침/저녁 렌더 | `render.mjs` + `push-daily` / `push-evening` | `--dry-run` / `--user=` 로 문면 확인 |
| 관문 | `verify-render` / `verify-quiz` / `verify-fortune-server` 등 | DB·npm 없이 규칙 고정 |
| 커리큘럼(문법 목록) | `docs/curriculum.md` | 초·중·고 각 101. **실원고 대체물 아님** |

실사용 입고 경로 (STATUS §0):

```
로컬에서 content-check 통과
  → cPanel File Manager 로 server/content/ 업로드
  → seed --check → seed
  → push-daily --user=<id> --dry-run (3통)
```

관리 UI(P9)는 `learning.mjs` 주석에만 있고 **미구축**. HTTP로 seed/push를
여는 설계는 plan-p4 에서 이미 기각됐다.

---

## 3. 지금 없는 것 (컨텐츠 자산)

| 자산 | 위치 | 실측/상태 |
|---|---|---|
| 초급 1–50 | `server/content/` (서버만) | 입고됨 |
| 초급 51–101 | 同上 | 미집필/미입고 |
| 중급·고급 1–101 | 同上 | 0 (로컬 1–3일 검증분 대기) |
| `fortune-lines.json` | `server/content/` | 없으면 운세만 조용히 생략 |
| 복습·절목 `quiz` | 일별 JSON의 `quiz` 열 | 0건 → 퀴즈 배신 침묵 |
| 절목 30/50/75 | 同上 | 발신 코드는 있음, 원고만 없음 |

제약은 코드에 박혀 있다.

1. **공개 저장소에 원고 금지** — 유료물, push 한 번이면 이력에서 안 지워짐  
2. **seed는 18시(JST) 저녁 배치 전** — 그날 원고를 갈아끼우면 Q/A 어긋남 (방어 코드 없음)  
3. **배포가 `content/` 를 지우면 유일 사본 소멸** — exclude 목록 7개가 정본  
4. **의존 `mysql2` 하나** — CMS/SDK 추가와 충돌하는 방향  
5. **운세 엔진 사본 금지** — `node:vm` 으로 사이트 파일을 실행

---

## 4. 병목 분석 — 「쓰기」vs「넣기」

```
집필 ──────────────────▶ 검증 ──────▶ 업로드 ──▶ seed ──▶ dry-run
 (사람·시간)              (도구 있음)   (손)      (도구)   (도구)
      ▲                      ▲
      │                      │
  curriculum.md         content-check
  (문법 순서만)         merge-quiz
                        checkLines
```

- **집필**이 절대 시간·비용의 대부분이다 (303일 × 문법+회화+단어3 + 퀴즈).  
- **검증·seed·dry-run**은 이미 있다. 반복할 때마다 File Manager + SSH 타이핑이
  마찰이고, 「어느 코스에 몇 일이 비었는지」「퀴즈가 어느 날에 있는지」를
  한 명령으로 보기 어렵다 (`who.mjs` / seed 끝의 missing 출력은 있으나
  운세·퀴즈 재고까지 묶인 리포트는 없음).  
- `seed-content` 는 `CONTENT_DIR` 환경변수를 안 보고 고정 경로다.
  `merge-quiz` 만 `CONTENT_DIR` 를 받는다 → 스테이징 디렉터리 운용이 반쪽이다.

---

## 5. 구축 후보를 코드 기준으로 분류

### A. 안 지어도 되는 것 (이미 있음)

렌더러, 아침/저녁 배치, content-check, seed upsert, merge-quiz, dry-run,
관문 19종, 코스별 track, 절목/복습 퀴즈 배신 코드.

### B. 얇게 붙이면 이득이 큰 것 (하네스)

1. **재고 리포트** — track별 있는 날 / 없는 날 / quiz 있는 날 / fortune-lines 유무  
2. **로컬 패키지 검사** — 디렉터리 하나 잡고 content-check + checkLines +
   (선택) merge-quiz dry-run 을 한 번에  
3. **seed의 `CONTENT_DIR` 정렬** — merge-quiz 와 같은 스테이징 규약  
4. **입고 체크리스트 문서** — 18시 규칙·업로드 순서·dry-run 3통 (코드보다 운용)

### C. 나중에 가도 되는 것 (비용 큼)

- 웹 CMS / 운영자 UI (P9) — 인증·프라이버시·새 스택. 스키마는 upsert 준비만 됨  
- HTTP seed API — plan-p4 기각 사유(외부 유발) 그대로  
- 공개 저장소에 원고 — 결정⑤ 위반  
- LLM 일괄 생성 파이프라인 — 품질·슬롯·커리큘럼 대조를 사람이 다시 봐야 해서
  「생성」보다 「검사+미리보기」가 먼저

### D. 컨텐츠 자체 (구축이 아니라 집필)

중급·고급 1–3 → 확장, 초급 51–101, fortune-lines 40칸, quiz 백필.
도구가 아니라 **사람 작업**이며 STATUS 착수 대기 §1과 동일하다.

---

## 6. 기존 계획과의 관계

| 문서 | 이 리서치와의 관계 |
|---|---|
| plan-p4-content | P4-a/b(렌더·배치)는 구현됨. 남은 것은 P4-c 집필 + 입고 운용 |
| plan-quiz / plan-quiz-checkpoint | 코드 완료, **원고 백필만** 남음 |
| plan-fortune-daily | 배신 완료, **fortune-lines.json 입고만** 남음 |
| curriculum.md | 집필 순서 참조. DB를 이걸로 갈아엎지 말 것 |
| learning.mjs P9 | 운영 UI는 별 계획. 지금 범위에 넣지 말 것 |

---

## 7. 결론 (다음 계획서로)

컨텐츠 추가를 위해 **새로 크게 지을 시스템은 없다.**  
지을 가치가 있는 것은 「재고 가시성 + 스테이징 검사 + 입고 절차 고정」정도의
**얇은 운용 층**이고, 본체인 중급·고급·퀴즈·운세 문면은 **집필·업로드**다.

대표 결정이 필요한 축은 다음뿐이다.

1. 비공개 원고 이력(private repo / tarball)을 둘지, File Manager만 유지할지  
2. 하네스(재고 리포트·CONTENT_DIR)를 지금 코드로 넣을지, 문서 체크리스트만으로 갈지  
3. 집필 우선순위(STATUS §1의 중급·고급 1–3 + fortune-lines 유지 vs 초급 51+ 병행)
