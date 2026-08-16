# research-fortune-removal.md — 운세(사주·오미쿠지·부적·길방)가 어디에 박혀 있는가

작성: 2026-08-16
계기: **Stripe 심사 기준상 승인 불가** → 사업을 「순수하게 LINE으로 배우는 공부」로 전면 전환.
계획서: [plan-fortune-removal.md](plan-fortune-removal.md) — **구현은 계획 승인 후.**

이 문서는 「무엇을 지워야 하는가」의 **전수 목록**이다. 판단은 하지 않고 사실만 적는다.
판단(무엇을 지우고 무엇을 남길지)은 계획서에서 대표 결정 항목으로 올린다.

---

## 0. 먼저 알아야 할 사실 — LP 본문에는 이미 운세가 없다

`index.html` 은 2026-08-10 LP 전환(§0-◆◆)으로 **이름 진단·운세 표시가 이미 빠져 있다.**
지금 남아 있는 것은 **푸터 링크 3줄뿐**이다.

```html
<!-- index.html:339-345 -->
<p class="foot-meta">
  <a href="/omikuji">おみくじ</a>・
  <a href="/gilbang">今日の吉方位</a>・
  <a href="/amulet">お守り</a>・
  <a href="/words">単語帳</a>・
  <a href="/tips">韓国語の豆知識</a>
</p>
```

그러나 **링크만 지우면 문제는 해결되지 않는다.** 이유 3가지:

1. `/omikuji` `/gilbang` `/amulet` 3장은 **여전히 배포되고 200을 반환**한다
   (`build-site.sh` 의 `PUBLIC` / `sitemap.xml` / `deploy.yml` 스모크). 심사는 사이트 전체를 본다
2. **`sitemap.xml` 이 3장을 크롤러에 계속 신고**한다 — 링크를 지워도 색인은 남는다
3. **LINE 아침 배신 본체가 매일 운세 1통 + 부적 Flex 1통을 보낸다**
   (`push-daily.mjs` 의 `fortuneSection` / `amuletSection`). 결제와 직결되는 것은 이쪽이다

즉 이 작업의 실체는 **LP 링크 삭제가 아니라 4개 층의 제거**다.

---

## 1. 층별 전수 목록

### 층 1 — 사이트 페이지 (Xserver, `main` push 로 자동 배포)

| 파일 | 성격 | 운세 의존도 |
|---|---|---|
| `omikuji.html` (13KB) | **페이지 전체가 운세** — 토정비결 오미쿠지 | 전면 |
| `gilbang.html` (17KB) | **페이지 전체가 운세** — 오늘의 길방위·손없는 날 | 전면 |
| `amulet.html` (32KB) | **페이지 전체가 운세** — 부적 메이커 | 전면 |
| `words.html` (12KB) | 단어장. 저장 경로가 **「今日の運勢」에서 저장** 이었다 | 문면 4곳 + **기능적 고아** |
| `index.html` | LP | 푸터 링크 3개 |
| `privacy.html` | 폴리시 | **10곳** (§ 저장 항목·운세 점수·오미쿠지 결과·四柱) |
| `tips.html` `contact.html` `tokushoho.html` `404.html` | — | **0곳** (깨끗) |

**`words.html` 이 이미 고아인 것에 주의.** 본문이 「トップページの「今日の運勢」で保存した韓国語が並びます」
「🔮 今日の運勢を見る → `/`」 라고 안내하는데, `/` 는 2026-08-10 부터 LP 라서 **저장하는 화면이 존재하지 않는다.**
즉 지금도 「저장한 적 없는 빈 단어장 + 죽은 안내」 상태다.

### 층 2 — 사이트 JS·데이터

| 파일 | 읽는 쪽 | 운세 제거 후 |
|---|---|---|
| `saju.js` (15KB) | `gilbang.html` `amulet.html` + **서버 `node:vm`** | 소비자 0 |
| `fortune.js` (16KB) | **서버 `node:vm` 전용** (LP 전환으로 웹 소비자 소멸) | 소비자 0 |
| `omikuji.js` (9KB) | `omikuji.html` | 소비자 0 |
| `gilbang.js` (7KB) | `gilbang.html` `amulet.html` | 소비자 0 |
| `amulet.js` (12KB) | `amulet.html` | 소비자 0 |
| `birth.js` (5KB) | `gilbang.html` `amulet.html` | 소비자 0 |
| `study.js` (15KB) | `omikuji.html` `amulet.html` `words.html` | `words.html` 을 남기면 소비자 1 |
| `solar-terms.json` (16KB) | `saju.js` · `gilbang.html` · `amulet.html` · **서버 engine** | 소비자 0 |
| `new-moons.json` (2KB) | `gilbang.js` `gilbang.html` | 소비자 0 |
| `kanji.json` (65KB) | `amulet.js` · `js/name-learn-data.js`(비공개) | **공개 소비자 0** / 비공개 1 |

