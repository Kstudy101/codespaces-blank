# plan-deploy-server.md — `server/` 를 브라우저만으로 배포한다

작성: 2026-08-04 / 대상 커밋: `da5abfd` (main) / 실행: **대표님(브라우저)**

> **상태: 배포 완료 (2026-08-04, 커밋 `660915a`). S6(cron)만 미확인.**
> 도중에 `npm ci` 사고 1건 — 경위와 수정은 [plan-deploy-hang.md](plan-deploy-hang.md).
> 결과 기록은 [STATUS.md](../STATUS.md) §9.2.

---

## 0. 범위

| 넣는 것 | 넣지 않는 것 (이유는 §5) |
|---|---|
| `server/` 를 ChemiCloud 에 배포 | 결제 잠금 해제 (값 3개 미정 — STATUS §3) |
| DB 마이그레이션 (002 포함) | 원고 입고 (`content/`) |
| cron 등록 확인 | 퀴즈 배신 구현 |
| 배포 후 확인 | 사이트 본체 (별도 경로, 이미 가동 중) |

**코드는 한 줄도 바꾸지 않습니다.** 이미 있는 것을 서버에 올리는 작업입니다.

---

## 1. 왜 브라우저 경로인가

배포 경로는 두 가지인데, 지금 기기에서는 **(가)만 가능합니다.**

| 경로 | 필요한 것 | 이 기기 |
|---|---|---|
| (가) cPanel Git Version Control | 브라우저 + cPanel 로그인 | **가능** |
| (나) `tools/deploy-server.sh` | `~/.config/kstudy101/chemicloud.conf` + `~/.ssh/chemicloud` | 디렉터리 자체가 없음 |

게다가 [tools/cpanel.sh](../tools/cpanel.sh) 머리말에 따르면 ChemiCloud 는 SSH 포트를 IP 단위로
막습니다. 자격정보를 놓아도 이 기기에서 (나)가 될 보장이 없습니다.

**두 경로가 실행하는 내용은 같습니다.** (가)는 [.cpanel.yml](../.cpanel.yml) 의 `tasks` 를,
(나)는 rsync + ssh 를 씁니다. 제외 목록·순서가 동일하도록 맞춰져 있습니다(§2).

---

## 2. 사전 점검 — 끝났습니다 (2026-08-04)

자격정보 없이 확인 가능한 것은 전부 확인했고, **네 건 모두 정상**입니다.

**① 제외 목록 7개가 세 경로에서 일치** — 가장 위험한 항목입니다.

```
node_modules  .env  .env.local  content  tmp  public  stderr.log
```

