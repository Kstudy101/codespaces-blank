# plan-fortune-removal.md — 운세를 전부 걷어내고 「LINE으로 배우는 공부」로 전환

작성: 2026-08-16 · 상태: **배포 완료**（`e1a3a44` 서버 · `7cbb038` 사이트）
리서치: [research-fortune-removal.md](research-fortune-removal.md)
계기: **Stripe 심사 기준상 승인 불가**(점술·역술은 제한 업종) → 사업 전면 수정.

> **이 문서의 규칙.** `CLAUDE.md` §협업 방식 — §1 결정 7건에 대표 승인을 받은 뒤
> §3 을 기계적으로 구현했고, 2026-08-16 에 배포했다. 남은 것은 §9 의 대표 실기 5건.
>
> **§2 의 「P2 먼저」는 결과적으로 필요 없었다.** 커밋 2개를 한 번에 push 했고,
> 배포는 HEAD 에서 돌기 때문이다 — `.cpanel.yml` 의 `cp saju.js` 는 같은 트리에서
> 이미 사라져 있었다. 순서를 강제하려 했다면 D7-2 의 「코드↔폴리시 대조」가
> 사이트와 서버를 한 관문으로 묶어, 서버만 담은 커밋이 CI 에서 빨간불이 된다.

---

## 0. 목표와 합격 기준

**목표.** 사이트·LINE·결제 어디를 봐도 「점을 팔고 있다」고 읽힐 여지를 0으로 만든다.
남는 상품은 하나 — **LINE으로 매일 도착하는 한국어 레슨.**

**합격 기준 (전부 기계로 확인 가능).**

```bash
# ① 관문 전종 PASS (폐지분 제외 + 신설 1종 포함)
# ② 배포된 사이트에서 운세 URL 이 소멸
curl -o /dev/null -w '%{http_code}\n' https://www.kstudy101.jp/omikuji   # 410
curl -o /dev/null -w '%{http_code}\n' https://www.kstudy101.jp/gilbang   # 410
curl -o /dev/null -w '%{http_code}\n' https://www.kstudy101.jp/amulet    # 410
curl -o /dev/null -w '%{http_code}\n' https://www.kstudy101.jp/saju.js   # 404
# ③ 문자열 전수 0 (신설 관문 verify-no-fortune 이 강제)
# ④ 아침 편 실물이 레슨 1통(+퀴즈 꼬리)만 — accel-day 로 확인
```

---

## 1. 대표 결정 7건 — **2026-08-16 전부 승인. 권고안대로 확정.**

기술·범위 선택은 대표 몫이라 임의로 확정하지 않았다. 아래가 확정된 답이다.

| # | 결정할 것 | **확정** | 근거 |
|---|---|---|---|
| **D1** | `/omikuji` `/gilbang` `/amulet` 3장 | **(가) 저장소에서 완전 삭제** | (나)는 「지웠다고 생각했는데 `PUBLIC` 에 다시 들어가는」 재발 경로가 남는다. (다)는 심사에서 그대로 발견된다 |
| **D2** | 지운 URL 의 응답 | **(가) 410 Gone** | 의도적 폐지의 정확한 신호. 크롤러가 재시도를 멈춘다. (다)는 「점 페이지가 톱으로 리다이렉트」로 읽혀 오히려 나쁘다 |
| **D3** | `/words` (단어장) | **(가) 같이 삭제** | 저장하는 화면(구 운세 페이지)이 이미 없어 **지금도 항상 빈 페이지**다. `study.js`·`verify-study` 도 함께 폐지 |
| **D4** | `users` 의 `birth_date` 등 6열 | **(가) 열은 존치, 코드에서만 안 읽음** | 열 drop 은 되돌릴 수 없다. 체험 7일 때와 같은 2단계 원칙 — 한 번에 하면 문제가 났을 때 원인을 못 가른다. drop 은 별건 마이그레이션 010 |
| **D5** | `content_templates.fortune_bridge` | **(가) 이름 그대로** | 실체는 이미 레슨 말미 🍀 今日のひとこと 이고 운세 단정은 `content-check` 가 금지 중. 개명은 원고 303일·렌더러·관문 3종을 같이 흔든다 |
| **D6** | 신설 관문 `verify-no-fortune` | **(가) 신설** | 운세 관문 8종을 지우면 「운세가 없다」를 지키는 장치가 0이 된다. 재발 = Stripe 재심사 탈락 |
| **D7-1** | `render.mjs` 의 `{OHAENG}`/`{ZODIAC}` 슬롯 | **(가) 그대로 둔다** | 값이 들어갈 길이 이미 없다. 사용자에게 나갈 길이 없으므로 심사 리스크가 아니다 |
| **D7-2** | `/line/link/start` (생년월일 입구) | **(가) 폐지** | 「쓰지 않는 개인정보를 받는 입구」를 닫는다. privacy 는 「生年月日は取得しません」으로 |

