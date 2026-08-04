# plan-audit-fixes.md — 전수 점검에서 나온 것을 고친다

작성: 2026-08-04 / 근거: [research-audit.md](research-audit.md) / 기준 커밋: `74879e1`

> **상태: 구현 완료 (2026-08-04).** 체크리스트 11항목 전부 `[x]`.
> 결정이 필요했던 3건은 아래와 같이 정해졌습니다.

| 항목 | 결정 |
|---|---|
| **A-2** smoke.mjs | **안(나)** — 입고된 원고엔 손대지 않는다 |
| **C-1** 성별 | **안(나)** — `privacy.html`의 문구를 사실에 맞춘다 (`index.html`은 그대로) |
| **D-1** 독촉 횟수 | **의도한 대로** — 수정하지 않는다 |

---

## 0. 이 계획의 범위

| 넣는 것 | 넣지 않는 것 (§8에 이유) |
|---|---|
| 데이터 소실 2건 (A) | 리팩터링·구조 변경 일체 |
| 배포 경로 정합성 (B) | 원고 입고 (P4) |
| 폴리시 문구 (C) | 새 기능 |
| 관측 공백 (E) | 성능 개선 |

diff는 전부 합쳐 **10줄 안팎**을 목표로 합니다. 점검에서 나온 것만 고치고, 눈에 띈 김에
다른 걸 손대지 않습니다 — 이번 변경이 왜 들어갔는지가 나중에 읽히지 않게 됩니다.

---

## A. 데이터 소실 (최우선)

### A-1. `deploy-server.sh`가 서버에만 있는 원고를 지우지 않게 한다

**무엇이 문제인가** — `--delete` rsync에 `content`가 제외되어 있지 않습니다.
`server/content/`는 `.gitignore` 대상이라 저장소에 없고 서버 위에만 있습니다.
같은 목적의 `.cpanel.yml`은 이걸 막아두었는데, 이쪽만 뚫려 있습니다(research-audit §2.1).

