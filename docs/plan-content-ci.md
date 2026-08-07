# plan-content-ci.md — 원고 업로드·DB 시드의 완전 자동화

> 2026-08-07 대표 지시. **상태: 승인 대기 — 코드(워크플로) 미작성.**
> 관련: [plan-upload-content.md](plan-upload-content.md) · [plan-deploy-auto.md](plan-deploy-auto.md) · [STATUS.md](../STATUS.md) §1·§5

---

## 0. 결론 3줄

1. **DB 시드는 이미 자동입니다.** `.cpanel.yml` 93행이 배포마다 `node db/with-env.mjs db/seed-content.mjs` 를 돌리고, 그 배포는 `deploy-server.yml` 이 push 때 자동으로 겁니다. 요청 1의 절반은 **이미 있습니다** — 같은 것을 `deploy.yml` 에 또 쓰면 중복 경로가 됩니다.
2. **막혀 있는 것은 FTPS 쪽입니다.** 원고는 `.gitignore` 로 저장소에 없습니다(유료물·공개 저장소). **GitHub Actions 는 저장소에 없는 파일을 올릴 수 없습니다.** 이건 제가 가정으로 넘길 수 있는 종류가 아닙니다 — §1-2.
3. 그래서 갈래가 셋입니다(§2). **(나) 비공개 원고 저장소**를 고르시면 완전 자동화가 성립하고, 워크플로 전문은 §3 에 이미 써 두었습니다. 승인만 하시면 그대로 넣습니다.

---

## 1. 실측 — 지시하신 그대로는 왜 안 되는가

### 1-1 DB 시드는 이미 자동입니다 (요청 1의 후반)

```
push (server/**) → deploy-server.yml → cPanel UAPI → .cpanel.yml
                                                       ├ npm install
                                                       ├ db/migrate.mjs
                                                       ├ db/seed-content.mjs   ← 여기
                                                       └ tmp/restart.txt
```

`.cpanel.yml:93` — `if [ -d "$APP/content" ]; then … node db/with-env.mjs db/seed-content.mjs; fi`

**시드를 CI 에서 직접 부를 방법은 없습니다.** cPanel UAPI 에는 임의 셸을 실행하는 API 가 없고
(그래서 `tools/cpanel.sh` 가 cron 만 API2 로 우회합니다), SSH 는 ChemiCloud 가 IP 로 막습니다
— Actions 의 IP 는 매번 바뀌므로 열어도 다음 날 닫힙니다(`deploy-server.yml` 머리말 9~11행).

**따라서 「CI 에서 시드」 = 「배포를 한 번 걸어 `.cpanel.yml` 의 시드 단계를 태우기」입니다.**
그 길은 이미 있고, 이 계획이 할 일은 **업로드 뒤에 그것을 깨우는 것**뿐입니다.

### 1-2 ★ 원고가 저장소에 없습니다 — 이것이 진짜 장벽

`.gitignore` 의 문장을 그대로 옮깁니다.

> このリポジトリは公開なので、ここに置くと有料で配るものが
> そのまま誰でも取れる状態になる。**1 度でも push すれば履歴に残り、
> あとから消しても取り返せない** ── .env と同じ性質のもの。

Actions 러너는 **체크아웃한 것만** 봅니다. 그러므로 선택지는 둘 중 하나뿐입니다.

| | 결과 |
|---|---|
| 원고를 이 저장소에 커밋한다 | 유료물이 영구 공개. **되돌릴 수 없습니다** |
| 커밋하지 않는다 | CI 에 올릴 파일이 없습니다 |

세 번째 길이 §2-(나) 입니다 — **원고를 비공개 저장소에 두고 CI 가 빌려오는 것.**

### 1-3 FTP 계정이 아직 없습니다 (A0)

지시서⑬의 계정 생성·탈출 시험(`../.env` 가 거부되는지)이 **아직 안 끝났습니다.**
탈출 시험 전에 CI 에 비밀번호를 넣으면, **범위가 안 잠긴 계정을 자동화에 물리는 것**이 됩니다.
자동화의 착수 조건은 A0 입니다.