### §1-a D7 — P2 구현 중에 드러난 2건

**D7-1. 렌더러의 `{OHAENG}`/`{ZODIAC}` 슬롯** (`server/lib/render.mjs`)
본문에 오행(목·화·토·금·수)과 띠(쥐·소…)를 꽂는 자리가 남아 있다. 값의 출처였던 사이트 진단이
먼저 사라지고 운세도 폐지되어 **값이 들어갈 길은 이미 없다**(content-check 가 「사주 없는 사람이
못 읽는 날」을 입고에서 막으므로 원고도 못 쓴다). 지금은 「죽어 있지만 남은 배관」이다.

- (가) **그대로 둔다** — 동작에 영향 0, diff 최소
- (나) **슬롯째 제거** — `render.mjs`·`content-check.mjs`·`verify-render` 를 같이 흔든다

**확정 (가)**（2026-08-16）. 사용자에게 나갈 길이 없으므로 심사 리스크가 아니고, 이번 diff 를 작게 유지한다.
주석으로 「값이 들어갈 길 없음」을 남겨 둔다.

**D7-2. `/line/link/start` — 생년월일을 받는 입구가 아직 열려 있다** (`server/app.mjs`)
사이트의 진단 결과를 받아 `saju_profiles` 에 넣던 엔드포인트. **호출하는 페이지는 이미 없고**
CORS 도 자사 오리진으로 잠겨 있지만, 「쓰지 않는 개인정보를 받는 입구」가 열려 있는 상태다.

- (가) **P3 에서 닫는다**(엔드포인트 폐지 + `privacy.html` 을 「생년월일을 취득하지 않습니다」로)
- (나) 그대로 두고 폴리시에는 「과거 취득분은 사용하지 않습니다」로 쓴다

**확정 (가)**（2026-08-16）. D4 는 (가) 열 존치이므로, privacy 문안은
「生年月日は取得しません（過去に取得したものは使用しません）」이 된다.

**닫는 범위 (구현 시 확정).** 라우트(`PATH_START`·`onLinkStart`·CORS)와
`startLink`／생년월일 정규화(`normalizeProfile`)까지. `completeLink` 는 **남긴다** —
생산자가 사라져 도달 불가가 되지만, 지우면 `resultPage`·`greet`·관문 8항목이
같이 흔들린다. 「도달 불가가 된 코드의 철거」는 별건으로 남긴다(§7).

---

## 2. 접근 방식 — 왜 이 순서인가

**한 커밋이 아니라 3덩어리로 나눈다.** 배포 경로가 다르기 때문이다(`STATUS.md` §1).

```
P1  사이트         → main push → GitHub Actions → Xserver
P2  LINE 서버      → server/** push → deploy-server.yml → ChemiCloud
P3  서버 위 잔여물  → 대표 실기 (fortune-lines.json 삭제 · Stripe 콘솔)
```

**P1 과 P2 를 같은 커밋에 넣지 않는 이유.** `.cpanel.yml` 이 배포마다
`saju.js`/`fortune.js`/`solar-terms.json` 을 `$APP/engine/` 로 **복사**한다.
사이트에서 이 3개를 지운 커밋이 먼저 서버에 도달하면 `cp -f` 가 실패하고,
`.cpanel.yml` 은 `set -e` 로 12작업이 이어져 있어 **거기서 배포가 통째로 멈춘다.**

따라서 **순서가 강제된다**:

```
P2 먼저 (서버가 엔진을 더 이상 안 읽게 만들고, .cpanel.yml 의 복사 줄을 제거)
   ↓  배포 확인 (아침 편에 운세가 안 붙는 것)
P1 다음 (사이트에서 엔진 파일을 삭제)
```

