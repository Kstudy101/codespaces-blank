# research-audit.md — 저장소 전수 점검

작성: 2026-08-04 / 대상: `Kstudy101/codespaces-blank` (`74879e1`)
방법: 추적 중인 108개 파일 전부 열람 + `tools/verify-*.mjs` 16종 실기 실행

> `docs/research.md`(2026-08-03)의 후속입니다. 그 문서가 「아직 조사하지 않은 것」으로
> 남겨둔 `server/lib/**` 내부 로직을 이번에 전부 읽었고, 그때 미결로 적혀 있던
> 폴리시 모순은 **이미 해소되어 있음**을 확인했습니다(§1.3).

---

## 0. 요약

| 구분 | 결과 |
|---|---|
| 검증 스위트 16종 | **LF 체크아웃에서 16종 전부 통과** |
| 현재 Windows 작업 트리 | 2종 실패 — 원인은 코드가 아니라 CRLF (§3.4) |
| 발견한 실질적 결함 | **2건 (높음)** — 데이터 소실 계열 |
| 문서·정책 불일치 | 4건 (낮음) |
| 관측 공백 | 2건 (낮음) |

가장 무거운 두 건은 둘 다 **「지우면 안 되는 것을 지운다」**는 같은 성격이고,
둘 다 지금 당장은 터지지 않으며 **원고 입고가 진행되는 순간 터집니다.**

---

## 1. 이 저장소는 지금 어떻게 동작하는가

### 1.1 두 개의 독립한 시스템이 한 저장소에 들어 있다

```
저장소 (public)
├── 사이트 본체 (정적)  →  Xserver          GitHub Actions가 rsync
│     index.html 외 8장 + 공용 JS 7개 + 데이터 3종
└── server/ (Node.js)   →  ChemiCloud       cPanel Git 또는 수동 스크립트
      LINE 101일 한국어 강좌 배신 시스템
```

배포 경로가 **완전히 다릅니다.** `.github/workflows/deploy.yml`은 `dist/`만 Xserver로 보내고
`server/`는 건드리지 않습니다(`build-site.sh`의 `PUBLIC`이 허가 목록이라 애초에 들어가지 않음).
`server/`는 `.cpanel.yml`(cPanel Git Version Control) 또는 `tools/deploy-server.sh`(수동)로 갑니다.

### 1.2 server/의 구조

```
app.js          Passenger 진입점(CommonJS 1줄) → app.mjs 동적 import
app.mjs         HTTP 4경로. 서명 검증 후 200을 먼저 반환하고 뒤에서 처리
lib/
  signature     HMAC-SHA256 / base64 / timingSafeEqual — 시스템 전체의 경계
  token         state = randomBytes(32).base64url, DB에는 SHA-256만
  webhook       events 배열을 직렬로 배분. 재전송 방어는 "몇 번 해도 같음"으로
  handlers/     follow · link · message · postback
  repo/         users · billing · learning · pushlogs · links
                ↳ mysql2를 import하지 않음. 넘겨받은 conn.execute()만 사용
  db            유일하게 mysql2를 읽는 파일. 접속마다 SET time_zone='+09:00'
  render        {NAME}/{OHAENG}/{ZODIAC} × 조사 6종 치환. 받침 판정 포함
  fortune       node:vm으로 사이트의 saju.js/fortune.js를 그대로 실행 (사본 금지)
  onboarding    이름·생년월일·코스 3단계. 상태 컬럼을 두지 않고 매번 내용에서 유도
db/
  schema.sql        9테이블
  migrations/001    track / name_source / birth_confirmed / fortune_bridge / onboarding
  push-daily.mjs    아침 7시. 원고확인 → 일자확보 → 발송 → 기록 (이 순서가 전부)
  push-evening.mjs  저녁 6시. 일자를 진행시키지 않음
```

**설계상 가장 잘 지켜진 두 가지:**

1. **`repo/`는 Node 내장 모듈조차 읽지 않는다.** 그래서 `tools/verify-server.mjs`가
   `npm install` 없이, DB 없이 SQL을 읽어서 검사할 수 있습니다. 실제로 16종 전부
   설치 없이 돌아갑니다.
2. **운세 엔진 사본을 만들지 않는다.** `lib/fortune.mjs`가 `node:vm`으로 사이트의
   `saju.js`/`fortune.js`를 그대로 실행합니다. 사본을 두면 웹과 LINE의 운세가
   갈라지는데, 양쪽 다 "그럴듯한 숫자"라 대조하기 전엔 아무도 모릅니다.

