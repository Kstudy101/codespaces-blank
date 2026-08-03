# research.md — 이 저장소가 지금 어떻게 동작하는가

작성: 2026-08-03 / 대상: `Kstudy101/codespaces-blank` → <https://www.kstudy101.jp/>

> 이 문서는 **계획서보다 먼저 있었어야 했습니다.** 1단계(코드리서치)를 건너뛰고
> 계획부터 쓴 대가가 실제로 났습니다 — 원안이 존재하지 않는 파일 15개를 전제했고,
> 저는 계획서를 쓰기 시작한 뒤에야 그것을 발견했습니다. 그리고 이번에는 **이미 만들어져
> 있던 `server/` 30개 파일을 못 보고** 「전부 푸시되어 있습니다」라고 보고했습니다.

---

## 0. 조사하며 발견한 것 (먼저 읽을 것)

### 0.1 미추적 파일 33개

```
?? server/                       LINE 배포 백엔드 (Node.js + MySQL) 28개 파일
?? tools/verify-onboarding.mjs   606행
?? tools/verify-server.mjs       860행
?? tools/verify-webhook.mjs      466행
 M .github/workflows/deploy.yml  +62행
 M .gitignore                    +6행
 M README.md                     +368행
 M index.html                    +159행  (LINE 유도 섹션)
 M tools/build-site.sh           +14행
```

합계 약 2,900행이 커밋되지 않은 상태입니다.

### 0.2 ⚠️ 폴리시와 서버 스키마가 정면으로 모순됩니다

`privacy.html` 1항이 지금 이렇게 말합니다.

> 当サイトの診断機能・運勢機能に入力された**お名前・ふりがな・生年月日・出生時刻・出生地**は、
> **サーバーに送信されず、保存もされません**。
> …
> 運営者が入力内容を閲覧することはできません

그런데 `server/db/schema.sql` 은 그것들을 **MySQL에 저장**합니다.

| 테이블 | 컬럼 | 폴리시가 부정하는 것 |
|---|---|---|
| `users` | `name_kanji` `name_reading` `name_kr` | 이름·후리가나 |
| `users` | `display_name` `line_user_id` | (폴리시에 없는 항목) |
| `saju_profiles` | `birth_date` `birth_time` `gender` | 생년월일·출생시각 |
| `pending_links` | 위 6개 전부 | 동일 |

폴리시에 **LINE 이라는 단어가 0회** 나옵니다. 서비스 자체가 기재되어 있지 않습니다.

**이건 지금까지 두 번 겪은 것과 같은 패턴이되, 훨씬 무겁습니다.**
GA4·Clarity 때는 「Cookie를 쓰지 않는다」가 거짓이 되는 문제였지만,
이번에는 **개인정보를 실제로 데이터베이스에 넣으면서 「저장하지 않는다」고 적어둔 상태**입니다.

> 사이트 진단 기능과 LINE 서비스는 별개이므로, 나누어 적으면 양쪽 다 사실로 만들 수
> 있습니다. 다만 **지금은 나뉘어 있지 않고, LINE 서비스가 폴리시에 존재하지 않습니다.**
> 서버를 공개하기 전에 반드시 해결해야 합니다.

#### 0.2.1 다만 — 지금 당장은 안전합니다 (이중 잠금)

조사해 보니 **모순이 라이브로 나가 있지는 않습니다.** 두 겹으로 막혀 있습니다.

**① 배포되지 않았습니다.** `index.html` 의 LINE 섹션 +159행은 미커밋이므로 서버에
올라가 있지 않습니다. 배포본에서 `LINE` 이 4건 잡히지만 전부 **SNS 공유 버튼**
(`<span class="ic">◗</span>LINE<small>送る</small>`)이고 메시징 기능이 아닙니다.

**② 코드에도 게이트가 있습니다.** 커밋하더라도 아래 때문에 카드가 렌더되지 않습니다.

```js
const LINE_LINK_API = '';
…
if (!LINE_LINK_API || !b || !state || !state.fullH){ card.hidden = true; return; }
```

주석에 이유가 적혀 있습니다.

> `LINE_LINK_API` が空のあいだ、カードは出ない。空のまま置いてあるのは
> 「サーバーに送信されず、保存もされません」と書いているため。

**즉 이 코드를 쓴 시점에 이미 폴리시 충돌을 알고 의도적으로 잠가 둔 것입니다.**
문제는 「지금 위험하다」가 아니라 **「이 URL 한 줄을 채우는 순간 폴리시가 거짓이 된다」**
는 점입니다. 게이트를 여는 작업과 폴리시 개정은 반드시 같은 커밋이어야 합니다.

#### 0.2.2 연동 시 서버로 가는 항목 (8개)

화면에도 목록으로 보여 주고 있습니다 — 「連携すると、次の内容が配信サーバーへ送信されます」.

