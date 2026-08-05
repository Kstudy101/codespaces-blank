# plan-side-menu.md — 사이드 메뉴 개편 (아코디언화·푸터 이설)

상태: **승인·주석 반영 완료(2026-08-05), 구현 진행.**

## 0. 조사 결과 (구현 전 확인된 사실)

- 사이드 메뉴(`<aside class="side">`)는 `index.html`에만 있다 (805~836행). 다른 8페이지는 푸터만.
- 푸터의 `powered by` 행은 **9페이지 공통** (404 포함: index·omikuji·gilbang·amulet·words·tips·privacy·contact·404). 다른 8페이지는 광고 고지 문단에 이미 `/privacy` 링크가 있고 `/contact`·단말 문구는 없다.
- `#side-read`는 스크롤 스파이 JS가 읽는다(`data-sec`, `.on`, `openRead()`). 접이식으로 바꿔도 이 동작을 깨면 안 된다.
- 1180px 이상에서 사이드바는 상시 표시(docked), 여닫기 버튼·스크림은 `display:none`.
- 관문 `verify-pages.mjs`가 이번에 걸리는 검사: 버튼의 읽히는 이름 · id 중복 없음 · 사이트 내 링크 실체 · 페이지 내 앵커 행선지.

## 1. 판단 4건 — 대표님 결정 (2026-08-05 주석)

| # | 결정 |
|---|---|
| **T1** | 데스크톱 포함 **양쪽 다 기본 접힘** |
| **T2** | **메뉴만** 명칭 변경: `부적メーカー` → `お守り` (일본어 내비 통일). **카드 2곳과 amulet.html의 title/h1은 기존 표기 유지** (학습·브랜드 요소 보존) |
| **T3** | 푸터 수정(privacy·contact 링크 행 + 단말 문구 행) **9페이지 공통 적용** |
| **T4** | 고아가 되는 `.side-note` CSS **삭제** |

T2 메뉴 외 의존 위치(이번 변경 없음, 기록):
`부적メーカー` — index.html 카드 2곳 / amulet.html `<title>`·`<h1>`.
`今日の吉方` — index.html 카드·본문 링크 (메뉴만 `今日の吉方位`로).
`名前を入れて診断する` — 메뉴에만 존재(한글 학습 요소 없음) → `名前から始めるハングル`로 변경.

메뉴 아이콘(이모지)은 기존 것을 유지한다 — 변경 지시가 명칭에 한정되므로.

## 2. 변경 내용

1. **CSS (index.html)** — `.side-ttl`을 버튼형으로(hover·focus-visible·`::after` 화살표 회전), **`.side-list[hidden]{display:none}` 필수**(자체 `display:flex`가 브라우저 기본 `[hidden]`을 이기므로, 없으면 hidden을 걸어도 그대로 보이고 Tab으로 숨은 링크에 들어간다). `.side-note` 규칙 삭제. reduced-motion 목록에 `.side-ttl`·`.side-ttl::after` 추가.
2. **사이드바 HTML** — 순서를 コンテンツ(구 ページ) → 読みもの로. 제목을 `<button aria-expanded="false" aria-controls=…>`로, 리스트에 `hidden`. `/privacy`·`/contact` 행과 `.side-note`는 삭제(푸터로 이설). 기존 8개 읽을거리 링크는 순서·href·data-sec 전부 무변경.
3. **푸터 (9페이지 공통)** — powered by 행 뒤에:
   `<p class="foot-meta"><a href="/privacy">プライバシーポリシー</a>・<a href="/contact">お問い合わせ</a></p>`
   `<p class="foot-meta">お名前・生年月日は端末の中だけで扱います。</p>`
   CSS `.foot-meta{margin:10px 0 0; font-size:.78rem}` — index.html의 `footer a` 뒤와 page.css에 각 1줄. `.foot-note`는 광고 고지가 쓰고 있어 재사용하지 않는다.
4. **JS (index.html)** — scrim 리스너 뒤에 아코디언 토글(한쪽을 열면 다른 쪽이 닫힘). 기존 JS(`openRead`·스크롤 스파이·여닫기)는 한 줄도 고치지 않는다.

## 3. 수정 대상 파일

index.html (CSS 2곳·HTML 1곳·푸터 1곳·JS 1곳) · page.css (1줄) · 나머지 8개 HTML (푸터 2줄씩).
sitemap.xml·build-site.sh의 PUBLIC 무변경(페이지 추가·삭제 아님).

## 4. 검증

- `node tools/verify-pages.mjs` + 관문 19종 전체 + `bash tools/build-site.sh`(내부 링크 실체).
- 확인 4가지: ① 좁은 화면에서 양쪽 접힘 ② 하나를 열면 다른 하나가 닫힘 ③ 1180px 이상에서도 동일 ④ 접힘 상태에서 Tab으로 숨은 링크에 못 들어감(`hidden`이 실제로 먹는지 — `.side-list[hidden]` 규칙의 존재 이유).

## 5. 제외 (scope 밖)

- 카드·페이지 제목의 `부적メーカー`·`今日の吉方` 문구 (T2 — 별건)
- 스크롤 스파이·`openRead` 동작 변경
- 접힘 상태 기억(localStorage 등) — 요청에 없음