`js/name-learn-data.js` 는 **가나→한글 정본**이며 `PUBLIC` 밖(비공개)이다. `verify-kana` 가
서버 사본 `server/lib/kana2hangul.mjs` 와 전수 대조하므로 **이 파일은 그대로 둔다** — 이름 변환은
LINE 온보딩에서 계속 쓴다. 다만 이 파일이 `fetch('kanji.json')` 을 **선택적으로** 읽는다(없으면 null).

### 층 3 — LINE 배신 서버 (`server/`, ChemiCloud)

**사용자에게 실제로 매일 도착하는 운세는 여기다.**

| 위치 | 무엇 | 비고 |
|---|---|---|
| `server/lib/fortune.mjs` (102줄) | `node:vm` 으로 사이트 `saju.js`+`fortune.js` 실행 | 파일 전체가 운세 |
| `server/lib/fortune-text.mjs` (218줄) | 점수·십신 → 읽는 문장 | 파일 전체가 운세 |
| `server/db/push-daily.mjs:165-220` | `fortuneSection()` — **아침 3통째 = 운세 본문** | 삭제 대상 |
| `server/db/push-daily.mjs:223-274` | `amuletSection()` `amuletInvite()` — **부적 Flex + `/amulet?cat=` 링크** | 삭제 대상 |
| `server/db/push-daily.mjs:371-373, 551-560, 639-647` | 위 두 함수의 **호출부 3곳** | 삭제 대상 |
| `server/lib/onboarding.mjs:105-117` | `serviceGuide()` — 「**四柱**で学びます」「韓国式の占い（사주·운세·기운）が毎朝つきます」 | **문면 개필** |
| `server/lib/onboarding.mjs:304` | `trackStarted()` — 「朝7時 文法＋会話＋単語3語（**＋ 今日の運勢**）」 | **문면 개필** |
| `server/lib/pages.mjs:119,130,131` | 오류 화면 「**占いのページ**からやり直してください」 | **문면 개필** |
| `server/lib/pages.mjs` | 사이트명 「名前で学ぶ韓国語」 1곳 | 명칭 통일 대상 |
| `server/content/fortune-lines.json` | 운세 문면 30칸+십신 10칸. **서버에만 있음**(저장소에 없음) | 서버에서 제거 |
| `.cpanel.yml:54-60` | 배포마다 `saju.js`/`fortune.js`/`solar-terms.json` → `$APP/engine/` **복사** | 삭제 대상 |
| `.github/workflows/deploy-server.yml:34` | `solar-terms.json` 변경 감시 | 삭제 대상 |
| `server/.env.example` | 1곳 | 확인 필요 |

**아침 편의 통수가 바뀐다.** 지금은 「레슨 + 운세 + 부적 Flex(+퀴즈 꼬리)」 이고, 상한 5통 로직
(`push-daily.mjs:639`) 이 운세 유무를 본다. 운세·부적이 빠지면 **통수가 줄고 LINE 무료 통수 여유가 늘어난다**
(체험자 1인당 하루 −2통). 부작용이 아니라 이득이다.

### 층 4 — 관문·CI·문서

관문 19종 중 **8종이 운세 전용**이다.

| 관문 | 대상 | 운세 제거 시 |
|---|---|---|
| `verify-saju` (41) | `saju.js` | 검사 대상 소멸 |
| `verify-fortune` (57) | `fortune.js` | 검사 대상 소멸 |
| `verify-omikuji` (49) | `omikuji.js/html` | 검사 대상 소멸 |
| `verify-gilbang` (38) | `gilbang.js/html` | 검사 대상 소멸 |
| `verify-amulet` (93) | `amulet.js/html` + **「トップから부적への導線がある」(404행)** | 검사 대상 소멸 |
| `verify-birth` (8) | `birth.js` | 검사 대상 소멸 |
| `verify-fortune-server` (45) | 서버 운세 + **「server/ 에 saju.js 사본 금지」** | 검사 대상 소멸 |
| `verify-study` (5) | `study.js` | `words.html` 존치 여부에 연동 |

**남는 11종 중에도 운세 문자열을 찾는 검사가 섞여 있다.**

| 관문 | 걸리는 곳 |
|---|---|
| `verify-pages` (12) | `PAGES` 표에 `omikuji/gilbang/amulet/words` 4장 등록 · noindex 판정 문구 「words・404 のみ noindex」 · `amulet.html ?cat=` 검사 |
| `verify-push` (55) | 운세·부적 섹션의 동작 검사 |
| `verify-onboarding` (46) | `serviceGuide` 문면 대조 |
| `verify-render` (32) | `fortune_bridge`(🍀 今日のひとこと) |
| `verify-quiz` (12) | content-check 의 운세 단정 금지 규칙 |
| `verify-name` (10) / `verify-kana` | `kanji.json` · 가나 표 |
| `verify-webhook` (12) | 웰컴 문면(현재 깨끗) |
| `verify-evening` (1) | 주석 1곳 |
| `verify-server` (6) | 배포 제외 목록 |

