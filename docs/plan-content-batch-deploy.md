# plan-content-batch-deploy — 로컬 원고 일괄 업로드 + seed

작성: 2026-08-13 / 선행: [research-content-batch-deploy.md](research-content-batch-deploy.md)  
상태: **구현 완료**（2026-08-13）— 승인 D1 래퍼 · D2 `_*.json` 제외 · D3 `--deploy` 명시

관련: [plan-upload-content](plan-upload-content.md) · [plan-content-ci](plan-content-ci.md) · STATUS §5.1

---

## 0. 목표（한 줄）

```
server/content/ 에서 JSON 수정
  → 한 명령으로 FTPS 일괄 업로드
  → Deploy 트리거로 DB seed
```

cPanel File Manager / 파일 1개씩 업로드 루프를 없앤다.

---

## 1. 접근 방식

### 1-1 새 얇은 래퍼（권장）— `tools/publish-content.sh`

기존 `upload-content.sh`（1파일·안전 약속）는 **그대로 두고**, 그 위에 배치만 얹습니다.
1파일 도구의 관문·FTPS 약속을 깨지 않기 위함입니다.

```bash
# 검사만（DB 불필요）
bash tools/publish-content.sh --check

# 올린다만（seed 안 함）
bash tools/publish-content.sh --upload

# 올리고 Deploy（= .cpanel.yml 이 seed）까지
bash tools/publish-content.sh --upload --deploy

# 일부만
bash tools/publish-content.sh --upload --deploy \
  server/content/beginner-01-15.json \
  server/content/beginner-16-30.json
```

내부:

1. `--check` → `node server/db/seed-content.mjs --check <files…>`  
2. 각 파일을 기존 `bash tools/upload-content.sh "$f"` 로 순회（이미 FTPS·크기 대조）  
3. `--deploy` → `bash tools/trigger-chemi-deploy.sh`

### 1-2 `upload-content.sh` 소폭 확장（대안 · 한 파일에 몰기）

복수 인자·`--all` 허용. 「1つずつ」가드를 풀고 루프.
관문 `verify-server` 의 `[原稿の送り口]` 문구가 「1ファイル」을 단언하면 **같이 수정**.

**추천은 1-1.** 업로드 본체와 「검사+배포」를 분리해 실패 지점이 읽기 쉽습니다.

### 1-3 `--all` 에 넣을 파일 집합

| 포함 | 제외（기본） |
|---|---|
| `beginner-*.json` / `intermediate-*.json` / `advanced-*.json` | `_*.json`（빌드·스냅샷） |
| `quiz-*-review.json` | `fortune-lines.json` 등 비템플릿（이미 seed skip） |

제외 목록은 스크립트 머리말에 고정. 늘리면 계획서에 한 줄.

---

## 2. 코드 스니펫（의도）

```bash
# publish-content.sh 핵심（초안）
mapfile -t FILES < <(resolve_targets "$@")   # 인자 없으면 --all 패턴
node server/db/seed-content.mjs --check "${FILES[@]}"
for f in "${FILES[@]}"; do
  bash tools/upload-content.sh "$f" || exit 1
done
if [ "$DEPLOY" = 1 ]; then
  bash tools/trigger-chemi-deploy.sh
fi
```

Windows: **Git Bash** 에서 실행（기존 upload/trigger 와 동일）. PowerShell 네이티브 재작성은 scope 밖.

---

## 3. 수정 파일

| 경로 | 내용 |
|---|---|
| `tools/publish-content.sh` | **신규** — check → 복수 upload → 선택 deploy |
| `tools/verify-server.mjs` | publish 가 upload·trigger 만 부르는지·삭제 기능 없는지 문자열 검사（기존 送り口 이웃） |
| `STATUS.md` §5.1 | 일괄 명령 한 블록 추가 |
| （선택）`upload-content.sh` | 복수 인자 허용 — 1-2 채택 시에만 |

**건드리지 않음:** `.gitignore` 의 `server/content/` · 공개 repo 에 원고 커밋 · private CI 템플릿（이미 일괄） · DB Secrets 를 Actions 에 넣는 일（지시서⑮ 금지）.

---

## 4. 트레이드오프

| | |
|---|---|
| 좋음 | Cursor에서 고친 뒤 **한 명령**으로 반영. 기존 FTPS·seed 경로 재사용 |
| 비용 | 전량 `--all` 은 FTPS 시간이 김（30파일）. 평소는 **고친 파일만** 인자로 |
| 위험 | `--deploy` 는 앱 재기동·migrate·seed. 바쁜 시간대 주의. **삭제 기능은 계속 없음** |
| 대안（채택 안 함） | 원고를 공개 `main` 에 넣기 — 유료물·기존 금지 |
| 대안（병행 가능） | private `kstudy101-content` push — 이미 CI 있음. 「이 폴더에서」와 병행 |

---

## 5. 대표 확인이 필요한 결정

| # | 질문 | 권장 |
|---|---|---|
| D1 | 래퍼 `publish-content.sh`（1-1） vs upload 본체 확장（1-2） | **1-1** ✅ |
| D2 | 기본 `--all` 에 `_*.json` 제외? | **예** ✅ |
| D3 | `--deploy` 기본 on? | **아니오**（실수 재기동 방지）. 명시 `--deploy` ✅ |
| D4 | private repo CI를 이 작업의 본진으로 옮길까? | **아니오**（지금 워크스페이스가 `server/content/`） |

---

## 6. 구현 체크리스트（승인 후）

- [x] `tools/publish-content.sh` 작성（`--check` / `--upload` / `--deploy` / 파일 목록）
- [x] `_*.json` 기본 제외
- [x] `upload-content` — `UPLOAD_CONTENT_QUIET` 로 일괄 시 꼬리 안내 억제
- [x] `verify-server` 一括口 3항목
- [ ] Git Bash 에서 `--check` 스모크（로컬）
- [ ] 대표: 파일 2개 `--upload --deploy` 실기 → LINE/DB 반영 확인
- [x] STATUS §5.1 명령 갱신

---

## 7. 제외（scope 밖）

- 원고를 git 추적·공개 커밋
- PowerShell 전용 재작성
- seed 를 로컬 PC에서 직접（본번 DB는 cPanel env 만 — STATUS）
- cPanel File Manager UI 변경
- private content repo 신설/이전（이미 템플릿 있음）

---

## 8. 승인 후 예상 사용법

```bash
# 여러 날 고친 뒤
bash tools/publish-content.sh --check --upload --deploy \
  server/content/beginner-01-15.json \
  server/content/beginner-16-30.json
```

또는 초급만 통째로:

```bash
bash tools/publish-content.sh --check --upload --deploy server/content/beginner-*.json
```
