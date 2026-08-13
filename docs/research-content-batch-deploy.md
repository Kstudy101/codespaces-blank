# research-content-batch-deploy — 원고 「여기 수정 → 한 번에 배포」조사

작성: 2026-08-13. 성격: **조사만**. 구현 없음.
후속: [plan-content-batch-deploy.md](plan-content-batch-deploy.md)

---

## 1. 대표가 말한 고통

콘텐츠 JSON을 많이 고칠 때:

1. 파일마다 수정  
2. cPanel에 하나씩 업로드  
3. seed  

이 루프가 너무 길다 → **로컬에서 JSON 고치고, 한 번에 올려 seed까지** 하고 싶다.

---

## 2. 이미 있는 것（다시 만들지 말 것）

| 경로 | 역할 | 한계 |
|---|---|---|
| 로컬 `server/content/*.json` | 지금 이 PC에 **전 코스 JSON 있음**（gitignore） | 공개 repo 커밋 금지（유료물） |
| `tools/upload-content.sh` | FTPS로 ChemiCloud `content/` 에 올림 | **파일 1개씩만**（「1つずつ」硬코딩） |
| `tools/trigger-chemi-deploy.sh` | UAPI Deploy HEAD → `.cpanel.yml` 이 **seed** | 업로드와 **별 명령** |
| private repo CI（`docs/content-repo-template/`） | push → 검사 → **전 JSON FTPS 루프** → deploy/seed | 원고를 **별 private repo** 에 두고 쓰는 경로. 이 Cursor 워크스페이스와는 별개 |
| `~/.config/kstudy101/ftp-content.conf` | 이 PC에 **있음**（확인 2026-08-13） | — |

즉 「한 번에」설계는 **private CI에는 이미 있고**, **이 폴더에서 손으로 돌리는 도구만 1파일 제한**입니다.

---

## 3. 왜 배포(push main)만으로는 안 되나

`.cpanel.yml` / `deploy-server` 는 `content/` 를 **복사·삭제하지 않습니다**（유일한 사본 보호）.
코드 push ≠ 원고 반영. 원고는 **FTPS →（그다음）Deploy로 seed** 가 정본 경로입니다
([plan-content-ci](plan-content-ci.md) · STATUS §5.1).

---

## 4. 지금 로컬에 있는 원고 규모（참고）

`beginner-*` / `intermediate-*` / `advanced-*` / `quiz-*-review.json` 등 약 30개.
`_days-data.json` · `_tips.json` · `_week*` 등은 **빌드·스냅샷** — seed 대상이 아닐 수 있음
（`seed-content` 가 content/ 를 훑을 때 「원고가 아닌 JSON」 skip 로직 있음）.

---

## 5. 결론（계획으로 넘길 것）

| 하고 싶은 일 | 최소 변경 |
|---|---|
| 여기서 JSON 수정 | **이미 가능**（`server/content/`） |
| 한 번에 업로드 | `upload-content.sh` 를 **복수·디렉터리·`--all`** 지원 |
| 한 번에 seed | 업로드 뒤 `trigger-chemi-deploy.sh` 를 **같은 명령에 묶기**（또는 `--and-deploy`） |
| 공개 repo에 원고 커밋 | **하지 않음**（기존 결정 유지） |

상세·트레이드오프·체크리스트 → [plan-content-batch-deploy.md](plan-content-batch-deploy.md).