거꾸로 하면 서버 배포가 멈춘다. **이것이 이 작업에서 가장 되돌리기 어려운 지점이다.**

> **P1 안에서는 4곳 규칙이 그대로 적용된다** — `PUBLIC` / `TARGETS` / `sitemap.xml` /
> `deploy.yml` 스모크. `build-site.sh` 가 sitemap 을 **양방향**으로 대조하므로,
> 하나라도 빠뜨리면 빌드가 멈춘다(안전망이 작동하는 것).

---

## 3. 변경 상세

### P2 — LINE 서버 (먼저)

#### P2-1 `server/db/push-daily.mjs` — 운세 1통·부적 1통 제거

삭제: `import` 2줄(47-48) · `fortuneSkips`(98-100) · `fortuneSection()`(165-220) ·
`AMULET_SITE`/`amuletInvite()`/`amuletSection()`(223-274) · 호출부 3곳.

```diff
-import { fortuneFor } from "../lib/fortune.mjs";
-import { loadLines, fortuneMessage, rankCats } from "../lib/fortune-text.mjs";
```

```diff
@@ 아침 편을 組む @@
-  const fortune = fortuneSection(u, { load });
-  if (fortune) messages = [...messages, fortune];
```

**통수 상한(639행) 을 반드시 같이 고친다.** 지금 조건이 `fortune` 변수를 읽는다 —
함수만 지우고 남기면 `ReferenceError` 로 **아침 배치가 통째로 죽는다.**

```diff
-  if (fortune && messages.length + (quizTail ? 1 : 0) < 5) {
-      const at = messages.indexOf(fortune) + 1;
+  if (messages.length + (quizTail ? 1 : 0) < 5) {
+      const at = messages.length;
```

> 정확한 삽입 위치는 구현 시 639-647행 문맥을 읽고 확정한다(퀴즈 꼬리통이 운세 **뒤**에
> 들어가던 자리라, 운세가 사라지면 「레슨 뒤」가 된다). `verify-push` 55항목이 여기를 본다.

#### P2-2 삭제할 파일

```
server/lib/fortune.mjs        (102줄 · node:vm 엔진 로더)
server/lib/fortune-text.mjs   (218줄 · 점수→문장)
```

#### P2-3 `server/lib/onboarding.mjs` — 문면 개필 2곳

```diff
@@ serviceGuide() @@
-      `韓国語を、${you}の**名前**と**四柱**で学びます。`,
+      `韓国語を、${you}の**名前**で学びます。`,
       "教科書の「ミンスさん」ではなく、例文の主語があなたです。",
       "",
       "・会話文はあなたが「私」として登場します",
       "　場面（買い物・道をたずねる・自己紹介…）ごとに、",
       "　あなたの名前で言えるようになります",
-      "・韓国式の占い（사주・운세・기운）が毎朝つきます",
-      "　その日の運勢を韓国語で読むので、言葉と一緒に身につきます",
+      "・1日1分、朝のレッスンと夕方の復習クイズだけ",
+      "　新しいアプリは要りません。LINEを開くだけです",
```

```diff
@@ serviceGuide() 1日のながれ @@
-      "朝 7時　今日の運勢 ＋ 文法 ＋ 会話 ＋ 単語3語",
+      "朝 7時　文法 ＋ 会話 ＋ 単語3語",
```

```diff
@@ trackStarted() @@
-      "　朝7時　文法 ＋ 会話＋単語 3 語（＋ 今日の運勢）",
+      "　朝7時　文法 ＋ 会話＋単語 3 語",
```

**`verify-onboarding`(46항목) 이 이 문면을 대조한다 — 같은 커밋에서 고친다.**
(2026-08-09 에 이것으로 배포가 3번 멈췄다. `CLAUDE.md` 규칙 10)

#### P2-4 `server/lib/pages.mjs` — 오류 화면 문면 4곳

```diff
-           占いのページからやり直してください。</p>
+           トップページからやり直してください。</p>
```
```diff
-          ? "連携用のリンクは 30 分で切れます。お手数ですが、占いのページからもう一度お試しください。"
-          : "しばらく時間をおいて、占いのページからもう一度お試しください。"}</p>
+          ? "連携用のリンクは 30 分で切れます。お手数ですが、もう一度お試しください。"
+          : "しばらく時間をおいて、もう一度お試しください。"}</p>
```

