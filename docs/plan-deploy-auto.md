# plan-deploy-auto.md — 배신 서버 배포의 자동화

작성: 2026-08-05 / 지시: 대표님 (「앞으로 자동으로」) / 기준 커밋: `7cac9a9`

> **상태: 지시에 따라 구현. 활성화는 대표님의 Secrets 등록 1회가 필요 (§4).**
> 등록 전까지 워크플로는 「미설정 — 수동 유지」로 조용히 지나갑니다. 무해.

---

## 0. 뒤집는 결정

[tools/deploy-server.sh](../tools/deploy-server.sh) 머리말은 「배신 시스템은 누른 사람이
결과를 지켜보는 것」이라며 **의도적으로 손배포**였습니다. 대표님 지시(2026-08-05)로
자동으로 전환합니다. README 결정 로그에 같은 커밋에서 갱신 — 로그와 코드가
어긋난 채 두지 않습니다. 수동 경로 2가지(cPanel 화면·deploy-server.sh)는
**대체 수단으로 그대로 남습니다.**

## 1. 왜 이 방식인가 (제약이 경로를 정합니다)

| 후보 | 판정 |
|---|---|
| GitHub Actions → SSH | **불가** — ChemiCloud 가 SSH 를 IP 단위로 막고, Actions 의 IP 는 매번 바뀜 ([tools/cpanel.sh](../tools/cpanel.sh) 머리말) |
| 서버 cron 이 주기적으로 pull | 가능하지만 push 와 무관하게 N 분마다 돌고, 문서만 고친 push 에도 재기동이 걸림 |
| **Actions → cPanel UAPI (HTTPS 2083)** | **채택** — 2083 은 열려 있고 정규 증명서로 붙음(이미 `tools/cpanel.sh` 가 쓰는 길). 화면의 Update from Remote → Deploy HEAD 와 **같은 API** 를 부름 |

## 2. 동작 — `.github/workflows/deploy-server.yml` (신규)

```
push (main, server/**·.cpanel.yml·운세엔진 3파일이 바뀐 때만)   또는 수동 버튼(workflow_dispatch)
  → 관문 19종 전부                        ← 하나라도 실패하면 배포 없음
  → UAPI VersionControl::retrieve         ← repository_root 를 이름으로 찾음 (결정타 없음)
  → UAPI VersionControl::update           ← 화면의 "Update from Remote"
  → UAPI VersionControlDeployment::create ← 화면의 "Deploy HEAD Commit"
  → 완료를 API 로 폴링 (UI 의 in progress 는 믿지 않는다 — STATUS §9.2 의 교훈)
  → 실패 시 배포 로그 말미를 Actions 로그에 그대로 출력 (Fileman::get_file_content)
  → https://api.kstudy101.jp/health 이 ok 인지
```

- 문서·사이트만 바뀐 push 에는 **돌지 않습니다** (paths 필터) — 재기동 낭비 없음
- `workflow_dispatch` 수동 버튼이 **화면의 Deploy 버튼 대체품**이 됩니다 —
  지금 화면이 말을 안 들어도 Actions 탭에서 누르면 같은 일이 됩니다
- Secrets 미설정이면 배포 단계를 건너뛰고 초록으로 끝납니다 (merge 안전)

## 3. 트레이드오프 — 눈 뜨고 받아들이는 것

- **cPanel API 토큰은 계정 전권입니다** (`tools/cpanel.sh` 머리말: 유출 = 비밀번호).
  GitHub Secrets 는 로그에 마스킹되고 fork 의 PR 에는 전달되지 않지만,
  저장소 설정에 쓰기 권한이 있는 사람은 워크플로를 통해 쓸 수 있습니다.
  이 저장소는 대표님 단독 운영이라 수용
- **「지켜보는 사람」이 없어집니다** — 대신 실패는 Actions 가 붉게 표시하고
  메일이 갑니다. 배포 로그 말미도 Actions 로그로 끌어옵니다
- migration 이 포함된 push 도 자동으로 흐릅니다 — **되돌릴 수 없는 SQL 을 쓸 때는
  push 전에 DB 백업**이 이제 유일한 안전선입니다 (STATUS §5 에 명기)

## 4. 활성화 — 대표님 1회 작업

1. cPanel → **Security → Manage API Tokens** → Create (이름 예: `gh-deploy`, 만료 무제한)
   → 표시된 토큰을 복사 (다시 안 보여줍니다)
2. GitHub 저장소 → **Settings → Secrets and variables → Actions** → New repository secret 3개:

| 이름 | 값 |
|---|---|
| `CPANEL_HOST` | 예) `sNN.chemicloud.com` (cPanel 주소의 호스트) |
| `CPANEL_USER` | cPanel 사용자명 |
| `CPANEL_TOKEN` | 1 에서 복사한 토큰 |

3. Actions 탭 → `deploy-server` → **Run workflow** (첫 실행 = 밀린 커밋들 배포 + §5 진단)

## 5. 「Deploy HEAD Commit 안 됨」과의 관계

유력 원인은 **지난번 UI 멈춤의 잔재** — cPanel 은 저장소당 배포 1건만 허용하는데,
「in progress」로 남은 기록이 새 배포를 막고 있을 가능성. 이 워크플로는 화면을
거치지 않고 API 로 직접 만들므로, 첫 실행에서

- 성공하면 → 화면만의 문제였음 (이후로는 화면을 볼 일 자체가 없음)
- 실패하면 → **cPanel 이 돌려준 에러 문구가 Actions 로그에 그대로** 찍혀 원인 확정

## 6. 수정 파일

| 경로 | 변경 |
|---|---|
| `.github/workflows/deploy-server.yml` | **신규** |
| `tools/deploy-server.sh` | 머리말에 「자동화로 전환(2026-08-05), 이 스크립트는 대체 수단」 |
| `README.md` | 결정 로그에 전환 기록 |
| `STATUS.md` | §5 배포 경로에 (자동) 추가, 백업 안전선 명기 |