### 1.3 이전 리서치의 미결 사항 — 해소 확인

`docs/research.md` §0.2가 「폴리시와 서버 스키마가 정면으로 모순」이라고 적은 건은
**해결되어 있습니다.**

- `privacy.html`에 **제2항 「LINE 배신 서비스에 대하여」**가 신설됨.
  보관 항목 7종을 표로 명시, 30분 자동 삭제, 삭제 요청 경로, 제3자 제공처까지 기재
- `index.html:3244` `LINE_LINK_API = 'https://api.kstudy101.jp'` — 게이트가 열려 있음
- 순서도 지켜졌습니다(문구 개정 → URL 투입). `verify-onboarding.mjs`가 이 순서 자체를
  검사합니다: 「연계처를 설정한다면 privacy.html이 보관한다고 적혀 있다」 → 통과

남은 불일치는 §3.5의 성별 1건뿐입니다.

---

## 2. 발견한 실질적 결함

### 2.1 【높음】`deploy-server.sh`가 서버에만 있는 101일 원고를 지운다

[tools/deploy-server.sh:101-105](../tools/deploy-server.sh#L101-L105)

```bash
rsync -az --delete --checksum \
  --exclude node_modules --exclude '.env' --exclude '.env.local' \
  ...  server/ "$CHEMI_USER@$CHEMI_HOST:$APP_ROOT/"
```

`--delete`인데 `content`가 제외 목록에 없습니다.

`server/content/`는 **`.gitignore`에 있어서 저장소에 없고, 서버 위에만 존재**합니다
(유료로 파는 101일 원고 + `fortune-lines.json`). `.cpanel.yml`은 이 위험을 알고 있고
주석에 명시까지 해 두었습니다:

> `content` 101 日ぶんの原稿。公開リポジトリに置いていないのでサーバーのここにしか無い。
> **消すと配信が止まり、手元から上げ直すまで戻らない**

같은 저장소의 다른 배포 경로는 막았는데, 이쪽만 뚫려 있습니다.

| 제외 대상 | `.cpanel.yml` rsync | `.cpanel.yml` find 대체 | `deploy-server.sh` |
|---|---|---|---|
| node_modules | ✓ | ✓ | ✓ |
| .env / .env.local | ✓ | ✓ | ✓ |
| **content** | ✓ | ✓ | **✗** |
| **stderr.log** | ✓ | ✓ | **✗** |
| **tmp** | **✗** | ✓ | ✗ (직후 재생성됨) |
| **public** | **✗** | ✓ | **✗** |

`stderr.log`도 같이 사라집니다 — `.cpanel.yml`이 「配置의 直前에 무슨 일이 있었는지가
지워지고 있었다」며 일부러 살려둔 파일입니다.

**터지는 시점:** 원고를 서버에 올린 뒤 `bash tools/deploy-server.sh`를 한 번 실행하는 순간.
`--probe`가 아닌 기본 실행 경로입니다.

### 2.2 【높음】`smoke.mjs`가 3개 코스 전부의 101일차 원고를 지운다

[server/db/smoke.mjs:43-47](../server/db/smoke.mjs#L43-L47)

```js
const TEST_DAY = 101;
/* 原稿は day_number が主キーなので… */   // ← 이 전제가 더 이상 사실이 아님
async function cleanup() {
  ...
  await pool.execute("DELETE FROM content_templates WHERE day_number = ?", [TEST_DAY]);
}
```

주석이 말하는 「`day_number`가 주키」는 `migrations/001`이 바꿔버렸습니다:

```sql
ALTER TABLE content_templates DROP PRIMARY KEY;
ALTER TABLE content_templates ADD PRIMARY KEY (track, day_number);
```

smoke는 `intermediate` 101일차 **한 행만** 넣지만([smoke.mjs:247-255](../server/db/smoke.mjs#L247-L255)),
지울 때는 `WHERE day_number = 101`뿐이라 **초급·중급·고급 세 코스의 101일차가 전부** 날아갑니다.

더 나쁜 건 실행 경로입니다. `.cpanel.yml`이 smoke를 **본번에서 돌리도록 만들어져 있고**,
그것도 seed **뒤에** 있습니다:

```
migrate  →  seed-content (원고 입력)  →  smoke (101일차 삭제)  →  restart
```

주석은 「専用의 試験用 1件만 만지고 前後로 지우므로 **本番에서도 흘릴 수 있다**」고
보증합니다. 지금은 사실입니다(101일차가 아직 비어 있음). **입고가 101일까지 도달하는
순간 사실이 아니게 됩니다.**

**터졌을 때의 증상:** 101일차는 강좌의 마지막 날(수료일)입니다. 사라지면
`push-daily.mjs`가 `"原稿なし"`로 내려오고 **일자를 소비하지 않으므로**, 그 사람은
100일차에서 영원히 멈춥니다. 발송 실패 로그는 남지만, 돈을 낸 사람이 마지막 날을
받지 못하는 형태입니다.

---

## 3. 그 밖에 확인한 것

### 3.1 검증 스위트 16종 — 실기 결과

```
verify-saju            PASS      verify-server           PASS
verify-fortune         PASS      verify-webhook          PASS
verify-study           PASS      verify-onboarding       PASS*
verify-name            PASS      verify-render           PASS
verify-omikuji         PASS      verify-push             PASS
verify-gilbang         PASS      verify-fortune-server   PASS
verify-amulet          PASS*     verify-evening          PASS
verify-birth           PASS
verify-pages           PASS                          * §3.4 참조
```

`deploy.yml`이 부르는 16개 스크립트가 `tools/`에 전부 존재하고, 전부 통과합니다.
검증 자체의 밀도도 높습니다 — 예를 들어 `verify-push.mjs`는 가짜 `send`를 넘겨서
**「호출된 그 순간의 DB 상태」**를 들여다봅니다. 「보내기 전에 일자가 확보되어 있는가」는
실물로 보내봐도 확인할 수 없는 종류라서, 이 방법 외에는 방법이 없습니다.

### 3.2 `.cpanel.yml`의 rsync 분기와 find 분기가 서로 다르다

§2.1 표의 마지막 두 행입니다. `find` 대체 경로는 `tmp`·`public`을 지키는데
rsync 경로는 지키지 않습니다. `public/`은 Passenger 앱의 문서 루트라
지워지면 앱이 뜨지 않을 수 있습니다.

다만 **주석에 따르면 그 서버에 rsync가 없어서**(초회 배치에서 127로 떨어져 확인)
현재는 `find` 분기만 실제로 돕니다. 즉 지금은 잠들어 있는 결함이고,
호스팅이 rsync를 넣는 날 깨어납니다.

### 3.3 원본 스키마와 코드가 어긋나 있으나, 마이그레이션이 메운다

`schema.sql`만 읽으면 코드가 깨져 보입니다:

| 코드가 쓰는 것 | `schema.sql` | 메우는 곳 |
|---|---|---|
| `content_templates.track` | 없음 | `migrations/001` |
| `content_templates.fortune_bridge` | 없음 | `migrations/001` |
| `learning_progress.track` | 없음 | `migrations/001` |
| `users.name_source` | 없음 | `migrations/001` |
| `saju_profiles.birth_confirmed` | 없음 | `migrations/001` |
| `push_logs.push_type = 'onboarding'` | ENUM에 없음 | `migrations/001` |

**이건 결함이 아니라 의도된 구조입니다.** `migrate.mjs`가 「에러가 안 났다」로 끝내지 않고
`information_schema`에서 이 5개 컬럼을 이름으로 다시 세므로(`EXPECTED_COLUMNS`),
마이그레이션 누락은 배치 때마다 잡힙니다.

### 3.4 검증 스크립트 2종이 CRLF 체크아웃에서 못 돈다

현재 Windows 작업 트리(`core.autocrlf=true`)에서 2종이 실패합니다:

- `verify-amulet.mjs:478` — `/<script>\n([\s\S]*?)\n<\/script>/`
- `verify-onboarding.mjs:393,402` — `/export async function completeLink[\s\S]*?\n}\n/`

둘 다 소스 텍스트를 정규식으로 뜨는데 `\n`이 하드코딩되어 있어, `\r\n`에서는
매치가 `null`이 됩니다. LF로 다시 꺼내서 돌리면 둘 다 통과하는 것을 확인했습니다:

```
$ git -c core.autocrlf=false checkout-index -a -f --prefix=<tmp>/
verify-amulet           PASS
verify-onboarding       PASS
```

CI는 ubuntu이므로 **본번 파이프라인에는 영향이 없습니다.** 다만 Windows에서
작업하는 동안 「관문을 미리 돌려본다」가 불가능합니다. `.gitattributes`가 없습니다.

### 3.5 폴리시: 성별만 아직 어긋난다

`privacy.html:209`

> 性別はお訊きしていないため、**送信も保存もされません**。

그런데 [index.html:3283](../index.html#L3283)이 보냅니다:

```js
{ key:'gender', label:null, value:'U', shown:null }
```

그리고 `pending_links.gender` / `saju_profiles.gender`에 저장됩니다.

값이 항상 `'U'`(미상)이라 개인정보가 실제로 새는 건 아니고, 「訊いていない」도 사실입니다.
문제는 **문장의 뒷부분이 사실이 아니라는 것**입니다. `verify-onboarding.mjs`조차
자기 검사 항목에 `（gender を除く）`라고 예외를 적어두고 있어서, 코드 쪽은
"보내는 걸 알고 있는" 상태입니다.

이 저장소는 같은 성격의 불일치로 이미 세 번(GA4·Clarity·LINE) 데였습니다.

### 3.6 관측 공백 2건

**(가) `birth.js`가 배포 스모크 테스트에 없다**

`deploy.yml:511-512`가 확인하는 공용 자산:
```
/saju.js /fortune.js /study.js /omikuji.js /gilbang.js /amulet.js
/solar-terms.json /new-moons.json
```
`birth.js`가 빠져 있습니다. 그런데 `birth.js`는 `index.html`·`gilbang.html`·`amulet.html`
**3장이 읽습니다.** 이게 배포되지 않으면 세 페이지의 생년월일 입력이 죽는데,
파이프라인은 초록으로 끝납니다.

**(나) `deploy.yml`의 `paths-ignore`가 서버·문서를 걸러내지 않는다**

```yaml
paths-ignore: [README.md, data/**, docs/**]
```

`server/**`만 고친 커밋도, 방금 넣은 `instruction.txt`·`CLAUDE.md` 커밋도
**Xserver 전체 rsync 배포를 발동시킵니다.** `dist/`에 들어가지 않으므로 실제 전송
내용은 동일하지만, 배포 이력이 오염되고 관문 16종이 무의미하게 돕니다.

### 3.7 확인만 해둘 것 — 온보딩 독촉 횟수가 단계별이 아니라 통산이다

[push-daily.mjs:82](../server/db/push-daily.mjs#L82) `ONBOARD_NOTICE_MAX = 3`은
`pushlogs.countByType(userId, "onboarding")` 즉 **통산 횟수**를 봅니다.

그런데 연계 직후의 인사말([link.mjs:166](../server/lib/handlers/link.mjs#L166) `greet`)도
`pushType: "onboarding"`으로 1건 기록합니다. 결과:

```
연계 완료 → greet          (1/3 소진)
다음날 아침 이름 독촉      (2/3)
그다음날 아침 이름 독촉    (3/3) → 이후 침묵
                              ↳ 코스(track) 질문은 배치에서 한 번도 못 나감
```

이름을 나중에 답한 사람에게 코스 질문이 배치로는 가지 않습니다.
`message.mjs`가 「コース」라고 보내면 답하는 문을 열어두었으므로 완전히 막히진
않지만(그리고 주석도 그 의도를 적고 있지만), **단계마다 3회인지 전체 3회인지**는
설계 의도를 확인할 값어치가 있습니다.

### 3.8 문서 표류 3건 (무해)

- `server/db/schema.sql:2` — 「8 テーブル」인데 `CREATE TABLE`이 9개(`pending_links` 추가분)
- `server/lib/app.mjs:7` — 「経路は 3 つだけ」 직후 4개를 나열, 15행에선 「4 つしか無い」
- `server/db/smoke.mjs:28` — 「原稿は day_number が主キー」 (§2.2. 이건 무해하지 않음)

---

## 4. 점검하지 않은 것 (정직하게 남김)

- `README.md`(930행) 전문 — 목차와 배포 절차만 대조했습니다
- `docs/plan-fortune-content.md`(657행) 등 계획서 4종의 **내용 정합성** —
  존재와 참조 관계만 확인
- `data/kanji_platform.db`·`data/naoj-reference.json`의 데이터 자체 —
  `verify-name`/`verify-saju`가 이것들과 대조해 통과하는 것으로 갈음
- **실제 본번 동작** — DB에도 ChemiCloud에도 접속하지 않았습니다.
  `smoke.mjs`·`check-line.mjs`·`who.mjs`는 읽기만 했습니다

---

## 5. 다음에 정해야 할 것

1. §2.1 / §2.2 — 고칩니다. 둘 다 exclude 한 줄 / WHERE 절 한 줄 수준
2. §3.5 성별 — **문구를 고칠지, 보내는 걸 그만둘지**는 대표님 판단입니다
   (서버가 기본값 `'U'`를 넣으므로 안 보내도 동작은 동일)
3. §3.7 독촉 횟수 — 설계 의도 확인
4. §3.4 `.gitattributes` — 추가할지 여부
