# plan-richmenu-v2 — 리치메뉴 이미지 교체와 버튼 행선지 변경

작성: 2026-08-10 · 상태: **완료 — LINE 등록까지 끝남**
（`richmenu-a62983f0be68d5a95bf7f80ae225c8c8`, 2026-08-10）

승인(2026-08-10, 대표): ① 삭제 / ② 그대로 / ③ 그대로 진행 / ④ 지금 켠다.

지시(대표):

1. 이미지를 `LINE_RichMenu_2500x1686 (2).jpg` 로 교체한다
2. **K:study101**（좌하）→ 홈페이지로 가는 링크
3. **サービス利用**（상단）→ 기존 **수강료(수강표)** 가 뜨게 한다

---

## 1. 새 이미지 — 실측

| 항목 | 값 | 판정 |
|---|---|---|
| 크기 | 2500 × 1686 | ✓ `menuDefinition()` 과 일치 |
| 용량 | 126,224 B (123KB) | ✓ LINE 상한 1MB |
| 형식 | JPEG | ✓ |

**좌표는 바꾸지 않아도 됩니다.** 새 이미지는 카드 사이에 여백이 있는 디자인이라
경계가 어디인지 눈으로는 안 보입니다. 픽셀로 흰 카드 구간을 실측했습니다:

```
가로(y=1200)  카드: 26–806 | 859–1639 | 1692–2473
              → 여백: 807–858(중앙 832.5) / 1640–1691(중앙 1665.5)
세로(x=1000)  카드: 32–753 | 812–1658
              → 여백: 754–811(중앙 782.5)
```

현행 `AREAS` 의 경계는 **786 / 833 / 1666**. 셋 다 여백 한가운데에 떨어집니다
(오차 최대 3.5px, 여백 폭 52–58px). 즉 **버튼 경계가 카드 위를 지나가지 않습니다.**

> 이 실측을 한 이유 — 경계가 1px만 카드 안쪽으로 들어가도 「눌러도 아무 일도
> 안 일어나는 띠」가 생기고, 그건 보이지 않으므로 **누른 사람만** 압니다
> (`richmenu.mjs` 머리말).

---

## 2. 바뀌는 것 — 버튼 4개 중 2개

| 위치 | 이미지의 글자 | 지금 | 바뀐 뒤 |
|---|---|---|---|
| 상단 (0,0,2500,786) | サービス利用 / COURSE GUIDE | `uri` → Notion 코스 안내 | **`postback action=plans`**（수강표） |
| 좌하 (0,786,833,900) | K:study101 / TUITION·PLANS | `postback action=plans` | **`uri` → `https://www.kstudy101.jp`** |
| 중하 (833,786,833,900) | 何日目？ / DAY COUNTER | `postback action=status` | (그대로) |
| 우하 (1666,786,834,900) | その他サービス確認 | `uri` → Notion 기타 서비스 | (그대로) |

상단과 좌하가 **서로 맞바뀌는** 모양입니다.

### 코드 (`server/lib/richmenu.mjs`) — 실제로 들어간 것

```diff
-const COURSE_GUIDE_URL =
-  "https://luxuriant-burst-b65.notion.site/Kstudy101-3b6439a4f5e7802e9739e64a0a8df5b5?source=copy_link";
 const OTHER_SERVICES_URL =
   "https://app.notion.com/p/3b6439a4f5e780d6a385caf5230aca44?source=copy_link";
+/* 「K:study101」からサイトへ。SITE_URL では読まない ── この定義を作る
+   setup-richmenu.mjs は import が loadEnv より先に走るので、環境変数から
+   読むと .env の値が黙って無視され、既定値のまま登録される。 */
+const HOME_URL = "https://www.kstudy101.jp";

 export const AREAS = Object.freeze([
   { bounds: { x: 0,       y: 0,      width: W,        height: TOP_H },
-    action: { type: "uri", uri: COURSE_GUIDE_URL } },
+    action: { type: "postback", data: "action=plans",  displayText: "受講料を見ます" } },
   { bounds: { x: 0,       y: TOP_H,  width: COL,      height: BOTTOM_H },
-    action: { type: "postback", data: "action=plans",  displayText: "受講料を見ます" } },
+    action: { type: "uri", uri: HOME_URL } },
   { bounds: { x: COL,     y: TOP_H,  width: COL,      height: BOTTOM_H },
     action: { type: "postback", data: "action=status", displayText: "進み具合" } },
   { bounds: { x: COL * 2, y: TOP_H,  width: COL_LAST, height: BOTTOM_H },
     action: { type: "uri", uri: OTHER_SERVICES_URL } }
 ]);
```