- [tools/deploy-server.sh:113-114](../tools/deploy-server.sh#L113-L114) — rsync
- [.cpanel.yml](../.cpanel.yml) — rsync 분기
- [.cpanel.yml](../.cpanel.yml) — find 분기 (이 서버엔 rsync 가 없어 실제로는 이쪽이 돕니다)

`server/content/`(101일 원고)는 **서버에만 있는 유일한 사본**입니다. 세 곳 중 하나라도
빠지면 배포가 원고를 지우고, 알아차리는 건 다음 날 아침 배신이 멈춘 뒤입니다.

**② 되돌릴 수 없는 SQL 의 순서가 정상**

`server/db/migrations/002-per-course-billing.sql`:

```
L80   INSERT IGNORE INTO course_entitlements (user_id, track, days_entitled)  ← 데이터 대피
        SELECT ...
L126  ALTER TABLE subscriptions DROP COLUMN total_days_entitled;              ← 삭제
```

대피가 삭제보다 앞에 있고, `migrate.mjs` 가 표·열의 존재를 이름으로 다시 세므로
대피가 실패하면 그 앞에서 멈춥니다. **그래도 S0 을 하십시오** — 순서가 맞다는 것과
데이터가 무사하다는 것은 다른 이야기입니다.

**③ 재기동이 마이그레이션보다 뒤** — `.cpanel.yml` 에서 `migrate` → `seed` → `restart.txt`
순입니다. 마이그레이션이 실패하면 옛 코드가 계속 돕니다(새 코드가 옛 표를 향해
도는 것보다 안전).

**④ 부작용 없음** — `smoke` / `who` / `push --dry-run` 은 `~/.run-*` 표시 파일이 있을 때만
돕니다. 기본 배포에서는 아무에게도 보내지 않습니다. `content/` 가 없으면 seed 도 건너뜁니다.

---

## 3. 실행 순서

각 단계를 끝내면 `[x]` 로 바꿔 주십시오.

### S0. DB 백업 ★ 건너뛰지 말 것

- [ ] cPanel → **Setup Node.js App** → 앱(`kstudy101-line`) → Environment variables →
      **`DB_NAME` 값을 적어 둡니다** (본번 DB 이름의 유일한 출처)
- [ ] cPanel → **phpMyAdmin** → 왼쪽에서 그 DB 선택 → **Export** → Go → `.sql` 저장
      (또는 cPanel → **Backup Wizard** → Download a MySQL Database Backup)
- [ ] 받은 파일의 **크기가 0이 아닌지** 확인

> 이 시점의 DB 가 `DROP COLUMN` 전의 마지막 상태입니다.

### S1. 환경변수 확인 — 없으면 앱이 안 올라옵니다

`server/app.mjs:343` 이 기동 시 5개를 확인하고, 하나라도 없으면 `process.exit(1)` 합니다.

- [ ] cPanel → Setup Node.js App → Environment variables 에 아래가 **전부** 있는지:

| 변수 | 없으면 |
|---|---|
| `LINE_CHANNEL_SECRET` | 기동 실패 |
| `DB_HOST` `DB_USER` `DB_PASSWORD` `DB_NAME` | 기동 실패 |

- [ ] (선택) LINE 로그인 연동을 쓰려면 `LINE_LOGIN_CHANNEL_ID` / `_SECRET` / `_REDIRECT_URI`
- [ ] `TOKUSHOHO_URL` / `REFUND_POLICY` / `RICHMENU_IMAGE` 는 **지금 비워 둡니다** —
      비어 있으면 가격표가 안 나오고 「준비중」으로 답합니다. 의도된 잠금입니다(STATUS §3)

### S2. 원격에서 가져오기

- [ ] cPanel → **Git™ Version Control** → 해당 저장소 → **Update from Remote**
- [ ] 가져온 커밋이 `da5abfd` (또는 그 이후)인지 확인

> 이 배포는 GitHub `main` 을 가져옵니다. 제 기기의 미커밋 변경(`CLAUDE-karpathy.md`)은
> 포함되지 않으며, `server/` 와 무관하므로 문제 없습니다.

### S3. 배포

- [ ] 같은 화면에서 **Deploy HEAD Commit**
- [ ] 화면의 로그가 마지막에 `OK - 配置と再起動要求まで終わりました` 로 끝나는지

`.cpanel.yml` 이 자동으로 하는 일: 코드 배치 → 운세엔진(`saju.js`/`fortune.js`/
`solar-terms.json`) 복사 → `npm install` → **`migrate`** → (content 있으면) seed → 재기동 요구.

> **결과 (2026-08-04):** S0·S1 완료 → 첫 Deploy 는 `npm ci` 사고로 실패
> ([plan-deploy-hang.md](plan-deploy-hang.md)) → 서버 복구 후 `660915a` 로 재배포 성공.
> S4 는 stdout 대신 증거로 판정: `tmp/restart.txt` 갱신 = 12개 작업 전부 통과 =
> migrate 종료코드 0 = 스키마 검증 통과 (migrate 는 `✓` 일 때만 0 을 반환).
> S5 `/health` → `ok`. **원고 수량(`beginner NN`)만 미실측** — STATUS §6.
> **cPanel UI 의 in progress 표시는 멈춘 채였음** — 판정은 restart.txt 로 할 것.

### S4. 마이그레이션 결과 읽기

S3 의 로그 안에 `migrate.mjs` 출력이 있습니다. 이렇게 끝나야 합니다:

```
✓ スキーマは想定どおりです
```

- [ ] 위 줄을 확인. `✗ N 件の問題があります` 면 **S5 로 가지 말고** §4 로

로그에서 같이 볼 것:

```
  ✓ quiz_checkpoints: 30, 50, 75
  · content_templates: beginner NN / intermediate 0 / advanced 0
```

`beginner` 가 50 근처면 정상(원고 미완 — STATUS §6). **0 이면 원고가 사라진 것이므로 §4.**

### S5. 살아 있는지 확인

- [ ] 브라우저에서 https://api.kstudy101.jp/health → **`ok`** (200)

`503 db unavailable` 이면 프로세스는 떴는데 DB 를 못 봅니다 → S1 의 `DB_*` 4개를 재확인.

### S6. cron 확인

- [ ] cPanel → **Cron Jobs** → 목록에 **두 줄**이 있는지 확인:

```
0 * * * * /bin/bash ~/kstudy101-line/db/push-cron.sh morning >> ~/logs/push.log 2>&1
0 * * * * /bin/bash ~/kstudy101-line/db/push-cron.sh evening >> ~/logs/push.log 2>&1
```

- [ ] 없으면 위 두 줄을 그대로 추가 (Add New Cron Job, Common Settings → Once Per Hour)
- [ ] `~/logs/` 디렉터리가 있는지 — 없으면 cPanel File Manager 로 만듭니다
      (없으면 리다이렉트가 실패해 기록이 안 남습니다)

**시각이 매시 0분인 것은 맞습니다.** 몇 시에 보낼지는 각 배치가 일본시간을 보고
정합니다(`--not-before=7` / `--not-before=18`). 빌린 서버의 지방시는 이설·서머타임으로
조용히 어긋나므로 cron 에 시각을 박지 않습니다.

**cron 행에 `node` 를 직접 쓰지 마십시오.** Node 판올림 때 배신만 조용히 멈춥니다 —
안 온다는 걸 알아차릴 수 있는 건 받는 쪽뿐이고, 그쪽은 「오늘은 안 오네」라고만 생각합니다.

### S7. 마무리

- [ ] `STATUS.md` §0 의 「LINE 배신 서버는 코드는 완성, 아직 배포 안 함」 갱신
- [ ] `STATUS.md` §9.1 에 이번 배포 기록 추가

> S7 은 제가 하겠습니다. S5 까지 끝나면 결과를 알려 주십시오.

---

## 4. 실패했을 때

| 증상 | 원인 | 대응 |
|---|---|---|
| `NG - $APP がありません` | Node 앱 미생성 | cPanel → Setup Node.js App → CREATE APPLICATION (root `kstudy101-line`, URL `api.kstudy101.jp`, startup `app.js`, Node 20+) |
| `NG - nodevenv がありません` | 같은 원인 | 위와 동일 |
| `migrate` 가 `✗` | 표/열 부족 | 로그가 **무엇이 없는지 이름으로** 말합니다. 그 이름을 알려 주십시오 |
| `content_templates: beginner 0` | 원고 소실 | **즉시 멈추십시오.** 재배포하면 안 됩니다. 알려 주십시오 |
| `/health` 가 503 | DB 미연결 | S1 의 `DB_*` 4개 재확인 |
| `/health` 가 무응답 | 기동 실패 | cPanel File Manager → `~/kstudy101-line/stderr.log` 마지막 부분 |

**되돌리기:** 코드는 Git Version Control 에서 이전 커밋을 Deploy 하면 됩니다.
**DB 는 되돌아가지 않습니다** — S0 의 백업을 phpMyAdmin → Import 로 복원하는 것이 유일합니다.

---

## 5. 트레이드오프 / 제외한 것

**결제를 같이 열지 않는 이유** — 값 3개(`TOKUSHOHO_URL`/`REFUND_POLICY`/`RICHMENU_IMAGE`)가
정해지지 않았습니다. 특히 `TOKUSHOHO_URL` 은 법인이 아니면 본명·자택주소·전화번호가
공개되는 문제라 대표님 판단입니다. **먼저 배포해 두면, 값이 정해졌을 때 환경변수만
넣고 재기동하면 열립니다** — 다시 배포할 필요가 없습니다.

**smoke 를 안 돌리는 이유** — 본번 DB 에 실제로 쓰고 지웁니다. 전용 시험 1건만 건드리고
전후로 지우므로 본번에서도 돌릴 수 있게 만들어 뒀지만, 배포마다 쓸 이유는 없습니다.
돌리고 싶으면 File Manager 로 `~/.run-smoke` 를 만든 뒤 재배포하면 1회만 돌고 자동 삭제됩니다.

**원고를 이번에 안 올리는 이유** — `content/` 는 유료물이라 저장소에 없습니다. 배포 경로가
`content` 를 제외하므로 서버의 기존 원고는 그대로 남습니다. 원고 입고는
[plan-p4-content.md](plan-p4-content.md) 의 범위입니다.

**GitHub Actions 에 태우지 않는 이유** — [tools/deploy-server.sh](../tools/deploy-server.sh) 머리말대로,
배신 시스템은 「누른 사람이 결과를 지켜보는」 것으로 두었습니다. push 마다 본번 배신
서버가 바뀌는 것은 사고를 내는 방법으로 너무 조용합니다.

---

## 6. 수정될 파일

**없습니다.** 이 작업은 배포이며, 저장소의 파일은 바뀌지 않습니다.
S7 에서 `STATUS.md` 만 사실에 맞게 갱신합니다.