사이트명 「名前で学ぶ韓国語」 1곳 → **「LINEで学ぶ 1日1分 簡単韓国語」** 로 통일
(§0-☆-a 로 미결이던 개명 문제가 이 피벗으로 자동 확정된다).

#### P2-5 `.cpanel.yml` — engine 복사 제거

```diff
-    # saju.js / fortune.js / solar-terms.json はサイト本体のもので、
-    #（写しを置かない方針。node:vm で読む）
-    - /bin/mkdir -p "$APP/engine"
-    - /bin/cp -f "$PWD/saju.js" "$PWD/fortune.js" "$PWD/solar-terms.json" "$APP/engine/"
```

`.github/workflows/deploy-server.yml:34` 의 `"solar-terms.json"` 감시 항목도 같이 제거.

#### P2-6 관문

- **폐지**: `tools/verify-fortune-server.mjs` (45항목)
- **수정**: `verify-push`(운세·부적 항목 삭제) · `verify-onboarding`(문면 대조) ·
  `verify-evening`(주석 1곳) · `verify-server`(제외 목록 확인)

---

### P1 — 사이트 (P2 배포 확인 후)

#### P1-1 삭제할 파일 — D1(가)·D3(가) 기준

```
omikuji.html  gilbang.html  amulet.html          (+ words.html)
omikuji.js    gilbang.js    amulet.js
saju.js       fortune.js    birth.js             (+ study.js)
solar-terms.json  new-moons.json
```

`kanji.json` 은 **남긴다** — `js/name-learn-data.js`(가나 정본, 비공개)가 선택적으로 읽고,
`verify-name`/`verify-kana` 가 이를 대조한다. 다만 **공개 소비자가 0**이 되므로
`PUBLIC` 에서 뺄지는 구현 시 `verify-name` 을 읽고 확정한다(관문이 dist 를 보는지 저장소를 보는지에 달림).

#### P1-2 `index.html` — 푸터 링크

```diff
 <footer>
   <p><b>Kstudy101</b> — LINEで学ぶ 1日1分 簡単韓国語</p>
-  <!-- サイドメニュー撤去後、下層ページへの唯一の導線。
-       verify-amulet「トップから부적への導線がある」がここを見ている。 -->
-  <p class="foot-meta">
-    <a href="/omikuji">おみくじ</a>・
-    <a href="/gilbang">今日の吉方位</a>・
-    <a href="/amulet">お守り</a>・
-    <a href="/words">単語帳</a>・
-    <a href="/tips">韓国語の豆知識</a>
-  </p>
+  <p class="foot-meta">
+    <a href="/tips">韓国語の豆知識</a>
+  </p>
   <p class="foot-meta">
     <a href="/privacy">プライバシーポリシー</a>・
```

LP 본문은 이미 학습 전용이라 **다른 곳은 손대지 않는다**(리서치 §0).
`🔮` 이모지는 LP 에 없다(`push-daily` 쪽에만 있었고 P2 에서 함께 사라진다).

#### P1-3 CI 배선 4곳

```diff
@@ tools/build-site.sh · PUBLIC @@
   tips.html
-  words.html
-  omikuji.html
-  gilbang.html
-  amulet.html
   404.html
   page.css
   kanji.json
-  saju.js
-  fortune.js
-  study.js
-  omikuji.js
-  gilbang.js
-  amulet.js
-  birth.js
-  new-moons.json
-  solar-terms.json
   ogp.png
```

`build-site.sh` 안의 부수 수정 2곳:
- §2 canonical 검사 목록에서 3장 제거
- §4 `SITEMAP_SKIP` — `words` 를 지우면 `" 404 "` 만 남는다

```diff
@@ tools/set-site-url.py · TARGETS @@
 TARGETS = ["index.html", "privacy.html", "contact.html", "tokushoho.html", "tips.html",
-           "words.html", "omikuji.html", "gilbang.html", "amulet.html",
            "404.html", "sitemap.xml", "robots.txt"]
```

`sitemap.xml` — `/omikuji` `/gilbang` `/amulet` 의 `<url>` 3덩어리 삭제.
`robots.txt` — `Disallow: /words` 2줄 삭제(D3(가) 시).