### 1-4 지시서⑬ §7 이 이걸 「설계」라고 못박았습니다

> | 못 하는 일 | 계정 |
> | DB 조회·투입(`seed-content`) | cPanel Terminal |
>
> **이것이 한계가 아니라 설계입니다.** 원고를 올리는 도구는 원고만 올릴 수 있어야 합니다.

이번 지시는 그 결정을 **뒤집는 쪽**입니다. 뒤집으실 수 있지만, 뒤집는 것임을 적어 둡니다
(§2-3 의 삭제 기능 금지와 같은 계열의 결정이었습니다).

### 1-5 JST 18시 규칙의 방어가 사라집니다

STATUS §8-9 — 원고 재배치는 **저녁 배치(JST 18시) 전에** 끝내야 합니다.
저녁 복습의 답은 「こたえを見る」를 누른 순간 다시 계산되므로, 발송과 탭 사이에 원고를 갈아끼우면
**문제와 답이 어긋납니다. 방어 코드는 없고, 이 운용 규칙이 유일한 방어입니다.**

push 시각은 사람이 고르지 않습니다. 자동화하면 19시 push 가 그대로 흘러갑니다.
→ §3 의 워크플로에 **시각 문(門)** 을 넣었습니다. 자동화가 없애는 방어를 자동화가 대신 세웁니다.

### 1-6 사람의 눈 1개는 대체할 수 없습니다

`seed-content.mjs` 가 투입 전에 **퀴즈의 정답을 문자열로 풀어서** 찍습니다. 그 주석:

> 添字を**解いた文字列**で並べる。ここを読む人間が最後の関門になる ──
> 復習クイズは無保存で、配信後に間違いへ気づく計測が無いので、入れる前のこの目視が唯一の門。

`answer:2` 를 2번 뜻으로 쓰고 3번이 정답이 되어도 **기계에는 올바르게 보입니다.**
지시서⑬ §4 도 같은 말입니다 — 「검증만은 오답 선택지를 알아보지 못합니다」.

→ §3 은 **검사를 CI 로 옮기되, 이 목록을 Actions 요약에 남기고 승인 단계를 두는 형태**로 짰습니다.

### 1-7 좋은 소식 — 입고 검사는 CI 에서 공짜로 돌아갑니다 (실측)

`node server/db/seed-content.mjs --check` 는 **DB 도 `npm install` 도 없이** 끝납니다.

- `getPool()` 안에서만 env 를 요구하고, `mysql2` 는 **동적 import** 입니다(`lib/db.mjs:38`)
- `--check` 는 DB 에 닿기 전에 `process.exit(0)` (`seed-content.mjs:165`)
- 실측: `server/node_modules` 가 없는 이 기계에서 종료코드 0

**즉 CI 가 올리기 전에 mojibake·형식·중복·차입구를 전부 잡을 수 있습니다.**
지금은 사람이 서버에서 하는 일을, 올라가기 **전에** 하게 됩니다 — 순수한 개선입니다.

---

## 2. 세 갈래

| | 내용 | 완전 자동? | 새로 필요한 것 |
|---|---|---|---|
| **(가)** | 현행 유지 — 사람이 `upload-content.sh` 로 올리고, 시드는 지금도 자동 | 아니오(업로드만 수동) | **없음** |
| **(나) 권장** | 원고를 **비공개 저장소**에 두고, CI 가 빌려와 검사→FTPS→시드 | **예** | 비공개 저장소 1개 + Secrets 4개 |
| **(다)** | 원고를 이 공개 저장소에 커밋하고 CI 가 올림 | 예 | 없음. **대신 유료물이 영구 공개** |

**(다)는 권하지 않습니다.** 되돌릴 수 없고(`git filter-repo` 로 지워도 포크·캐시·아카이브에 남습니다),
`.gitignore` 의 결정과 STATUS §6 의 「저장소에는 없음(유료물)」을 정면으로 뒤집습니다.

---

## 3. (나)안의 워크플로 전문