| key | 라벨 | 폴리시가 부정하는가 |
|---|---|---|
| `nameKanji` | お名前（漢字） | **예** |
| `nameReading` | ふりがな | **예** |
| `nameKr` | 韓国語表記 | 파생값 |
| `birthDate` | 生年月日 | **예** |
| `birthTime` | 生まれた時刻 | **예** |
| `gender` | 性別 | (폴리시에 없음) |
| `ohaengMain` | 名前の五行 | 파생값 |
| `rawResult` | 今日の診断結果 | 파생값 |

「送信するのは上に挙げたものだけです。ボタンを押さなければ、これまでどおり何も
送信されません。」 — 문구 자체는 정직하게 쓰여 있습니다. 폴리시만 따라가면 됩니다.

### 0.3 계획서와 어긋나는 부분

`docs/plan-fortune-content.md` 는 이렇게 적혀 있습니다.

> ChemiCloud(Node.js 백엔드)를 **사용하지 않습니다** … 추후 프리미엄 다운로드/AI 첨삭 등
> 진짜 서버 로직이 필요한 기능을 위해 남겨둡니다

`server/package.json` 의 설명은 이렇습니다.

> LINE 配信システム。サイト本体（静的）とは別に **ChemiCloud で動く**

즉 **계획서가 「나중」으로 미뤄둔 것이 이미 만들어졌습니다.** 계획서를 갱신해야 합니다.

---

## 1. 사이트 본체 (정적) — 현재 구조

빌드 도구 없음. `package.json` 없음(서버 쪽에만 있음). 번들러 없음.

### 1.1 페이지 9장

| 파일 | URL | 행수 | 성격 |
|---|---|---|---|
| `index.html` | `/` | 3,515 | 이름 진단 + 오늘의 운세. **CSS·JS 인라인, 자체 완결** |
| `amulet.html` | `/amulet` | 671 | 부적 메이커 |
| `gilbang.html` | `/gilbang` | 363 | 길방 |
| `privacy.html` | `/privacy` | 361 | 프라이버시 폴리시 |
| `tips.html` | `/tips` | 286 | 豆知識 |
| `omikuji.html` | `/omikuji` | 274 | 오미쿠지 |
| `words.html` | `/words` | 256 | 단어장 |
| `contact.html` | `/contact` | 205 | 문의 |
| `404.html` | (오류) | 63 | AdSense 미탑재(정책) |

`index.html` 만 인라인이고, 나머지 8장은 `page.css` 를 공유합니다.

### 1.2 공용 JS 7개

| 파일 | 행수 | 역할 |
|---|---|---|
| `saju.js` | 303 | 사주 4주 계산. 절기·일주·시주·진태양시·서머타임 |
| `fortune.js` | 327 | 6항목 점수 + 전회 비교 |
| `study.js` | 315 | 단어장·출석·발음(SpeechSynthesis) |
| `amulet.js` | 238 | Canvas 부적 렌더링 |
| `omikuji.js` | 190 | 추첨 + 하루 1회 |
| `gilbang.js` | 152 | 방위 산출 |
| `birth.js` | 119 | 생년월일시 입력 폼 (공용) |

### 1.3 데이터

| 파일 | 크기 | 출처 |
|---|---|---|
| `kanji.json` | 65KB | 상용한자 2,136자 (`data/kanji_platform.db` 에서 생성) |
| `solar-terms.json` | 15KB | 24절기 시각. skyfield + de421 로 계산 |
| `new-moons.json` | 1.6KB | 삭(신월). 손없는 날 산출용 |
| `data/naoj-reference.json` | 76KB | **국립천문대 공표값**. 검증 기준. 배포 안 함 |

### 1.4 배포

```
main push → GitHub Actions
  → verify-{saju,fortune,study,name,omikuji,gilbang,amulet,pages}.mjs  (8종)
  → tools/build-site.sh  → dist/  (공개 파일만 + ?v=해시 부여)
  → rsync over SSH (포트 10022) → Xserver
  → 스모크 테스트 (URL·헤더·비공개 파일 차단)
```

**`tools/build-site.sh` 의 `PUBLIC` 배열에 없는 파일은 배포되지 않습니다.**
`tools/set-site-url.py` 의 `TARGETS` 배열에 없으면 도메인 이전 시 누락됩니다.
새 페이지를 만들 때 두 배열을 모두 고쳐야 합니다.

### 1.5 인프라에서 배운 것 (재발 방지)

- **Xserver 는 Apache 앞에 nginx 가 있습니다.** URL 단위로 응답을 캐시하므로,
  `.htaccess` 로 `no-cache` 를 줘도 이미 캐시된 응답은 바뀌지 않습니다.
  → 공용 JS·CSS 참조에 `?v=<내용해시>` 를 붙여 해결했습니다