```diff
@@ .github/workflows/deploy.yml @@
-      - name: Verify saju            (58-59)
-      - name: Verify fortune         (65-66)
-      - name: Verify omikuji         (89-90)
-      - name: Verify gilbang         (96-97)
-      - name: Verify amulet          (104-105)
-      - name: Verify birth           (108…)
-      - name: Verify study
-      - name: Verify fortune (server)(231-232)
+      - name: Verify no-fortune      (신설 · D6)
```
```diff
@@ 스모크 (544·553-554행) @@
-          for p in / /privacy /contact /tokushoho /tips /words /omikuji /gilbang /amulet; do check "$p" 200; done
+          for p in / /privacy /contact /tokushoho /tips; do check "$p" 200; done
-          for p in /saju.js /fortune.js /study.js /omikuji.js /gilbang.js /amulet.js /birth.js \
-                   /solar-terms.json /new-moons.json; do check "$p" 200; done
+          for p in /omikuji /gilbang /amulet; do check "$p" 410; done   # D2(가)
```
598행 `for p in /page.css /fortune.js` → `/page.css` 만.
**502행(도착지 판정)은 손대지 않는다** — 원래 5장만 세고 있어 영향이 없다.

#### P1-4 관문

- **폐지 (7종)**: `verify-saju` `verify-fortune` `verify-omikuji` `verify-gilbang`
  `verify-amulet` `verify-birth` (+`verify-study` — D3(가) 시)
- **수정**: `verify-pages` — `PAGES` 표에서 4장 제거 · noindex 판정 문구 · `amulet ?cat=` 검사 삭제

#### P1-5 `.htaccess` — 410 (D2(가) 시)

```apache
# 2026-08-16 사업 전환으로 폐지한 3장. 404 가 아니라 410 —
# 「일시적으로 없음」이 아니라 「의도적으로 폐지」라야 크롤러가 재시도를 멈춘다.
RedirectMatch gone ^/(omikuji|gilbang|amulet)$
```

---

### P3 — 폴리시·문서·서버 잔여물

#### P3-1 `privacy.html` 10곳 — **P1 과 같은 커밋에서**

`CLAUDE.md` 규칙: 저장 항목이 바뀌면 폴리시도 같은 커밋. 지금까지 어긋난 적이 4번 있다.

- 제2항 「おみくじ・今日の吉方・お守りなど、四柱や運勢に関するページで入力された…」 → **문단 삭제**
- 저장 항목 표에서 「運勢の点数」「おみくじの結果」「運勢を見た日」 행 삭제
- 「今日の運勢」「単語帳」「おみくじ」에는 記録があります → 남는 기능 기준으로 재작성
- 「四柱の算出と、お届けする時刻の決定に使います」(187행) → **D4 에 연동**
  - D4(가) 존치면: 「過去に取得した生年月日は使用しません」 류의 정확한 서술
  - D4(나) drop 이면: 해당 행 삭제 + 「生年月日は取得しません」
- 413행 「占い・鑑定として提供するものではありません」 면책 → 대상이 사라지므로 삭제

#### P3-2 문서

| 파일 | 할 일 |
|---|---|
| `CLAUDE.md` | 「운세 엔진의 사본을 server/ 에 두지 않는다」 조항 **삭제**(엔진이 없어짐) · 관문 목록 19종 → 신 목록 · 「페이지 4곳」 규칙은 유지 |
| `STATUS.md` | §0 최상단에 이번 피벗 절 신설 · §2 표의 「아침 7시 — 한국식 운세 + …」 행 수정 · 관문 종수 갱신 |
| `README.md` | 53곳 — 구현 후 일괄 |
| `docs/marketing.md` | 운세를 오퍼로 쓰는 항목이 있으면 수정 |
| 구 계획서 (`plan-fortune-daily` `plan-fortune-content` `plan-amulet-daily`) | **삭제하지 않고 머리말에 「2026-08-16 사업 전환으로 폐지」 1줄** — 의사결정 기록이므로 |

#### P3-3 대표 실기 (코드로 못 하는 것)

| # | 어디 | 할 일 |
|---|---|---|
| 1 | ChemiCloud `server/content/` | **`fortune-lines.json` 삭제** — 저장소에 없고 서버에만 있어 배포로는 안 사라진다 |
| 2 | Stripe 콘솔 | 상품명·설명에서 운세 표현 제거, 업종 카테고리 재확인 |
| 3 | LINE OA 콘솔 | あいさつメッセージ 는 **오프 유지**(웰컴 정본은 서버). 리치메뉴는 운세 없음 — 변경 불요 |
| 4 | Search Console | `/omikuji` `/gilbang` `/amulet` 색인 삭제 요청 |