**`HOME_URL` 을 `process.env.SITE_URL` 로 읽지 않은 이유.** 계획 단계에서는
`areas()` 함수화를 기본안으로 뒀지만, 실제로는 문자열로 박았습니다 ──
`setup-richmenu.mjs` 는 `import`（21행)가 `loadEnv()`（26행)보다 **먼저** 평가되므로,
모듈 최상위에서 env 를 읽으면 `server/.env` 의 `SITE_URL` 이 **조용히 무시된 채**
기본값으로 등록됩니다. 「설정할 수 있는 것처럼 보이는데 반영이 안 되는」 형태를
만들지 않기 위해, 같은 파일의 Notion URL 2개와 같은 문자열 상수로 뒀습니다.
덕분에 `AREAS` 도 상수 그대로여서 `tools/setup-richmenu.mjs` 는 **무변경**입니다.

머리말의 배치도(ASCII)도 새 구성에 맞춰 고쳤습니다 — 그 그림이 `AREAS` 를
설명하는 그림이라, 어긋나 있으면 다음 사람이 그림 쪽을 믿습니다.

---

## 3. 결정 3가지 — **답변 반영 완료**

### ①「COURSE GUIDE」 Notion 링크가 메뉴에서 사라집니다

상단이 수강표가 되면 `COURSE_GUIDE_URL`（Notion 코스 안내）을 가리키는 버튼이
**하나도 남지 않습니다.** 선택지:

- (가) 상수째로 삭제 — 카르파티 §3「내 변경이 만든 고아는 치운다」
- (나) 상수는 남기고 주석으로 「지금은 어느 버튼도 안 씀」 명시
- (다) 어딘가에 계속 노출 — 그렇다면 어느 버튼인지 지시 필요

→ **(가) 삭제**（대표 지시）. `COURSE_GUIDE_URL` 상수를 지웠습니다.
되살릴 때는 이 커밋 이전의 git 이력에 URL 이 그대로 있습니다.

### ② 「準備中」 배지가 붙은 何日目？ 은 어떻게 합니까

새 이미지의 중앙 카드에 **`準備中`** 배지가 그려져 있습니다. 그런데 이 버튼의
`action=status` 는 **지금 동작합니다**（`postback.mjs:279` `onStatus` → `statusMessage`).

- (가) 그대로 둔다 — 이미지의 「準備中」과 실동작이 어긋납니다
- (나) 눌러도 「준비 중입니다」만 나오게 한다 — 동작하는 기능을 일부러 끕니다

→ **(가) 그대로**（대표 지시）. `action=status` 는 계속 동작합니다.
이미지의 「準備中」 배지와는 어긋난 채로 둡니다.

### ③ 이미지의 영문 부제가 실동작과 **서로 엇갈립니다**

| 카드 | 이미지에 그려진 글자 | 이 계획의 동작 |
|---|---|---|
| 상단 | サービス利用 / **COURSE GUIDE** | 수강료·결제 |
| 좌하 | K:study101 / **TUITION / PLANS** | 홈페이지 |

「TUITION / PLANS」를 누르면 홈페이지로 가고, 「COURSE GUIDE」를 누르면
가격표가 나옵니다. LINE 은 글자를 이미지 안에만 그릴 수 있으므로 **코드로는
고칠 수 없습니다** — 이미지를 다시 만들어야 합니다.

→ **그대로 진행**（대표 지시）. 부제를 맞바꾼 이미지를 나중에 주시면
`server/assets/richmenu.jpg` 만 교체하고 같은 명령을 한 번 더 돌리면 됩니다
（코드 변경 0）.

---

## 4. 지금 누르면 무엇이 나오는가 — `SALES_MODE=test`

`onPlans` 는 `salesAllowedFor(user)` 를 통과하지 못하면 `notReady()`（준비 중）만
돌려줍니다（`postback.mjs:287`）. **C4(`SALES_MODE=open`)가 보류 중**이므로
(STATUS §F), 지금 상태로 등록하면 **화면에서 가장 큰 버튼이 대부분의 사람에게
「준비 중」을 답합니다.**

→ **지금 켠다**（대표 지시）. `SALES_MODE=test` 인 채로 켜므로, 상단의 가장 큰
버튼은 **대부분의 사람에게 「준비 중」**을 답합니다. 이건 판매 게이트가 제대로
막고 있다는 뜻이지 고장이 아닙니다 — C4(`SALES_MODE=open`)를 열면 그날부터
같은 버튼이 가격표를 냅니다.

---

## 5. 고치는 파일

