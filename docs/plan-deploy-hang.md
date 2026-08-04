# plan-deploy-hang.md — 배포가 멈추는 원인과 대책

작성: 2026-08-04 / 관련: [plan-deploy-server.md](plan-deploy-server.md) / 기준 커밋: `da5abfd`

> **상태: 종결 (2026-08-04).** §2 구현(`660915a`) 후 재배포 성공 — 태스크 큐 기준 10초.
> §4(관측성)는 미승인 그대로, 배포가 10초에 끝나는 것이 확인됐으므로 필요성도 내려감.
>
> **결말 정정:** 「20분 멈춤」의 정체는 두 가지가 겹친 것이었다.
> ① 첫 배포는 `npm ci` 가 Selector 의 symlink 를 파괴하며 실패 (이 문서 §1 — 사실).
> ② 「in progress」가 계속 떠 있던 것은 **cPanel UI 표시 고장** — 재배포는 서버측에서
> 10초 만에 Task finished 였는데 화면은 계속 in progress 였다. 앞으로 배포 판정은
> 화면이 아니라 `tmp/restart.txt` 수정 시각으로 한다 (STATUS §9.2).

---

## 1. 원인 — 확정

CloudLinux Node.js Selector 의 에러 문면이 그대로 말해 줍니다.

```
Cloudlinux NodeJS Selector demands to store node modules for application
in separate folder (virtual environment) pointed by symlink called
"node_modules". That's why application should not contain folder/file
with such name in application root
```

Selector 는 `~/kstudy101-line/node_modules` 가 **심볼릭 링크**이기를 요구합니다.
실체는 `~/nodevenv/kstudy101-line/<판>/lib/node_modules` 에 있고, 앱 루트에는
그리로 가는 링크만 있어야 합니다. **지금 거기에 실제 디렉터리가 있습니다.**

### 무엇이 링크를 없앴는가