---

## 4. 신설 관문 `tools/verify-no-fortune.mjs` (D6)

지운 것이 **다시 들어오지 못하게** 하는 유일한 장치. 8종을 지운 자리에 1종을 놓는다.

```js
/* 운세는 사업에서 제외됐다(2026-08-16 · Stripe 심사).
   지웠다는 사실을 문서가 아니라 관문이 지킨다 ── 원고·문면·페이지
   어디로든 다시 섞여 들어오는 것이 재발 경로이고, 그것이 곧
   결제 정지다. 「좋은 콘텐츠니까」로 되돌아오는 것을 여기서 막는다. */
const BANNED = [
  /사주|운세|부적|점술/,
  /四柱|運勢|占い|お守り|おみくじ|吉方位|運気/,
];

/* 검사 대상: 공개 HTML · server/lib · server/db · 원고 검사기
   제외: docs/(의사결정 기록) · README · 이 파일 자신 */
```

동시에 **파일 부재**도 검사한다 — `saju.js` `fortune.js` `omikuji.html` … 가 저장소에
돌아오면 즉시 RED.

> **주의.** `content-check.mjs` 의 `FORTUNE_ASSERT`(운세 단정 금지 정규식)와
> `fortune_bridge` 열 이름은 **정당한 예외**다. 관문에 명시 제외로 적고 이유를 남긴다 —
> 안 그러면 신설 관문이 첫날부터 RED 라 아무도 안 믿게 된다.

---

## 5. 수정될 파일 경로 (전체)

**신규 (3)**
```
docs/research-fortune-removal.md   ← 작성 완료
docs/plan-fortune-removal.md       ← 이 문서
tools/verify-no-fortune.mjs        ← D6(가) 시
```

**삭제 (P2: 2 / P1: 10~12)**
```
server/lib/fortune.mjs             server/lib/fortune-text.mjs
tools/verify-fortune-server.mjs    tools/verify-saju.mjs      tools/verify-fortune.mjs
tools/verify-omikuji.mjs           tools/verify-gilbang.mjs   tools/verify-amulet.mjs
tools/verify-birth.mjs             (tools/verify-study.mjs)
omikuji.html  gilbang.html  amulet.html  (words.html)
omikuji.js  gilbang.js  amulet.js  saju.js  fortune.js  birth.js  (study.js)
solar-terms.json  new-moons.json
```

**수정 (19)**
```
index.html                          privacy.html          sitemap.xml
robots.txt                          .htaccess
tools/build-site.sh                 tools/set-site-url.py
tools/verify-pages.mjs              tools/verify-push.mjs
tools/verify-onboarding.mjs         tools/verify-evening.mjs   tools/verify-server.mjs
.github/workflows/deploy.yml        .github/workflows/deploy-server.yml
.cpanel.yml
server/db/push-daily.mjs            server/lib/onboarding.mjs  server/lib/pages.mjs
CLAUDE.md                           STATUS.md                  README.md
```

---

## 6. 트레이드오프 (고려했고, 버린 안 포함)

| 안 | 장점 | 버린 이유 |
|---|---|---|
| **한 커밋에 전부** | 이력이 하나로 남는다 | `.cpanel.yml` 이 사이트의 `saju.js` 를 복사한다 — 순서가 어긋나면 **서버 배포가 set -e 로 멈춘다**. 게다가 사고가 났을 때 사이트 문제인지 서버 문제인지 못 가른다 |
| **관문 8종을 남기고 skip 처리** | diff 가 작다 | 「검사가 있으니 지켜지고 있다」는 착각이 남는다. 검사 대상이 없는 관문은 항상 PASS 라 **거짓 안전**이다 |
| **페이지를 noindex 로 존치** | 되돌리기 쉽다 | 심사는 색인이 아니라 **사이트를 본다**. 되돌릴 계획이 있다는 것 자체가 이번 결정과 모순 |
| **301 로 `/` 리다이렉트** | 404 가 안 뜬다 | 「점 페이지 → 학습 톱」 이라는 동선이 남는다. 크롤러에도 「같은 것을 옮겼다」로 읽힌다 |
| **DB 열까지 한 번에 drop** | 폴리시를 「보관하지 않는다」로 단언 가능 | **되돌릴 수 없다.** 체험 7일에서 배운 것 — 2단계로 나누면 문제가 났을 때 원인이 갈린다(D4) |
| **`fortune_bridge` 즉시 개명** | 이름과 실체가 맞는다 | 원고 303일·`render.mjs`·관문 3종·마이그레이션이 같이 흔들린다. 실체는 이미 「오늘의 한마디」고 운세 단정은 금지 중 — **이번 diff 밖**(D5) |