**CI 배선 4곳** (`CLAUDE.md` 의 「페이지를 추가하면 4곳」의 역방향):

- `tools/build-site.sh` 의 `PUBLIC` 배열 — 9개 항목(3 html + 6 js/json)
- `tools/set-site-url.py` 의 `TARGETS` — 3개 항목
- `sitemap.xml` — `/omikuji` `/gilbang` `/amulet` 3개 `<url>`
- `.github/workflows/deploy.yml` — 관문 8스텝 + 스모크 3줄(544·547·553-554행) + 도착지 판정(502행)

### 층 5 — 폴리시·법정 표기

`privacy.html` **10곳**. 저장 항목 표에 「運勢の点数」「おみくじの結果」「運勢を見た日」 행이 있고,
제2항이 「四柱や運勢に関するページで入力された…」 로 시작한다.
`privacy.html:413` 에는 「占い・鑑定として提供するものではありません」 면책 문장도 있다.

> `CLAUDE.md` 규칙: **폴리시와 코드가 어긋난 적이 4번 있다. 저장 항목을 바꾸면 같은 커밋에서 고친다.**
> 이번은 「저장 항목을 **줄이는**」 방향이라 같은 규칙이 그대로 적용된다.

`tokushoho.html` 은 운세 언급 **0곳** (서비스명은 이미 「LINEで学ぶ 1日1分 簡単韓国語」).

### 층 6 — DB 스키마

| 열 | 표 | 지금 쓰는 곳 |
|---|---|---|
| `birth_date` `birth_time` `birth_confirmed` | `users` | **운세 계산 전용** (`fortuneFor`). 온보딩은 2026-08-10 부터 안 물음 |
| `gender` `ohaeng_main` `raw_result_json` | `users` | 사주 진단 결과. 온보딩에서 이미 제거 |
| `fortune_bridge` | `content_templates` | **운세가 아니라 레슨 말미의 🍀 今日のひとこと** (`render.mjs:275`) |

**`fortune_bridge` 는 이름만 운세다.** 지시서㉑ §1-3 에서 운세 메시지에서 **떼어내 레슨 최하단으로 옮겼고**,
`content-check.mjs:327` 이 「운세 단정(運がよ／운이 좋 류)은 쓸 수 없습니다」 로 **이미 금지**하고 있다.
즉 지금 실체는 「그날 문법으로 말하는 한마디」다. **삭제 대상이 아니라 개명 후보**다.

### 층 7 — 문서

`STATUS.md`(12) · `README.md`(53) · `CLAUDE.md`(2) · `docs/` 다수.
`CLAUDE.md` 의 **「운세 엔진의 사본을 server/ 에 두지 않는다」 조항은 엔진이 사라지면 무의미**해진다.

---

## 2. 지금 사용자에게 실제로 보이는 운세 (문면 기준)

코드 주석을 뺀 **진짜 노출면**은 다음이 전부다.

| # | 어디 | 무엇 |
|---|---|---|
| 1 | LP 푸터 | `おみくじ`・`今日の吉方位`・`お守り` 링크 3개 |
| 2 | `/omikuji` `/gilbang` `/amulet` | 페이지 3장 전체 |
| 3 | `/words` | 「今日の運勢で保存した」 안내 4곳 |
| 4 | `/privacy` | 저장 항목 표·제2항 등 10곳 |
| 5 | **LINE 아침 7시** | 운세 본문 1통 (`🔮 오늘의 운세 총운 …`) |
| 6 | **LINE 아침 7시** | 부적 Flex 1통 (`🔮 きょうの特別なお守り` → `/amulet?cat=`) |
| 7 | **LINE 온보딩** | `serviceGuide` 「韓国式の占い（사주·운세·기운）が毎朝つきます」 |
| 8 | **LINE 코스 개시** | `trackStarted` 「（＋ 今日の運勢）」 |
| 9 | LINE 오류 화면 | 「占いのページからやり直してください」 3곳 |

5·6·7·8 이 **결제 상품의 설명과 직결**된다 — Stripe 가 문제 삼는 것은 여기다.

---

## 3. 이 작업에서 조용히 틀리기 쉬운 곳 (실측 근거)

1. **`sitemap.xml` 을 안 고치면 지운 3장이 크롤러에 계속 신고된다.**
   `build-site.sh` §4 가 **양방향**으로 대조하므로, 파일만 지우면 「sitemap 에 실체가 없다」로
   **빌드가 멈춘다.** 이건 사고가 아니라 안전망이 작동하는 것 — 4곳을 한 커밋에서 고치라는 규칙 그대로다