[.cpanel.yml:68](../.cpanel.yml#L68):

```bash
npm ci --omit=dev
```

**`npm ci` 는 정의상 `node_modules` 를 통째로 지우고 다시 만듭니다.**
지워지는 대상이 Selector 의 심볼릭 링크이고, 다시 만들어지는 것은 평범한
디렉터리입니다. 한 번 돌린 것만으로 가상환경과의 연결이 끊어집니다.

이건 이미 알고 있던 함정이었습니다. [tools/deploy-server.sh:63-66](../tools/deploy-server.sh#L63-L66) 머리말:

> 素の npm install を叩くと実体の方を壊すので、必ず activate を通してから叩く

`activate` 를 통과시키는 것까지는 맞게 했는데, **`ci` 와 `install` 의 차이가
남아 있었습니다.** activate 는 「어느 node/npm 을 쓰는가」를 정할 뿐,
`npm ci` 가 `node_modules` 를 지우는 것 자체는 막지 못합니다.

### 20분 멈춘 것과의 관계

첫 배포에서 `npm ci` 가 링크를 지우고 실체 쪽에 쓰기 시작했을 때,
가상환경의 구조가 깨진 상태로 설치가 진행됐습니다. 멈춘 자리가 정확히
어디인지는 로그를 못 봐서 단정하지 않습니다. **다만 `npm ci` 가
이 서버에서 절대 돌면 안 되는 명령이라는 것은 에러 문면으로 확정입니다.**

> 앞서 세운 「MySQL 메타데이터 락」 가설은 틀렸습니다. `PROCESSLIST` 에
> 대기 중인 것이 없었고, 원인이 npm 쪽으로 확정됐습니다.

---

## 2. 고칠 곳 — 2개 파일, 양쪽 경로

**한쪽만 고치면 안 됩니다.** 어느 경로로 배포했느냐에 따라 결과가 갈리고,
그 차이는 다음 배포 때까지 드러나지 않습니다.

### 2-1. [.cpanel.yml:68](../.cpanel.yml#L68) — 경로 (가)

```diff
- - /bin/bash -lc 'set -e; . "$ACT"; cd "$APP"; echo "node $(node -v) / npm $(npm -v)"; npm ci --omit=dev'
+ # npm ci は node_modules を消して作り直す。ここでは消えるのが
+ # Selector の symlink（~/nodevenv/ 側が実体）なので、1 度でも走ると
+ # 仮想環境との繋がりが切れ、cPanel の画面からも直せなくなる。
+ # install は既にある node_modules の中身を更新するだけで、symlink を消さない。
+ - /bin/bash -lc 'set -e; . "$ACT"; cd "$APP"; echo "node $(node -v) / npm $(npm -v)"; npm install --omit=dev'
```

### 2-2. [tools/deploy-server.sh:130](../tools/deploy-server.sh#L130) — 경로 (나)

```diff
-  npm ci --omit=dev 2>&1 | tail -3
+  npm install --omit=dev 2>&1 | tail -3
```

지금 이 기기에서는 (나)를 못 쓰지만, **자격정보가 있는 기기에서 돌면 같은
사고가 납니다.** 같은 커밋에서 고칩니다.

### 2-3. 머리말 갱신

`tools/deploy-server.sh` 머리말의 「activate 를 통과시켜라」에
**「그리고 `ci` 가 아니라 `install`」** 을 한 줄 더합니다. 이유를 남기지 않으면
다음에 누군가 「lockfile 대로 깔려야 하니 `ci` 가 맞다」며 되돌립니다.

---

## 3. 서버 쪽 복구 — 대표님(브라우저), 코드 수정과 별개

**이미 깨진 `node_modules` 는 코드를 고쳐도 저절로 낫지 않습니다.**
순서대로 해 주십시오.

- [x] **S1.** cPanel → **File Manager** → `~/kstudy101-line/` 로 이동
- [x] **S2.** `node_modules` 가 **폴더**인지 확인 (링크면 아이콘·크기가 다르게 보입니다)
- [x] **S3.** 그 `node_modules` 를 **삭제** — 실체는 `~/nodevenv/` 쪽에 있으므로 여기 것은 지워도 됩니다
- [x] **S4.** cPanel → **Setup Node.js App** → 앱 → **Restart** (또는 Save)
      → Selector 가 심볼릭 링크를 다시 만듭니다
- [x] **S5.** File Manager 에서 `node_modules` 가 이번엔 **링크**로 보이는지 확인
- [x] **S6.** **Run NPM Install** → 이번엔 에러 없이 끝나야 합니다 — **2026-08-04 성공**

**S6 까지 통과하면 §2 를 구현한 뒤 배포를 다시 시도합니다.**

S3 에서 지우는 것이 불안하시면, 삭제 대신 `node_modules_broken` 으로
**이름만 바꾸셔도** 됩니다 — Selector 는 그 이름을 보지 않습니다.
확인 후 지우면 됩니다.

---

## 4. 같이 넣을 것 — 관측성 (별건, 판단 필요)

이번 일에서 제일 비쌌던 것은 원인 자체가 아니라 **어디서 멈췄는지 20분 동안
알 수 없었던 것**입니다. `.cpanel.yml` 은 12개 작업 사이에 아무것도 출력하지 않습니다.

```diff
+ - echo "▶ [1/12] 送り先を確認"
  - test -d "$APP" || (...)
+ - echo "▶ [2/12] コードを配置"
  - if [ -n "$RSYNC" ]; then ... fi
+ - echo "▶ [3/12] 運勢エンジンを複写"
  ...
```

그리고 오래 걸리는 2개에 상한을 둡니다. **지금은 상한이 없어서 cPanel 이
죽일 때까지 매달립니다:**

```diff
- - /bin/bash -lc 'set -e; . "$ACT"; cd "$APP"; ...; npm install --omit=dev'
+ - /bin/bash -lc 'set -e; . "$ACT"; cd "$APP"; ...; timeout 600 npm install --omit=dev'

- - /bin/bash -lc 'set -e; . "$ACT"; cd "$APP"; node db/with-env.mjs db/migrate.mjs'
+ - /bin/bash -lc 'set -e; . "$ACT"; cd "$APP"; timeout 300 node db/with-env.mjs db/migrate.mjs'
```

> **위험:** 이 서버엔 `rsync` 가 없었습니다(`.cpanel.yml` 주석). `timeout` 도
> 없을 수 있습니다. 없는데 쓰면 `command not found` 로 배포가 **더 일찍**
> 깨집니다. `command -v timeout` 으로 감싸거나, §3-S6 이 끝난 뒤 Terminal 에서
> 한 번 확인하고 넣는 편이 안전합니다.

**넣을지 말지는 대표님 판단입니다.** §2만 고치면 이번 문제는 풀립니다.
§4는 다음에 다른 이유로 멈췄을 때를 위한 것입니다.

---

## 5. 제외 (scope 밖)

| 제외 | 이유 |
|---|---|
| `migrate.mjs` 의 `lock_wait_timeout` | 앞서 세운 락 가설이 **틀렸습니다.** 아닌 것으로 밝혀진 문제에 대비 코드를 넣으면 diff 만 늘어납니다 |
| `package-lock.json` 손대기 | 이번 원인과 무관 |
| 배포를 GitHub Actions 로 옮기기 | 의도적으로 손배포입니다([deploy-server.sh](../tools/deploy-server.sh) 머리말) |
| 결제 잠금 해제 | 값 3개 미정 (STATUS §3) |

---

## 6. 트레이드오프 — `ci` 를 버리는 대가

| | `npm ci` | `npm install` |
|---|---|---|
| lockfile | 그대로 재현 | 대체로 따르지만, `package.json` 과 어긋나면 **갱신할 수 있음** |
| `node_modules` | **통째로 삭제 후 재생성** | 기존 것을 갱신 |
| 이 서버에서 | **못 씀** (Selector 파괴) | 정상 |

의존이 `mysql2` 하나뿐이라 드리프트 위험은 작지만 **0은 아닙니다** —
`^3.11.0` 이라 마이너·패치가 올라갈 수 있습니다. 그래도 **돌지 않는 `ci` 보다
도는 `install` 이 낫습니다.** 재현성이 꼭 필요해지면 그때 `mysql2` 를 정확한
판으로 고정(`3.11.0`)하는 쪽이, `ci` 를 되살리는 것보다 안전합니다.

---

## 7. 검증

구현 후:

- [x] 관문 17종 전부 PASS — **17/17 (2026-08-04)**
- [x] `.cpanel.yml` 과 `deploy-server.sh` 의 npm 명령이 **동일**한지 눈으로 대조 —
      양쪽 다 `npm install --omit=dev`
- [x] 제외 목록 7개가 여전히 세 경로에서 동일한지 — 이번 변경은 npm 행만 건드렸고 제외 목록은 그대로

---

## 8. 수정될 파일

| 경로 | 변경 |
|---|---|
| `.cpanel.yml` | `npm ci` → `npm install` (+ §4 채택 시 표시·timeout) |
| `tools/deploy-server.sh` | `npm ci` → `npm install`, 머리말 1줄 |
| `docs/plan-deploy-server.md` | §3 S3 설명의 `npm ci` 표기 수정 |
| `STATUS.md` | (배포 성공 후) §0·§9.1 갱신 |