**이 작업이 가져오는 부수 이득 2개.**
1. 아침 편이 체험자 1인당 **하루 2통** 줄어든다 → LINE 무료 통수 여유(§0-◆-4 의 걱정이 완화)
2. `.cpanel.yml` 의 engine 복사와 `node:vm` 이 사라져 **배포 단계와 런타임이 단순해진다**

**감수하는 손실.**
- 무료 콘텐츠 유입면 3장(오미쿠지·길방·부적)이 사라진다 → SEO·AdSense 유입 감소.
  대체는 `docs/marketing.md` 의 다른 채널로 (이번 범위 밖)
- 이미 「운세가 온다」고 듣고 들어온 기존 이용자에게는 **공지가 필요**하다 → §8

---

## 7. 제외 (scope 밖 — 이번에 손대지 않는다)

- **`js/name-learn-data.js` · `server/lib/kana2hangul.mjs` · `verify-kana`** — 이름 변환. 계속 쓴다
- **`content_templates.fortune_bridge`** — D5(가). 개명은 별건
- **DB 열 drop** — D4(나). 별건 마이그레이션 010
- **원고 303일 본문** — 운세 단정은 `content-check` 가 이미 금지 중. 전수 재검은 별건
- **리치메뉴 이미지 재제작** — 운세 항목 없음
- **가격표·패키지·체험 7일** — 이번 피벗과 무관. 건드리지 않는다
- **`SALES_MODE=open`(C4)** — Stripe 승인 후에 재개. 이 작업의 **선행조건**이지 일부가 아니다
- **도달 불가가 된 코드의 철거** — D7-2 로 `/line/link/start` 를 닫은 결과,
  `completeLink`·`greet`·`resultPage` 의 연동 성공 경로와 `pending_links` 표가
  **생산자 없는 코드**가 됐다. 지우면 관문 8항목이 같이 흔들려 이번 변경의
  성패를 못 가린다 — **별건**으로 남긴다（D4(나) 열 drop 과 한 묶음이 자연스럽다）

---

## 8. 기존 이용자 공지 (문면 초안 — 대표 확정 필요)

운세를 받고 있던 이용자에게는 **말없이 사라지는 것이 가장 나쁘다.**
전환 배포 당일 아침 편 앞에 1통.

```
いつもご利用ありがとうございます。

本日より、Kstudy101 は「LINEで学ぶ 1日1分 簡単韓国語」に
一本化いたします。毎朝の運勢・お守りのお届けは終了しました。

これまでどおり、朝7時のレッスンと夕方6時の復習は続きます。
お持ちの日数は変わりません。
```

**「日数は変わりません」を必ず入れる** — 실제로 안 변하고(운세는 일수를 소비하지 않았다),
빠뜨리면 문의가 몰린다.

---

## 9. 구현 체크리스트 (승인 후 여기에 `[x]`)

### P2 — LINE 서버 ✅ **구현 완료 (2026-08-16) · 배포 대기**
- [x] P2-1 `push-daily.mjs` — import·`fortuneSkips`·함수 4개·호출부 3곳·통수 상한
- [x] P2-2 `server/lib/fortune.mjs` `fortune-text.mjs` 삭제
- [x] P2-3 `onboarding.mjs` 문면 3곳 (+ 파일 머리말)
- [x] P2-4 `pages.mjs` 문면 4곳 + 사이트명 통일
- [x] P2-5 `.cpanel.yml` engine 복사 · `deploy-server.yml` 감시 항목
- [x] P2-6 `verify-fortune-server` 폐지 · `verify-push` 개필 · **`deploy.yml` 의 해당 스텝 제거**
      ※ `deploy.yml` 은 `server/**` push 에도 도므로, 관문 파일만 지우고 스텝을 남기면
        **P2 push 시점에 CI 가 즉시 멈춘다**. 계획에서는 P1 항목이었지만 P2 로 앞당겼다