2. **`deploy.yml:502` 의 도착지 판정**은 `^(index|privacy|contact|tips|404)\.html$` 만 세고 있어
   omikuji/gilbang/amulet 는 원래 안 센다 — **여기는 손댈 필요가 없다**. 반면 544·553행 스모크는 고쳐야 한다
3. **`verify-amulet:404` 「トップから부적への導線がある」** — LP 푸터 링크를 지우는 순간 이 관문이 **RED**.
   `CLAUDE.md` 규칙 10(문면 바꾸면 관문도 같은 커밋)이 정확히 이 상황을 말한다
4. **`.cpanel.yml` 의 engine 복사를 남기면 배포가 죽는다** — `saju.js`/`fortune.js` 를 지운 뒤
   `cp -f` 가 실패하고, `.cpanel.yml` 은 `set -e` 로 12작업이 이어져 있어 **거기서 배포가 멈춘다**
5. **`push-daily.mjs:639` 의 통수 상한 로직이 `fortune` 변수를 본다** — 함수만 지우고 호출부를 남기면
   `ReferenceError` 로 아침 배치가 통째로 죽는다. 호출부는 **3곳**(371·559·639)
6. **`words.html` 을 남기면 `study.js` 도 남겨야 한다.** 반대로 지우면 `verify-study` 5항목과
   `verify-pages` 의 noindex 판정 문구(「words・404 のみ noindex」)가 같이 움직인다
7. **이미 색인된 URL 3개.** 파일만 지우면 `/omikuji` 는 404 를 반환한다. 의도적 폐지이므로
   **410 Gone** 이 더 정확한 신호다(`.htaccess`) — 크롤러가 재시도를 멈춘다
8. **`server/content/fortune-lines.json` 은 저장소에 없다.** 서버 위에만 있으므로 코드 배포로는
   사라지지 않는다. 남아 있어도 `fortuneSection` 이 없으면 아무도 안 읽지만, 유료물이 서버에
   남는 것이므로 **별도로 지우는 작업**이 필요하다
9. **DB 열을 지우는 것은 되돌릴 수 없다.** `birth_date` 를 drop 하면 기존 이용자의 값이 사라진다.
   코드에서 안 읽는 것과 열을 지우는 것은 **분리해야 한다**(체험 7일 작업에서 배운 2단계 원칙)

---

## 4. 남는 것 (제거 대상이 아님)

- `js/name-learn-data.js` + `server/lib/kana2hangul.mjs` + `verify-kana` — **이름 가나→한글 변환.**
  온보딩 `reading` 단계에서 계속 쓴다
- `content_templates.fortune_bridge` → 실체는 🍀 今日のひとこと (레슨 말미). **개명 후보**
- `content-check.mjs:48` 의 `FORTUNE_ASSERT`(운세 단정 금지 정규식) — 원고에 운세성 문장이
  섞여 들어오는 것을 막는 관문. **피벗 후에는 오히려 더 필요하다**
- 리치메뉴(`richmenu.mjs`) — 운세 항목 없음. 4칸 전부 학습·결제·문의
- 웰컴보드(`follow.mjs:36-54`) — 이미 학습 문면. **깨끗**
- `tips.html` `contact.html` `tokushoho.html` `404.html` — 0곳

---

## 5. 규모 요약

| 층 | 삭제 | 개필 | 관문 |
|---|---|---|---|
| 사이트 페이지 | 3장 (+`words` 조건부) | `index` 푸터 · `privacy` 10곳 · (`words` 4곳) | — |
| 사이트 JS/데이터 | 최대 9개 파일 (~140KB) | — | — |
| LINE 서버 | 2개 파일 + 함수 4개 + 호출부 3곳 | `onboarding` 2곳 · `pages` 4곳 | — |
| CI 배선 | `PUBLIC` 9 · `TARGETS` 3 · `sitemap` 3 · `deploy.yml` 8스텝+3줄 | — | — |
| 관문 | 8종 폐지 | 6종 수정 | **신설 1종 권고** (`verify-no-fortune`) |
| 폴리시 | — | `privacy.html` 10곳 | — |
| DB | (별건·2단계) | — | — |

**신설 관문을 권고하는 이유.** 8종을 지우면 「운세가 없다」를 지키는 장치가 **하나도 남지 않는다.**
지금까지 이 저장소를 지탱한 방식은 「규칙을 문서가 아니라 관문이 강제한다」였다.
피벗 후 가장 위험한 재발은 「좋은 콘텐츠니까」 하고 운세성 문구가 원고나 문면에 다시 섞이는 것이며,
그것이 곧 **Stripe 재심사 탈락**이다.