### 3-1 왜 `deploy.yml` 이 아니라 새 파일인가

지시는 `deploy.yml` 이었지만, 그 파일은 **Xserver(사이트 정적) 전용**입니다(STATUS §1 — 두 시스템은
배포 경로가 완전히 다릅니다). 여기에 넣으면:

- `docs/` 만 고친 push 는 `deploy.yml` 의 `paths-ignore` 로 안 돌지만, 사이트를 고친 push 마다
  **원고 업로드가 딸려 돕니다** — 관계없는 변경이 본번 원고를 건드립니다
- 사이트 배포가 실패하면 원고 업로드도 같이 빨간불이 됩니다(반대도 마찬가지)

`deploy-server.yml` 이 이미 같은 이유로 분리돼 있습니다. **`deploy-content.yml` 로 셋째를 만듭니다.**
정 원하시면 `deploy.yml` 안의 job 으로 넣을 수 있습니다 — 그 경우 위 두 가지를 받아들이는 것이 됩니다.

### 3-2 `.github/workflows/deploy-content.yml`

```yaml
# ===================================================================
# deploy-content.yml — 原稿を上げて、DB へ入れるところまで
#
# 原稿は公開リポジトリに置けない（有料物・.gitignore）。非公開の
# 原稿リポジトリから借りてきて、検査 → FTPS → 配備の順に流す。
#
# 「上げる」だけは tools/upload-content.sh を呼ぶ。ここで curl を
# 書き直すと、関門 9 項目（平文禁止・パスワード非表示・削除なし・
# 大きさ照合）が CI の経路には効かなくなる ── 同じことをする道が
# 2 本になった時点で、片方だけ直る日が来る。
#
# DB へ入れるのは .cpanel.yml の seed 段。UAPI に任意のシェルを
# 実行する口が無く、SSH は IP で塞がれているため、配備を 1 度
# 起こすのが唯一の道（deploy-server.yml を起動する）。
# ===================================================================
name: deploy-content

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: '送らず、何が上がるかだけ表示する'
        type: boolean
        default: true
      force_evening:
        description: 'JST 17〜22 時の門を越える（緊急時のみ）'
        type: boolean
        default: false
  # 原稿リポジトリ側が push のたびにこちらを叩く（あちらに 3 行）
  repository_dispatch:
    types: [content-updated]

concurrency:
  group: deploy-content       # 原稿の入れ替えが重ならないように
  cancel-in-progress: false

jobs:
  upload:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      actions: write          # 最後に deploy-server を起こすため
    steps:
      - uses: actions/checkout@v4

      # --- 原稿を借りる（非公開リポジトリ）--------------------------
      - name: 原稿を借りる
        uses: actions/checkout@v4
        with:
          repository: ${{ secrets.CONTENT_REPO }}      # 例 Kstudy101/kstudy101-content
          token: ${{ secrets.CONTENT_REPO_TOKEN }}     # 読み取りだけの PAT
          path: .content-src

      # --- 道具が壊れていないか（関門 19 種）------------------------
      - name: Verify all gates
        run: |
          set -e
          fail=0
          for f in saju fortune study name omikuji gilbang amulet birth pages \
                   server webhook onboarding render push fortune-server evening \
                   billing quiz kana; do
            if node tools/verify-$f.mjs >/dev/null 2>&1; then echo "PASS $f"
            else echo "FAIL $f"; fail=1; fi
          done
          exit $fail

      # --- 入稿検査。上げる前に落とす -------------------------------
      # --check は DB にも npm install にも触れずに終わる
      #   （mysql2 は動的 import・getPool の中でしか env を要求しない）。
      # ここで落ちれば 1 文字も向こうへ行かない。
      - name: 入稿検査（--check）
        run: |
          set -euo pipefail
          mkdir -p server/content
          cp .content-src/*.json server/content/
          node server/db/seed-content.mjs --check | tee /tmp/check.txt

      # 添字の取り違えは機械には正しく見える（seed-content.mjs の注釈）。
      # 人が読める場所へ必ず出す ── 自動でも、ここだけは目に入れる。
      - name: クイズの答え合わせを要約へ
        run: |
          {
            echo '## クイズの答え合わせ（添字を解いた文字列）'
            echo '```'
            sed -n '/クイズの答え合わせ/,$p' /tmp/check.txt
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"

      # --- 夕方配信の門 ---------------------------------------------
      # 夕方の答えは「こたえを見る」を押した瞬間に計算し直される。
      # 配信と操作のあいだに原稿を差し替えると、問題と答えがずれる
      # （STATUS §8-9。防御コードは無く、この運用規則が唯一の防御）。
      # 人が時刻を選ばなくなる以上、門はこちらで持つ。
      - name: 夕方配信の門（JST 17〜22 時は止める）
        if: ${{ !inputs.force_evening }}
        run: |
          H=$(TZ=Asia/Tokyo date +%H)
          if [ "$H" -ge 17 ] && [ "$H" -lt 22 ]; then
            echo "::error::JST ${H} 時です。夕方配信（18 時）と重なるため止めました。"
            echo "22 時以降に流すか、force_evening で越えてください（STATUS §8-9）。"
            exit 1
          fi
          echo "JST ${H} 時 — 通します"

      # --- 資格情報を組み立てる（画面には出ない）--------------------
      - name: FTP の資格を置く
        env:
          FTP_HOST: ${{ secrets.FTP_CONTENT_HOST }}
          FTP_USER: ${{ secrets.FTP_CONTENT_USER }}
          FTP_PASS: ${{ secrets.FTP_CONTENT_PASS }}
        run: |
          set -euo pipefail
          umask 077
          mkdir -p ~/.config/kstudy101
          { printf 'FTP_HOST=%s\n' "$FTP_HOST"
            printf 'FTP_USER=%s\n' "$FTP_USER"
            printf 'FTP_PASS=%s\n' "$FTP_PASS"
            printf 'FTP_DIR=/\n'
          } > ~/.config/kstudy101/ftp-content.conf

      # --- 上げる（道具は 1 本だけ）--------------------------------
      - name: 原稿を上げる
        run: |
          set -euo pipefail
          DRY=""
          [ "${{ inputs.dry_run }}" = "true" ] && DRY="--dry-run"
          for f in server/content/*.json; do
            echo "── $f"
            bash tools/upload-content.sh $DRY "$f"
          done

      # 成否によらず消す。ランナーは使い捨てだが、次の step へ
      # 資格を持ち越さない形にしておく。
      - name: 資格を消す
        if: always()
        run: rm -f ~/.config/kstudy101/ftp-content.conf

      # --- DB へ入れる（配備を 1 度起こす）--------------------------
      # .cpanel.yml が migrate → seed-content → restart を通す。
      # ここで UAPI を書き直さない ── deploy-server.yml と同じことを
      # する道が 2 本になると、片方だけ直る日が来る。
      - name: DB へ入れる（deploy-server を起こす）
        if: ${{ inputs.dry_run != true }}
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh workflow run deploy-server.yml --ref main
          echo "deploy-server を起こしました。seed の結果はそちらのログに出ます。"
```

### 3-3 원고 저장소 쪽에 넣을 3행 (push 하면 이쪽이 깨어남)

```yaml
# 非公開の原稿リポジトリ側 .github/workflows/notify.yml
- run: gh api repos/Kstudy101/codespaces-blank/dispatches -f event_type=content-updated
  env: { GH_TOKEN: "${{ secrets.MAIN_REPO_TOKEN }}" }
```

---

## 4. GitHub Secrets 목록 (요청 2)

`Settings → Secrets and variables → Actions → New repository secret`

### 4-1 이미 등록돼 있어야 하는 것 (신규 아님)

| 이름 | 무엇 | 쓰는 곳 |
|---|---|---|
| `CPANEL_HOST` | 예) `sNN.chemicloud.com` | `deploy-server.yml` |
| `CPANEL_USER` | cPanel 사용자명 | 〃 |
| `CPANEL_TOKEN` | cPanel → Security → Manage API Tokens | 〃 |
| `XSERVER_SSH_KEY` / `XSERVER_HOST` / `XSERVER_USER` / `XSERVER_PATH` / `XSERVER_PORT` | 사이트(Xserver) 배포 | `deploy.yml` |

### 4-2 이번에 새로 넣을 것 — 5개

| 이름 | 값 | 어디서 |
|---|---|---|
| `FTP_CONTENT_HOST` | `ftp.kstudy101.jp` (증서가 안 맞으면 cPanel 이 안내하는 실호스트명) | cPanel → FTP Accounts → Configure FTP Client |
| `FTP_CONTENT_USER` | `content@kstudy101.jp` | 지시서⑬ §1-1 로 만든 계정 |
| `FTP_CONTENT_PASS` | 생성한 비밀번호 | 〃 (**저에게 보내지 마십시오**) |
| `CONTENT_REPO` | 예) `Kstudy101/kstudy101-content` | 새로 만들 **비공개** 저장소 |
| `CONTENT_REPO_TOKEN` | 그 저장소를 **읽기만** 하는 PAT (Fine-grained, Contents: Read-only, 그 저장소만) | GitHub → Settings → Developer settings |

`FTP_DIR` 은 Secret 이 아닙니다 — 이 계정에겐 `content/` 가 최상위라 `/` 로 고정입니다.

### 4-3 ★ SSH 계열은 넣지 마십시오

지시에 SSH 정보가 있었지만, **ChemiCloud 로의 SSH 는 Actions 에서 쓸 수 없습니다.**
IP 단위로 막혀 있고 Actions 의 IP 는 매 실행 바뀌므로, 열어도 다음 날 닫힙니다
(`deploy-server.yml` 머리말·`tools/cpanel.sh` 머리말). 그래서 자동 배포가 UAPI(HTTPS 2083)를 씁니다.
`XSERVER_SSH_KEY` 는 **Xserver(사이트)용**이고 ChemiCloud 와 무관합니다.

---

## 5. 잃는 것 — 자동화의 대가

| 잃는 것 | 대신 세운 것 |
|---|---|
| 투입 전 사람의 목시(mojibake·오답 선택지) | `--check` 를 **올리기 전**으로 옮김 + 퀴즈 답 목록을 Actions 요약에 게시(§3-2). **다만 「읽는 사람」은 자동화가 만들어 주지 않습니다** |
| 「18시 전에 끝낸다」는 운용 규칙 | 시각 문(JST 17〜22시 정지) — 사람이 시각을 고르지 않게 되므로 |
| 원고가 저장소에 없다는 성질 | **비공개 저장소로 옮기는 것**이지, 없어지는 것이 아님. 공개 저장소에는 여전히 안 들어감 |
| 지시서⑬ §7 의 「올리는 도구는 올리기만」 | 업로드 자체는 그대로. **시드는 배포를 깨우는 것**이지, FTP 계정이 DB 를 만지는 게 아님 — 계정의 권한은 안 넓힘 |

마지막 줄이 중요합니다: **FTP 계정에는 아무 권한도 더하지 않습니다.** 지시서⑬의 설계는 유지됩니다.

---

## 6. 대표님 결정

```
경로   = (가) 현행 유지 / (나) 비공개 원고 저장소 + CI / (다) 공개 저장소에 원고 커밋
파일   = deploy-content.yml 신설(권장) / deploy.yml 안의 job 으로
시각 문 = 넣는다(권장) / 넣지 않는다
```

**착수 조건: A0** (FTP 계정 생성 + 탈출 시험). 계정의 범위가 잠긴 것을 확인하기 전에는
그 비밀번호를 CI 에 넣지 않습니다.

(나)를 고르시면 순서는 — A0 → 비공개 저장소 생성 → Secrets 5개 → 워크플로 투입 →
`dry_run=true` 로 1회 → 실행. `dry_run` 의 기본값을 `true` 로 둔 것은, 처음 누르는 사람이
아무것도 모르고 본번을 갈아끼우지 않게 하기 위해서입니다.