- **`.htaccess` 가 확장자 없는 URL 을 처리**합니다. `/privacy` → `privacy.html`.
  단 `/privacy.html` 은 `/privacy` 로 **301** 하므로, 배포 검증 시 `-L` 이 필요합니다
- **apex → www 로 301** 합니다(서버 패널 설정). `.htaccess` 를 반대 방향으로 쓰면
  무한 루프가 됩니다

---

## 2. 사주 엔진 (`saju.js`) — 검증된 부분

국립천문대 공표값과 대조해 20항목 통과했습니다(`tools/verify-saju.mjs`).

- 절기 시각 456건, 최대 오차 1분
- 일주 기준일: 연속 540일 전건 일치
- 시주: 진태양시(도쿄 +19분 / 서울 −32분), 서머타임(1948~88), 조자시 고정

**검증이 잡아낸 실제 버그 2건**
- 균시차 부호 반전 — 시지가 경계에서 한 칸 밀림 (최대 33분 어긋남)
- 「1984-02-02 = 갑자일」이 사실이 아님 (실제로는 병인, 갑자일은 01-31)

---

## 3. `server/` — 조사 결과

### 3.1 구조

```
app.mjs               HTTP 진입점. 4개 경로
  /webhook            LINE 웹훅 (서명 검증)
  /link/start         LINE 로그인 시작
  /link/callback      콜백
  /health             헬스체크

lib/handlers/         follow · link · message · postback
lib/repo/             users · learning · billing · links · pushlogs
lib/                  line · linelogin · signature · token · db · env · jst · pages · sqlfile
db/schema.sql         MySQL 9 테이블
db/migrate.mjs        마이그레이션 (--check 지원)
db/smoke.mjs          연결 확인
```

의존성은 `mysql2` 하나뿐입니다. Node ≥20.

### 3.2 테이블 9개

`users` `saju_profiles` `purchases` `subscriptions` `learning_progress`
`content_templates` `push_logs` `quiz_checkpoints` `pending_links`

**유료 과금이 들어 있습니다** — `purchases.package_type` 이
`7days/14days/30days/60days/101days`, `price_paid` 는 엔화 정수.
`subscriptions` 에 3일 무료 체험(`trial_start`/`trial_end`).

### 3.3 사이트 본체와의 연결

`index.html` 에 +159행이 들어가 있습니다 — `id="line-go"`, `id="s-line"` 등
LINE 유도 섹션입니다. **즉 정적 사이트에서 LINE 서비스로 보내는 동선이 이미 있습니다.**

### 3.4 검증 스크립트 3개 (미추적)

`verify-server.mjs`(860행) · `verify-webhook.mjs`(466행) · `verify-onboarding.mjs`(606행).
합계 1,932행.

**워크플로 등록은 확인했습니다.** 미커밋 `deploy.yml` +62행에 세 단계가 들어 있습니다.

```yaml
- name: Verify server      → node tools/verify-server.mjs
- name: Verify webhook     → node tools/verify-webhook.mjs
- name: Verify onboarding  → node tools/verify-onboarding.mjs
```

즉 커밋하면 기존 8종에 더해 **11종이 배포 전에 돌게** 됩니다.

---

## 4. 아직 조사하지 않은 것 (정직하게 남김)

- `server/lib/**` 각 파일의 **내부 로직** — 파일 목록·역할·스키마는 봤지만
  핸들러와 repo 의 코드는 읽지 않았습니다
- 미커밋 `README.md` +368행의 내용
- ChemiCloud 계정·배포 방식의 구체 (SSH? Git? 패널 업로드?) — **결정됨: ChemiCloud 사용**
- `server/.env.example` 이 요구하는 설정 항목 전체

조사 완료로 바뀐 것:
- ~~deploy.yml 이 서버 검증을 어떻게 걸었는지~~ → §3.4
- ~~LINE 섹션이 폴리시·동의와 어떻게 연결되는지~~ → §0.2.1 / §0.2.2

---

## 5. 다음에 결정해야 할 것

1. **폴리시** — LINE 서비스에서 이름·생년월일을 DB에 저장한다는 사실을 어떻게 적을지.
   사이트(저장 안 함)와 LINE(저장함)을 나누어 쓰면 양쪽 다 사실이 됩니다.
   **서버 공개 전 필수.**
2. **미추적 2,900행을 커밋할지** — 커밋하면 `server/` 가 공개 저장소에 들어갑니다.
   `.env` 는 `.gitignore` 에 있으나, 스키마·핸들러 로직은 공개됩니다
3. **계획서 갱신** — 「ChemiCloud 사용 안 함」이 더 이상 사실이 아닙니다
4. ~~**배포 파이프라인**~~ → **결정됨: ChemiCloud 사용.**
   현재 Xserver rsync 파이프라인과는 별개 경로가 됩니다.
   `LINE_LINK_API` 에 넣을 URL(예: `https://api.kstudy101.jp`)과
   그 도메인·SSL·기동 방식을 정해야 합니다