- [x] P2-6b 삭제된 파일을 가리키던 주석 정리 — `content-check` `kana2hangul` `render`
      `repo/users` `who` `.env.example`
- [x] P2-7 관문 18종 전부 PASS (`verify-push` 55→52 항목 · 신설 4항목 포함)
- [x] P2-8 **ChemiCloud 배포 완료**（2026-08-16 `e1a3a44` · UAPI · `/health` ok ·
      cron 3행 등록 확인 · maintain drift 는 기왕의 legacy 1건 그대로）
- [ ] P2-9 아침 편 실물 확인（운세·부적 없음）— **대표**

**P2 에서 새로 생긴 관문 4항목**(`verify-push` 의 ［廃止の見張り］):
`생년월일이 있어도 레슨 2통만` / `Flex 0통·운세 문면 0곳` /
`push-daily 에 fortune·amulet 식별자 0` / `fortune.mjs·fortune-text.mjs 부재`

### P1 — 사이트 ✅ **구현 완료 (2026-08-16) · 배포는 P2 확인 후**
- [x] P1-1 페이지·JS·데이터 삭제 — D1(가)·D3(가). 13 파일
      （+ 고아가 된 생성기 3개와 `data/naoj-reference.json` 도 함께.
        `verify-saju`/`verify-gilbang` 만 읽던 기준값이라 소비자가 0이 됐다）
- [x] P1-2 `index.html` 푸터 — 5링크 → `/tips` 1개
- [x] P1-3 `PUBLIC` / `TARGETS` / `sitemap.xml` / `robots.txt` / `deploy.yml` — **5곳 전부**
- [x] P1-4 관문 7종 폐지 · `verify-pages` 수정（20항목 · 6페이지）
- [x] P1-5 `.htaccess` 410 — D2(가). `words` 도 포함해 4 URL
- [x] P1-6 `bash tools/build-site.sh` 통과 — dist 25 → **13 파일**

**P1 에서 드러난 것 2건**（계획에 없던 파급）
- `verify-name` 이 `study.js`·`saju.js` 와 **사본 대조**를 하고 있었다.
  상대가 사라지면 그 항은 **항상 통과**한다 — 항목째 삭제（23→22항목）
- `verify-server` 의 「gender 白リスト가 ENUM 과 일치」는 `startLink` 를 보고 있었다.
  D7-2 로 그 입구가 사라졌으므로 **「입구가 없다」로 검사를 뒤집었다**

### P3 — 폴리시·관문·문서 ✅ **구현 완료 (2026-08-16)**
- [x] P3-1 `privacy.html` — 제1항 전면 재작성 · 보관 표에서 생년월일/진단결과 행 삭제 ·
      제2항에 「生年月日は取得しません」 신설 · 제3·5·6·7·8·11항과 푸터 · 갱신일
- [x] P3-2 `verify-no-fortune.mjs` 신설 (D6) — 10항목. 변이시험 3종 검출 확인
- [x] P3-3 `CLAUDE.md` · `STATUS.md` · `README.md` · 구 계획서 3건 머리말
- [x] P3-3b **D7-2 구현** — `POST /line/link/start` 폐지（라우트·핸들러·CORS·
      `startLink`·`normalizeProfile`）. `verify-onboarding` 의 [입력]·[CORS] 절을
      「입구가 없다」로 반전（72→67항목, 전부 PASS）
- [ ] P3-4 §8 공지 문면 확정·발송 — **대표**
- [ ] P3-5 대표 실기 4건 (`fortune-lines.json` 삭제 · Stripe · LINE · Search Console)

### 최종 검증
- [x] 관문 전종 PASS — **12종**（`no-fortune` `name` `pages` `server` `webhook`
      `onboarding` `render` `push` `evening` `billing` `quiz` `kana`）
- [x] `grep` 전수 0 — `verify-no-fortune` 이 자동으로（공개 6페이지 · 문면 13파일）
- [x] 배포 후 `/omikuji` `/gilbang` `/amulet` `/words` → **410** · `/saju.js` → **404**
      （`deploy.yml` 스모크 30항목 + 실측 둘 다 확인）
- [ ] `accel-day` 로 아침 편에 운세·부적이 없는 것 확인
