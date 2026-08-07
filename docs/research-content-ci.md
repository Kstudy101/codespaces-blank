# research-content-ci.md — ChemiCloud 원고 FTPS·DB 시드 CI 자동화 조사

작성: 2026-08-07 / 요청: 「git push 시 FTPS 업로드 + seed 를 deploy.yml 에 넣기」

> 이 문서는 **조사만** 한다. 구현·워크플로 추가는 [plan-content-ci.md](plan-content-ci.md) 승인 후.

관련: [plan-upload-content.md](plan-upload-content.md) · [plan-deploy-auto.md](plan-deploy-auto.md) · [STATUS.md](../STATUS.md) A0·A1·D1 · `.cpanel.yml` · `deploy-server.yml`

---

## 0. 한 줄 결론

요청을 **그대로** `deploy.yml` 에 넣으면 안 된다. 이미 있는 배치·시드 경로와 충돌하고,
원고가 저장소에 없으며, ChemiCloud 는 Actions 에서 SSH 로 `with-env` 를 돌릴 수 없다.
자동화하려면 **어느 제약을 풀지**를 대표가 먼저 골라야 한다.

---

## 1. 지금 실제로 도는 3갈래

| 경로 | 워크플로/파일 | 하는 일 | 원고(`content/`) |
|---|---|---|---|
| **사이트 (Xserver)** | `.github/workflows/deploy.yml` | 관문 19종 → `dist/` → **SSH:10022 + rsync** | 관여 없음 |
| **배신 서버 (ChemiCloud)** | `.github/workflows/deploy-server.yml` | 관문 → **cPanel UAPI** Update/Deploy | **올리지 않음** (배치가 `content/` 제외) |
| **서버 쪽 배치 스크립트** | `.cpanel.yml` | 코드 동기화 → migrate → **`seed-content` (이미 있음)** → restart | `~/kstudy101-line/content/` 가 있을 때만 |

핵심 인용 (`.cpanel.yml` 87–93행 근처):

- `content/` 디렉터리가 있으면 배치마다  
  `node db/with-env.mjs db/seed-content.mjs` 를 돌린다.
- 원고 디렉터리 자체는 rsync/`find` 제외 목록에 있어 **배포가 원고를 지우지도·올리지도 않는다**.

즉 **「DB 시드」는 이미 서버 배포 파이프라인에 들어 있다.**  
빠진 것은 「원고 파일을 서버 `content/` 에 놓는 일」뿐이다.

---

## 2. 요청문과 충돌하는 사실 5개

### 2-1 `deploy.yml` 은 ChemiCloud 용가 아니다

`deploy.yml` 머리말·Secrets 전부 **Xserver** (`XSERVER_*`, 포트 10022, `dist/` rsync).
여기에 FTPS·ChemiCloud seed 를 붙이면:

- 사이트만 고친 push 에도 원고 시드가 돈다 (또는 반대)
- 실패 시 Xserver 배포와 원인 분리가 안 된다
- 기존 주석이 「server 변경은 관문용」이라고 명시한 설계와 어긋난다

→ ChemiCloud 쪽은 이미 `deploy-server.yml` 이 담당한다.

### 2-2 원고는 GitHub checkout 에 없다

`.gitignore` 27행: `server/content/`  
이유: 유료물. push 한 번이면 이력에 남고 지워도 복구 불가 (`.gitignore` 주석과 [plan-upload-content](plan-upload-content.md) §372 동일).

Actions 가 `actions/checkout` 만 하면 **올릴 JSON 이 워크스페이스에 0개**다.
「push → FTPS」를 그대로 구현하려면 원고를 **어디에선가** runner 로 가져와야 한다 (아래 §4).

### 2-3 ChemiCloud SSH 는 Actions 에서 막혀 있다

[plan-deploy-auto.md](plan-deploy-auto.md) §1 · `deploy-server.yml` 머리말:

> ChemiCloud 가 SSH 를 IP 단위로 막고, Actions IP 는 매번 바뀐다.

따라서 Actions 안에서

```bash
ssh … 'node db/with-env.mjs db/seed-content.mjs'
```

는 **채택 불가**로 이미 기각된 후보다. 배신 배포는 그 때문에 UAPI(HTTPS 2083)로 갔다.

### 2-4 `with-env.mjs` 는 「그 서버 위」에서만 의미가 있다

`server/db/with-env.mjs` 는 `~/.cl.selector/node-selector.json` (CloudLinux Node Selector) 을 읽어
cPanel 이 앱에 넣은 `DB_*` 등을 주입한다. GitHub runner 에는 그 파일이 없다.

Runner 에서 시드하려면 별도로 **`DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` 을 Secrets 로 두고**
`seed-content.mjs` 를 직접 돌려야 한다. 그때:

- MySQL 이 **외부 IP 를 허용**해야 한다 (Actions IP 가변 → `Any Host` 또는 유동 허용 = 공격면 확대)
- 시드가 읽는 원고는 runner 로컬 `server/content/` 이어야 한다 (다시 2-2)
- 서버 디스크의 `content/` 와 DB 가 어긋날 수 있다 (파일은 옛것·DB 만 새것)

### 2-5 「올린 뒤 시드」는 지금도 두 단계다

| 단계 | 도구 | 누가 |
|---|---|---|
| 파일 배치 | `tools/upload-content.sh` (FTPS, content 전용 계정) | 로컬 / A0 계정 필요 |
| DB 반영 | `.cpanel.yml` 의 seed **또는** cPanel Terminal 에서 `with-env` | 서버 배포 시 자동 / 수동 |