**수정 파일** — [tools/deploy-server.sh:101](../tools/deploy-server.sh#L101)

```diff
 rsync -az --delete --checksum \
-  --exclude node_modules --exclude '.env' --exclude '.env.local' \
+  --exclude node_modules --exclude '.env' --exclude '.env.local' \
+  --exclude content --exclude stderr.log --exclude tmp --exclude public \
   -e "ssh -i $KEY -p $PORT -o StrictHostKeyChecking=accept-new" \
   server/ "$CHEMI_USER@$CHEMI_HOST:$APP_ROOT/" \
   --out-format='  %n'
```

주석도 함께 고칩니다(96-98행). 지금은 `node_modules`와 `.env` 두 개만 설명하고 있어서,
제외가 늘어난 이유가 읽히지 않습니다.

```diff
 # node_modules と .env は送らない。
 #   node_modules … 向こうは symlink。上書きすると Selector が壊れる
 #   .env         … 手元に無いし、あっても送るべきではない。向こうの
 #                  値は cPanel の Environment variables で持つ
+#   content      … 101 日ぶんの原稿。公開リポジトリに置いていないので
+#                  サーバーのここにしか無い。--delete で消すと配信が止まり、
+#                  手元から上げ直すまで戻らない
+#   stderr.log   … アプリが落ちた理由。配置の直前が知りたいので残す
+#   tmp / public … Passenger が使う。消すと再起動の合図と文書ルートが消える
+#
+# 除外の並びは .cpanel.yml と揃える。片方だけ足すと、どちらの経路で
+# 配ったかで結果が変わる ── しかも消えたことに気づくのは配信が
+# 止まった翌朝になる。
```

**트레이드오프** — 없습니다. `content`·`stderr.log`는 애초에 손에 없으므로 보낼 것도
없고, 제외해서 잃는 게 없습니다. 유일한 부작용은 「서버에 남은 불필요한 파일이
지워지지 않는다」인데, 그건 `--delete`가 원래 노리던 대상(삭제된 소스 파일)과
다릅니다.

---

### A-2. `smoke.mjs`가 3개 코스의 101일차를 지우지 않게 한다  ⟵ **결정: 안(나)**

**무엇이 문제인가** — `migrations/001`이 주키를 `(track, day_number)`로 바꿨는데,
정리 쿼리는 아직 `WHERE day_number = ?`뿐입니다. smoke는 `intermediate` 한 행만
넣지만 초급·중급·고급 **세 코스의 101일차를 전부** 지웁니다(research-audit §2.2).

101일차는 강좌의 마지막 날입니다. 사라지면 `push-daily`가 `"原稿なし"`로 내려오고
일자를 소비하지 않으므로, 그 사람은 100일차에서 영원히 멈춥니다.

`.cpanel.yml`이 smoke를 **본번에서, seed 뒤에** 돌리도록 되어 있습니다.

**수정 파일** — [server/db/smoke.mjs:27-47](../server/db/smoke.mjs#L27-L47)

#### 안(가) 최소 수정 — track을 조건에 넣는다  ✗ 채택되지 않음

```diff
 const TEST_LINE_ID = "U_smoke_test_kstudy101";
-/* 原稿は day_number が主キーなので、本物の 1〜101 とぶつからない
-   番号が要る…が、範囲は 1〜101 に縛ってある。101 番を使って
-   終わったら消す（P4 の入稿前なのでまだ空）。 */
+/* 原稿の主キーは (track, day_number)。migrations/001 が day_number 単独から
+   変えたので、消すときも両方で絞る ── day_number だけで消すと、
+   1 行しか入れていないのに 3 コースぶんの 101 日目が消える。
+   101 日目は修了日なので、消えるとその人はそこで永久に止まる。 */
+const TEST_TRACK = "intermediate";
 const TEST_DAY = 101;

 async function cleanup() {
   const u = await users.findByLineUserId(pool, TEST_LINE_ID);
   if (u) await users.deleteUser(pool, u.id);
-  await pool.execute("DELETE FROM content_templates WHERE day_number = ?", [TEST_DAY]);
+  await pool.execute(
+    "DELETE FROM content_templates WHERE track = ? AND day_number = ?",
+    [TEST_TRACK, TEST_DAY]);
 }
```

이후 `upsertTemplate`/`getTemplate` 호출의 `"intermediate"` 리터럴 3곳도
`TEST_TRACK`으로 바꿉니다([247](../server/db/smoke.mjs#L247)·[256](../server/db/smoke.mjs#L256)·[268](../server/db/smoke.mjs#L268)행).
출처가 둘로 갈리면 다음에 한쪽만 고칩니다.

- 잃는 것: 중급 101일차 입고가 끝난 뒤에 smoke를 돌리면 **그 한 행은 여전히 사라집니다.**
- diff: 약 6줄

#### 안(나) ✓ **채택** — 남의 원고면 아예 손대지 않는다

`.cpanel.yml`의 「本番에서도 흘릴 수 있다」는 보증을 실제로 지키는 형태입니다.

**보강 1점** — 「행이 있으면 건너뛴다」만으로는 **전회 smoke가 도중에 죽어서 남긴 행**까지
남의 원고로 오인해, 이후 영원히 건너뛰게 됩니다. smoke가 넣는 행은 `grammar_point`가
고정 문자열이므로 그것으로 자기 것인지 판별합니다.

```js
const TEST_GRAMMAR = "-습니다 / -습니까?";
const existing = await learning.getTemplate(pool, TEST_TRACK, TEST_DAY);
const templatesOwned = existing === null || existing.grammar_point === TEST_GRAMMAR;
//                     ↑ 아직 없음        ↑ 전회 smoke의 잔해
```

**판별을 첫 `cleanup()`보다 먼저** 해야 합니다. 49행의 `cleanup()`이 먼저 돌면
그 시점에 이미 지워버립니다.

```diff
 async function cleanup() {
   const u = await users.findByLineUserId(pool, TEST_LINE_ID);
   if (u) await users.deleteUser(pool, u.id);
-  await pool.execute("DELETE FROM content_templates WHERE day_number = ?", [TEST_DAY]);
+  /* smoke が入れた行だけを消す。既に本物の原稿が入っている日は
+     触らない（下の templatesOwned が false のときは入れてもいない）。 */
+  if (templatesOwned) {
+    await pool.execute(
+      "DELETE FROM content_templates WHERE track = ? AND day_number = ?",
+      [TEST_TRACK, TEST_DAY]);
+  }
 }
```

원고 구간 진입 전에 한 번 본 뒤 결정합니다:

```js
/* 入稿済みの日を試験で上書きしない。101 日目は修了日で、
   消えるとその人はそこで永久に止まる ── 「本番でも流せる」を
   実際に守るには、他人の原稿には触らないことまで要る。 */
const existing = await learning.getTemplate(pool, TEST_TRACK, TEST_DAY);
const templatesOwned = existing === null;

if (!templatesOwned) {
  console.log(`\n[原稿]  ${TEST_TRACK} ${TEST_DAY}日目に入稿済みの原稿があるため、この節は飛ばします`);
} else {
  ... 기존 원고 검사 3항목 ...
}
```

- 잃는 것: 입고가 끝난 뒤에는 원고 왕복 검사 3항목이 돌지 않습니다.
  (다만 그때는 `seed-content.mjs`가 매 배치마다 같은 경로를 실전으로 통과합니다)
- diff: 약 15줄

**(가)를 채택하지 않은 이유** — (가)는 「3코스가 죽던 것을 1코스로 줄인다」이지 소실을
없애는 게 아닙니다. 지금 비어 있어서 안 터지는 것도 똑같고, 입고가 끝나는 날 똑같이
터집니다.

---

## B. 배포 경로 정합성

### B-1. `.cpanel.yml`의 rsync 분기를 find 분기와 맞춘다

**무엇이 문제인가** — 같은 파일 안의 두 경로가 지키는 것이 다릅니다.
`find` 대체 경로는 `tmp`·`public`을 지키는데 rsync 경로는 지우지 않습니다.
`public/`은 Passenger의 문서 루트라 지워지면 앱이 뜨지 않을 수 있습니다.

**수정 파일** — [.cpanel.yml:47](../.cpanel.yml#L47)

```diff
-    - if [ -n "$RSYNC" ]; then "$RSYNC" -a --delete --exclude=node_modules --exclude=.env --exclude=.env.local --exclude=content --exclude=stderr.log "$SRC/" "$APP/"; else ...
+    - if [ -n "$RSYNC" ]; then "$RSYNC" -a --delete --exclude=node_modules --exclude=.env --exclude=.env.local --exclude=content --exclude=tmp --exclude=public --exclude=stderr.log "$SRC/" "$APP/"; else ...
```

**트레이드오프** — 현재 그 서버에 rsync가 없어서(주석: 초회 배치에서 127) 이 분기는
실제로 돌지 않습니다. 즉 **지금 당장은 아무 효과가 없는 수정**입니다.
그래도 넣는 이유는, 호스팅이 rsync를 넣는 날 조용히 깨어나는 종류이고,
그때 「왜 앱이 안 뜨지」에서 여기까지 거슬러 올라오기가 어렵기 때문입니다.

---

## C. 폴리시

### C-1. 성별 — 문구를 고칠지, 보내는 걸 그만둘지  ⟵ **결정: 안(나) 문구 수정**

**무엇이 문제인가** — `privacy.html:209`가 「性別は…**送信も保存もされません**」이라고
적었는데, `index.html:3283`이 `gender:'U'`를 보내고 `saju_profiles.gender`에 저장합니다.

값이 항상 `'U'`(미상)이라 개인정보가 실제로 새는 건 아닙니다. 문제는 **문장의 뒷부분이
사실이 아니라는 것**입니다. 이 저장소는 같은 성격의 불일치로 이미 세 번(GA4·Clarity·LINE)
데였고, 그때마다 「동작은 정상, 문서만 거짓」이었습니다.

#### 안(가) 보내는 것을 그만둔다  ✗ 채택되지 않음

**수정 파일** — [index.html:3281-3283](../index.html#L3281-L3283)

```diff
-    /* この画面は性別を訊いていない。訊いていないものは送らないので、
-       画面にも出さない（label を持たせない）。 */
-    { key:'gender',      label:null,               value:'U',        shown:null }
+    /* この画面は性別を訊いていない。訊いていない以上、送りもしない ──
+       privacy.html 第2項が「送信も保存もされません」と書いているのは
+       この行のことで、'U' でも送れば嘘になる。
+       サーバー側は列の既定が 'U' なので、送らなくても結果は同じ
+       （server/db/schema.sql の saju_profiles.gender）。 */
   ];
```

서버는 `normalizeProfile`이 `["M","F","U"].includes(b.gender) ? b.gender : "U"`이므로
**보내지 않아도 `'U'`가 들어갑니다.** 동작이 1비트도 변하지 않습니다.

`verify-onboarding.mjs`의 검사 항목 이름에 있는 `（gender を除く）` 예외도 함께 지웁니다 —
예외가 없어지는 것이 이 수정의 요점입니다.

- 잃는 것: 나중에 성별을 묻기로 하면 이 행을 되살려야 합니다(주석에 남겨둠)

#### 안(나) ✓ **채택** — 문구를 사실에 맞춘다

코드는 그대로 두고, `privacy.html`이 실제 동작을 정확히 말하게 합니다.
`index.html`의 `gender:'U'`도, 서버의 `saju_profiles.gender`도 손대지 않습니다.

**수정 파일** — [privacy.html:208-210](../privacy.html#L208-L210)

```diff
-<p>
-  性別はお訊きしていないため、送信も保存もされません。
-</p>
+<p>
+  性別はお訊きしていません。連携の際は「未回答」を表す値だけをお送りし、
+  そのまま保存します ── お答えいただいた内容ではなく、「訊いていない」と
+  いう印です。この欄に他の値が入ることはありません。
+</p>
```

- 얻는 것: 「무엇이 어떻게 저장되는지」를 한 항목도 빠뜨리지 않는다는 제2항의 성격이
  유지됩니다. 코드 변경이 0이므로 회귀 위험도 0입니다
- 잃는 것: 「訊いていないものは送らない」라는 원칙이 문서상 한 곳 예외가 됩니다.
  읽는 쪽에서 「안 물어봤다면서 왜 보내지?」가 될 수 있어, **그 이유까지 문장에
  넣습니다**(「훈이지 답이 아니다」)

`verify-onboarding.mjs`의 `（gender を除く）` 예외 표기는 **그대로 둡니다** —
이제 폴리시가 그 예외를 명시적으로 설명하므로, 검사 쪽 표기도 사실과 맞습니다.

---

## D. 확인 사항

### D-1. 온보딩 독촉은 단계마다 3회인가, 전체 3회인가  ⟵ **결정: 의도한 대로. 수정 없음**

**현재 동작** — `ONBOARD_NOTICE_MAX = 3`이 `countByType(userId, "onboarding")`
즉 **통산**을 봅니다. 그런데 연계 직후 인사말(`greet`)도 `onboarding`으로 1건 남으므로:

```
연계 완료 → greet(서비스 안내 + 이름 질문)   1/3
익일 아침  이름 독촉                          2/3
익익일 아침 이름 독촉                          3/3 → 이후 침묵
                                                 ↳ 코스 질문은 배치로 한 번도 안 나감
```

이름을 나중에 답한 사람에게 **코스 질문이 배치로는 가지 않습니다.**
`message.mjs`가 「コース」라고 보내면 답하는 문을 열어두었으므로 완전히 막히진
않습니다(그 주석이 이 상황을 정확히 설명하고 있습니다).

**결정: 의도한 동작입니다. 코드는 수정하지 않습니다.**

`message.mjs`의 `ASK_SETUP`(「コース」「初級」「名前」…)이 답하는 문을 열어두고 있고,
`push-daily.mjs:73-82`의 주석이 그 의도를 이미 적고 있습니다 —
「黙ったあとに手が無くなるのを防ぐ」.

단계별 3회로 바꾸려면 `push_logs`에 단계 구분 열이 필요해지고(`migrations/002`),
그건 **이 계획의 범위 밖**입니다(§8).

---

## E. 관측 공백

### E-1. 배포 스모크 테스트에 `birth.js`를 넣는다

`birth.js`는 `index.html`·`gilbang.html`·`amulet.html` 3장이 읽는데,
배포 후 확인 목록에 없습니다. 배포되지 않아도 파이프라인은 초록으로 끝납니다.

**수정 파일** — [.github/workflows/deploy.yml:511](../.github/workflows/deploy.yml#L511)

```diff
           echo "運勢が使う実ファイル（PUBLIC への追加漏れはここで出る）"
-          for p in /saju.js /fortune.js /study.js /omikuji.js /gilbang.js /amulet.js \
+          for p in /saju.js /fortune.js /study.js /omikuji.js /gilbang.js /amulet.js /birth.js \
                    /solar-terms.json /new-moons.json; do check "$p" 200; done
```

### E-2. 서버·문서만 고친 커밋이 사이트 배포를 발동시키지 않게 한다

`server/**`만 고친 커밋도, `instruction.txt`/`CLAUDE.md`도 Xserver 전체 배포를 겁니다.
보내는 내용은 동일하지만 배포 이력이 오염되고 관문 16종이 무의미하게 돕니다.

**수정 파일** — [.github/workflows/deploy.yml:10-15](../.github/workflows/deploy.yml#L10-L15)

```diff
     paths-ignore:
       - 'README.md'
       - 'data/**'
       - 'docs/**'   # 計画書などの内部文書。build-site.sh の PUBLIC に無く配信もされない
+      - 'instruction.txt'
+      - 'CLAUDE.md'
+      # server/ は ChemiCloud で動き、dist にも入らない（PUBLIC は許可リスト）。
+      # ここを直しただけで Xserver へ配り直す理由が無い。
+      #
+      # ただし検証 7 種（server / webhook / onboarding / render / push /
+      # fortune-server / evening）はこのワークフローにしか無いので、
+      # 除外すると server/ の変更が誰にも検査されなくなる。
+      # → 除外は保留。別ワークフローに切り出してから外すこと
       # tools/ は除外しない。build-site.sh が dist の中身を決めるので、
       # ここを直したのにデプロイされない、という食い違いが起きる。
```

**트레이드오프가 여기서 갈립니다.** `server/**`를 `paths-ignore`에 넣고 싶지만,
넣으면 **server 검증 7종이 돌지 않습니다.** 그 7종은 이 워크플로에만 있습니다.
그래서 이번에는 `instruction.txt`·`CLAUDE.md`만 빼고, `server/**`는 그대로 둡니다 —
검증을 잃는 것이 배포 이력이 지저분한 것보다 훨씬 무겁습니다.

`server/**`를 분리하려면 별도 워크플로(`verify-server.yml`)가 먼저 필요하고,
그건 **이 계획의 범위 밖**입니다.

### E-3. `.gitattributes`를 추가한다

검증 2종이 소스를 정규식으로 뜨면서 `\n`을 하드코딩해서, CRLF 체크아웃에서는
매치가 `null`이 됩니다(research-audit §3.4). CI(ubuntu)는 영향이 없지만
Windows에서 관문을 미리 돌려볼 수 없습니다.

**신규 파일** — `.gitattributes`

```gitattributes
# 検証スクリプトがソースを正規表現で切り出すとき、\n を直に書いている所がある
#   tools/verify-amulet.mjs      /<script>\n(...)\n<\/script>/
#   tools/verify-onboarding.mjs  /export async function completeLink[\s\S]*?\n}\n/
# CRLF で取り出すと一致しなくなり、Windows では関門を手元で回せない。
# CI は ubuntu なので本番には出ないが、出ないぶん気づきにくい。
* text=auto eol=lf
```

**두 가지 방법 중 이쪽을 고른 이유** — 검증 스크립트 쪽을 `\r?\n`으로 고치는 방법도
있습니다. 그쪽은 파일 2개·정규식 3곳을 만지고, 앞으로 새 검증을 쓸 때마다 같은
주의가 필요합니다. `.gitattributes`는 1파일이고 원인 자체를 없앱니다.

**주의** — 이 파일을 넣으면 다음 체크아웃에서 작업 트리의 줄바꿈이 전부 LF로
정규화됩니다. 커밋 내용은 이미 LF이므로 **저장소에는 diff가 생기지 않지만**,
로컬 파일은 한 번 다시 쓰입니다.

---

## F. 문서 표류 (무해. 같은 커밋에 묶습니다)

- [server/db/schema.sql:2](../server/db/schema.sql#L2) — 「8 テーブル」 → 「9 テーブル」
  (`pending_links`가 P3에서 추가됨)
- [server/lib/app.mjs:7](../server/app.mjs#L7) — 「経路は 3 つだけ」 → 「経路は 4 つだけ」
  (바로 아래에 4개를 나열하고 있고, 15행은 이미 「4 つしか無い」)

---

## G. 검증 방법

고친 뒤 이 순서로 확인합니다. **DB에도 ChemiCloud에도 접속하지 않습니다.**

```bash
# 1) 관문 16종. 지금 통과하는 것이 계속 통과하는지
for f in saju fortune study name omikuji gilbang amulet birth pages \
         server webhook onboarding render push fortune-server evening; do
  node tools/verify-$f.mjs >/dev/null && echo "PASS $f" || echo "FAIL $f"
done

# 2) dist 생성. C-1(가)를 택한 경우 index.html이 바뀌므로 필수
bash tools/build-site.sh

# 3) 셸 스크립트 문법 (실행하지 않음)
bash -n tools/deploy-server.sh
bash -n server/db/push-cron.sh

# 4) YAML 파싱
python -c "import yaml,sys; yaml.safe_load(open('.cpanel.yml'))"
python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))"

# 5) smoke.mjs는 문법만. 돌리면 본번 DB에 씁니다
node --check server/db/smoke.mjs
```

`smoke.mjs`의 수정은 **DB 없이는 실증할 수 없습니다.** 확인하시려면 배치 후
`~/.run-smoke`를 두고 한 번 돌리는 방법이 있는데, **A-2를 고치기 전에는 돌리지 마십시오** —
지금 돌리면 3코스의 101일차가 지워집니다(현재는 비어 있어 실해는 없습니다).

---

## H. 작업 목록

- [x] **A-1** `tools/deploy-server.sh` — `--exclude content tmp public stderr.log` + 주석
- [x] **A-2** `server/db/smoke.mjs` — 안(나). `templatesOwned` 판별 + `(track, day_number)` 삭제
- [x] **B-1** `.cpanel.yml` — rsync 분기에 `--exclude=tmp --exclude=public`
- [x] **C-1** `privacy.html` — 성별 문구를 사실에 맞춤 (안(나))
- [x] **C-1b** `tools/verify-onboarding.mjs` — **계획에 없던 추가 작업.** §H-1 참조
- [x] **D-1** 온보딩 독촉 — 의도한 대로. 수정 없음
- [x] **E-1** `deploy.yml` — 스모크 테스트에 `/birth.js`
- [x] **E-2** `deploy.yml` — `paths-ignore`에 `instruction.txt` / `CLAUDE.md`
      (`server/**`는 검증 7종을 잃으므로 제외하지 않음. 이유를 주석에 남김)
- [x] **E-3** `.gitattributes` 신규
- [x] **F** 주석 2곳 (`schema.sql` 8→9테이블, `app.mjs` 3→4경로)
- [x] **G** 검증 실행 — §H-2

### H-1. 계획에 없던 추가 작업 1건 (C-1b)

`privacy.html`의 문구를 고치자 **`verify-onboarding.mjs:548`이 떨어졌습니다.**

```js
assert(/性別はお訊きしていない/.test(PRIVACY), "性別の扱いが書かれていません");
```

옛 문구를 정규식으로 고정하고 있었습니다. 계획 단계에서는 이 결합을 못 봤습니다
(계획서는 `（gender を除く）` 표기만 언급했는데, 실제로 걸린 건 다른 줄이었습니다).

**정규식만 새 문구에 맞추는 것으로 끝내지 않았습니다.** 그 검사가 지키려던 명제
「訊いていないものは送らない、と書いてあること」 자체가 사실이 아니었기 때문입니다.
사실에 맞춰 **더 강한 조건 2본**으로 바꿨습니다:

```js
assert(/性別はお訊きしていません/.test(PRIVACY), "…訊いていないことが書かれていません");
assert(/未回答/.test(PRIVACY),                  "…何を送っているかが書かれていません");
```

- 「안 물어봤다」만 있으면 → 읽는 사람은 안 보낸다고 받아들임
- 「보낸다」만 있으면 → 무엇을 보내는지 모름
- **둘 다 요구**합니다

검사를 통과시키려고 검사를 느슨하게 한 것이 아니라, 검사가 지키던 명제가 틀려서
명제를 고친 것입니다. 조건 수는 1개 → 2개로 늘었습니다.

### H-2. 검증 결과 (2026-08-04)

`.gitattributes`는 다음 체크아웃부터 효과가 나므로, 검증은 작업 트리를
LF로 정규화한 사본에서 돌렸습니다.

```
1) 관문 16종                         16 PASS / 0 FAIL
     saju fortune study name omikuji gilbang amulet birth pages
     server webhook onboarding render push fortune-server evening

2) bash tools/build-site.sh          exit 0
     dist/25파일 생성, privacy.html 새 문구 반영 확인

3) bash -n                           OK  tools/deploy-server.sh
                                     OK  tools/build-site.sh
                                     OK  server/db/push-cron.sh

4) YAML 파싱                          OK  .cpanel.yml
                                     OK  .github/workflows/deploy.yml
   3경로 제외 목록 일치 검사           OK
     .cpanel.yml rsync 분기 ┐
     .cpanel.yml find  분기 ├ 7항목 전부 동일
     deploy-server.sh       ┘ .env .env.local content node_modules
                              public stderr.log tmp

5) node --check                      OK  server/db/smoke.mjs
                                     OK  server/app.mjs
```

**실증하지 못한 것** — `smoke.mjs`의 수정은 **DB 없이는 실행 확인이 불가능합니다.**
문법 검사와 코드 검토까지만 했습니다. 확인하시려면 배치 후 `~/.run-smoke`를 두고
한 번 돌리면 됩니다. **이제는 돌려도 안전합니다** — 입고된 원고가 있으면 그 절을
통째로 건너뛰고, 없으면 자기가 넣은 행만 `(track, day_number)`로 지웁니다.

---

## 8. 제외 — 이번에 하지 않는 것

| 안 하는 것 | 이유 |
|---|---|
| `server/**`를 `paths-ignore`에 넣기 | 검증 7종이 이 워크플로에만 있음. 별도 워크플로가 먼저 (E-2) |
| 단계별 독촉 횟수 | `push_logs`에 열이 늘어남. 별도 계획서 (D-1) |
| `fortune-text.mjs`의 `grades.total` 무방비 참조 | `loadLines`의 `checkLines`가 이미 막고 있음. 직접 호출하는 곳이 없음 |
| `.htaccess` / `README.md` / 계획서 4종 | 이번 점검에서 문제를 못 찾았음 |
| 검증 스크립트의 `\n` → `\r?\n` | `.gitattributes`가 원인 자체를 없앰 (E-3) |
| 원고 입고 (P4) | 별개 작업 |
| 리팩터링·구조 변경 | 이 계획은 점검 결과만 다룸 |