| 경로 | 무엇 | 결과 |
|---|---|---|
| `server/assets/richmenu.jpg` | 새 이미지로 교체（166KB → 123KB） | ✓ |
| `server/lib/richmenu.mjs` | 상단·좌하 action 교체 / `HOME_URL` 신설 / `COURSE_GUIDE_URL` 삭제 / 머리말 배치도 | ✓ |
| `tools/setup-richmenu.mjs` | — | **무변경**（`AREAS` 를 상수로 유지했으므로） |
| `STATUS.md` | 리치메뉴 항 + §0-☆-5（등록 실기） | ✓ |

## 6. 제외 (scope 밖)

- 좌표·크기·`chatBarText`·`selected` — 손대지 않음（§1 실측으로 그대로 맞음）
- `postback.mjs` 의 `onPlans`/`onStatus` 내용 — 행선지만 바꾸지 기능은 안 건드림
- `SALES_MODE` 전환(C4) — 별건
- Notion 「その他サービス」 URL — 지시 없음
- **LINE 에 실제로 등록하는 것** — 코드가 준비돼도 `setup-richmenu --image=…` 는
  대표가 실행（토큰이 필요하고, 전원 화면이 즉시 바뀝니다）

## 7. 검증

```bash
node tools/setup-richmenu.mjs --dry-run     # 4영역 합 = 2500×1686 검사
for f in saju fortune study name omikuji gilbang amulet birth pages \
         server webhook onboarding render push fortune-server evening billing quiz kana; do
  node tools/verify-$f.mjs >/dev/null && echo "PASS $f" || echo "FAIL $f"
done
```

`verify-webhook`（`:544`）가 `richmenu.mjs` 의 `displayText: "進み具合"` 를 문자열로
찾습니다 — 중앙 버튼을 그대로 두므로 통과합니다. 「受講料を見ます」 쪽도 위치만
옮기고 문자열은 같습니다.

## 8. 체크리스트

- [x] 이미지 교체 — 2500×1686 / 123KB
- [x] `richmenu.mjs` — action 교체 + `HOME_URL` + `COURSE_GUIDE_URL` 삭제 + 배치도
- [x] `setup-richmenu.mjs` — 무변경으로 끝남（`AREAS` 유지）
- [x] `--dry-run` 으로 좌표·행선지 확인 — 4영역이 화면을 정확히 덮음
- [x] 관문 19종 PASS
- [x] `STATUS.md` 갱신
- [x] **LINE 등록 완료** — `richmenu-a62983f0be68d5a95bf7f80ae225c8c8`（§9）

## 9. 등록 — 실행 기록 (2026-08-10)

대표가 그 자리에서 토큰을 넘겨, 이 기기에서 등록까지 마쳤습니다.
토큰은 **파일에 쓰지 않고** 그 명령의 환경변수로만 넘겼습니다
（`server/.env` 는 이 기기에 없는 채 그대로）.

```bash
LINE_CHANNEL_ACCESS_TOKEN=… node tools/setup-richmenu.mjs --list
  → 既定: （なし） / 登録されているリッチメニューはありません   ← 껐던 기록과 일치

LINE_CHANNEL_ACCESS_TOKEN=… node tools/setup-richmenu.mjs --image=server/assets/richmenu.jpg
  → ✓ 登録して既定にしました: richmenu-a62983f0be68d5a95bf7f80ae225c8c8

LINE_CHANNEL_ACCESS_TOKEN=… node tools/setup-richmenu.mjs --list
  → richmenu-a62983f0be68d5a95bf7f80ae225c8c8  kstudy101-main  2500×1686  領域 4 ★既定
```

**옛 정의는 0건이었으므로 지운 것도 0건.** 지금 LINE 쪽에 있는 리치메뉴는
이 1개뿐입니다（쌓이면 어느 것이 현재 것인지 알 수 없게 됩니다 —
`install()` 이 매번 옛것을 지우는 이유）.

> `--list` 는 출력 뒤 종료 시점에 Windows 의 libuv assertion（exit 127）을
> 냅니다. `process.exit()` 와 Node 의 tear-down 이 겹치는 잡음이고, **API
> 응답은 그 앞에 정상적으로 나옵니다.** `--image=` 쪽은 `process.exit` 를
> 거치지 않아 조용히 끝납니다.

`install()` 은 **새 것을 기본값으로 만든 뒤에** 옛 정의를 지웁니다 — 순서를
뒤집으면 지운 뒤 등록될 때까지 메뉴가 사라집니다（`richmenu.mjs` 주석）.
톡 화면을 열어 두고 있던 사람은 조금 늦게 바뀝니다.