FTP 만 하고 배포를 안 돌리면 **디스크만 갱신되고 DB 는 옛 원고**이다.
반대로 배포만 돌리면 **이미 있는 `content/` 를 다시 시드**한다 (upsert, 안전).

---

## 3. 이미 등록됐거나 등록 예정인 Secrets (참고)

### 3-1 Xserver (`deploy.yml`) — 사이트용. 원고와 무관

| Secret | 용도 |
|---|---|
| `XSERVER_HOST` | 예) `svXXXX.xserver.jp` |
| `XSERVER_USER` | 서버 ID |
| `XSERVER_PATH` | `…/public_html` |
| `XSERVER_SSH_KEY` | **비밀키** 전문 |
| `XSERVER_PORT` | 생략 시 10022 |

### 3-2 ChemiCloud 코드 배포 (`deploy-server.yml`) — 이미 문서화

| Secret | 용도 |
|---|---|
| `CPANEL_HOST` | 예) `sNN.chemicloud.com` |
| `CPANEL_USER` | cPanel 사용자 |
| `CPANEL_TOKEN` | API 토큰 (**계정 전권**) |

미설정 시 배포 단계만 건너뛰고 초록 (merge 안전).

### 3-3 로컬 원고 FTP (GitHub 아님 — A0)

`~/.config/kstudy101/ftp-content.conf`:

| 키 | 예 |
|---|---|
| `FTP_HOST` | `ftp.kstudy101.jp` |
| `FTP_USER` | `content@kstudy101.jp` |
| `FTP_PASS` | cPanel 생성 비밀번호 |
| `FTP_DIR` | `/` (이 계정에게 content 가 루트) |

STATUS **A0** — 계정 생성·탈출 시험이 아직 대표 실기다.  
계정이 없으면 CI 에 Secrets 를 넣어도 FTPS 가 붙을 대상이 없다.

---

## 4. 「완전 자동화」후보 (조사만 · 채택은 계획서)

| ID | 요약 | push 로 원고가 가나 | seed 는 어디서 | 유료물 위험 | ChemiCloud 제약 |
|---|---|---|---|---|---|
| **A** | 현행 유지: 로컬 FTPS → (필요 시) `deploy-server` 가 `.cpanel.yml` seed | 아니오 (의도) | 서버 `.cpanel.yml` | 낮음 | 준수 |
| **B** | 신규 `deploy-content.yml`: Secrets 의 FTPS 로 업로드 + UAPI 로 배포 트리거(→ seed) | **원고 소스가 필요** | 서버 `.cpanel.yml` | 소스에 따름 | SSH 불필요 |
| **C** | Actions 가 `DB_*` 로 원격 시드 (FTPS 생략 또는 병행) | 원고 소스 필요 | **runner** | 소스 + DB 노출 | MySQL 원격 허용 필요 |
| **D** | 원고를 공개 repo 에 커밋하고 push 연동 | 예 | B 또는 C | **최고 (기각 권고)** | — |
| **E** | 비공개 서브모듈/별도 private repo 에 원고 → Actions 가 둘 다 checkout 후 B | 예 (private) | 서버 seed | 공개 repo 에는 안 남음 | 준수 |

「요청 그대로 deploy.yml + SSH seed」는 위 표에 **없음** — 2-1·2-3 때문에 후보에서 제외.

---

## 5. `upload-content.sh` 를 CI 에서 쓰려면

현재는 `~/.config/kstudy101/ftp-content.conf` 파일만 본다.
CI 에서는 보통 Secrets → 환경변수 → 임시 conf 생성 패턴이 필요하다
(로컬과 같은: 비밀번호를 `curl --user` 명령행에 올리지 않음, `--ssl-reqd`).

조사 시점의 스크립트는 **파일 1개씩** 인자. 101일 묶음 전체 자동화 시
루프 또는 `--all` 이 필요할 수 있다 (구현은 계획 승인 후).

삭제는 의도적으로 없음 (지시서⑬) — CI 도 `DELE` 를 넣지 않는 것이 맞다.

---

## 6. 검증·관문에 미칠 영향

워크플로를 늘리거나 `deploy.yml` 을 고치면:

- `verify-server.mjs` 가 소스 문자열로 배포 도구를 검사하는 항목이 있음  
  (`upload-content` 추가 때와 같은 자리)
- CLAUDE.md 관문 목록·STATUS 배포 절 갱신
- 「관문 파일 추가 시 4곳」규칙은 **페이지**용. 워크플로 추가는
  deploy-server / CLAUDE / STATUS / 계획서 교차 링크 정도가 실무상 필요

---

## 7. 조사에서 확정한 「하지 말 것」

1. **`deploy.yml` 에 ChemiCloud FTPS/seed 를 넣지 말 것** (Xserver 파이프라인 오염)
2. **Actions → ChemiCloud SSH 로 `with-env` 를 돌리지 말 것** (이미 기각)
3. **유료 원고를 공개 `main` 에 force-add 하지 말 것** (이력 영구)
4. **승인 전 워크플로 파일을 쓰지 말 것** (CLAUDE.md 1순위)

---

## 8. 다음에 필요한 대표 결정 (계획서 §D 로 이관)

1. 자동화 범위: **A(현행+문서)** / **B(FTPS+UAPI)** / **C(원격 DB)** / **E(private 원고 repo)** 중 무엇
2. 원고를 runner 에 넣는 방법 (E 채택 시 저장소 URL·권한)
3. A0 FTP 계정 생성 일정 (B/E 의 FTPS 전제)
4. seed 트리거: 「업로드 후 `deploy-server` 수동/자동」만으로 충분한지
