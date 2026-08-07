# plan-upload-content.md — 원고 전용 FTP 계정과 업로드 도구

> 지시서⑬(2026-08-06 대표 결정)의 계획서.
> **상태: 완료 (2026-08-07 승인 → 구현·관문·보고 완료, 대표 확인).** 커밋 `0f94fee`.
> 결정 3건은 권장안 그대로 채택 — D1(가) 이름으로 알려주기 / D2(가) 파싱 안 함 / D3 `verify-server` 에 추가.
>
> 이 계획의 산출물(도구·관문·문서)은 여기서 끝입니다. **남은 것은 코드가 아니라 실기** —
> 계정 생성과 §3 탈출 시험은 비밀번호를 가진 사람만 할 수 있어, STATUS 의 **A0** 로 이관했습니다.
> 저장소 쪽에서 더 할 일은 없습니다.

관련: [STATUS.md](../STATUS.md) A1·D1b / [plan-p4-content.md](plan-p4-content.md) / [plan-deploy-server.md](plan-deploy-server.md)

---

## 0. 조사 결과 (구현 전 확인된 사실)

지시서를 그대로 받아 적기 전에, 저장소 쪽 실물을 먼저 확인했습니다.

| # | 확인한 것 | 결과 |
|---|---|---|
| 0-1 | `tools/cpanel.sh` 의 자격정보 처리 | `~/.config/kstudy101/` 에서 읽고, 토큰은 **출력하지 않으며**, `CPANEL_TOKEN_FILE` 로 경로를 갈아끼울 수 있다 → 이번 도구도 같은 골격을 따른다 |
| 0-2 | `tools/deploy-server.sh` 의 「없는 것 안내」 | 빠진 항목을 **전부 모아 이름으로** 말하고 멈춘다(`missing=()`). 하나씩 멈추면 고치고 돌리기를 반복하게 되므로 |
| 0-3 | 의존 | 저장소 전체 의존은 `mysql2` 하나. 관문 19종이 `npm install` 없이 돈다 → **`curl` 만으로 짠다** |
| 0-4 | 원고의 실제 위치 | 로컬은 **`server/content/`** (`.gitignore` 로 제외). 서버는 `~/kstudy101-line/content/`. **지시서 §3 의 `content/…` 인자와 어긋난다** → §5 결정 D1 |
| 0-5 | 지금 로컬에 있는 원고 | `beginner-01.json` · `intermediate-01-10 … 91-101.json` 8개. **`beginner-51-60.json` 은 로컬에 없다** → §6 |
| 0-6 | 관문의 배선 | `deploy.yml` 은 19종을 **한 줄씩 나열**하고, `deploy-server.yml` 은 목록 루프. 관문 파일을 새로 만들면 고칠 곳이 4군데(워크플로 2 + `CLAUDE.md` + `STATUS.md`) → §4 결정 D3 |
| 0-7 | `verify-server.mjs` 의 기존 방식 | 이미 `build-site.sh` · `deploy-server.sh` · `.cpanel.yml` 을 **소스 문자열로 검사**한다(1052~1112행, `PROTECTED` 7종). 이번 검사도 같은 자리의 이웃이다 |
| 0-8 | 관문 현재 수 | 19종 전부 PASS. `verify-server` 는 **84항목**(전체 603) — 여기에 더한다 |
| 0-9 | 미커밋 변경 | `server/lib/content-check.mjs` · `tools/verify-render.mjs` 에 이전 세션의 변경이 남아 있다(차입구 금지를 NAME→전체로). **이번 작업은 이 두 파일을 건드리지 않습니다** |

### 0-10 왜 이 도구가 필요한가 (지금의 입고 경로)

지금 원고는 **cPanel File Manager 로 손수 올립니다.** `.cpanel.yml` 의 배치는
`content/` 를 **제외**하므로(원고를 지우지 않기 위해), 배치가 원고를 올려주지 않습니다.
그래서 「올리는 일」만 남아 있고, 그 한 가지를 위해 전권 토큰을 쓰지 않겠다는 것이
지시서 §0 의 요지입니다.

---

## 1. 접근 방식

### 1-1 만드는 것은 하나 — `tools/upload-content.sh`

```
bash tools/upload-content.sh server/content/beginner-51-60.json   보낸다
bash tools/upload-content.sh --dry-run server/content/…           보내지 않고 보여준다
bash tools/upload-content.sh --list                               저쪽에 뭐가 있나
```

의존은 `curl` 하나. npm 패키지를 넣지 않습니다(0-3).

### 1-2 비밀번호를 명령행에 올리지 않는 방법

`--user "id:pass"` 로 넘기면 같은 기계의 다른 프로세스가 `ps` 로 봅니다.
그래서 **curl 설정파일을 그때그때 만들어 `-K` 로 넘기고, 끝나면 지웁니다.**

```bash
# 資格は設定ファイル経由。--user で渡すと ps に出る（指示書⑬ §2-2-2）。
umask 077                       # 作られた瞬間から 600
CURLRC=$(mktemp)
trap 'rm -f "$CURLRC"' EXIT     # 途中で死んでも残さない

# curl の設定ファイルは " の中で \\ と \" を解する。生成された
# パスワードに " や \ が混じっても壊れないよう、先に逃がす。
esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
printf 'user = "%s:%s"\n' "$(esc "$FTP_USER")" "$(esc "$FTP_PASS")" > "$CURLRC"

# --ssl-reqd は設定ファイルに入れない。秘密ではないし、
# コマンドラインに見えている方が「平文で繋いでいない」ことを目で確かめられる。
CURL=(curl --ssl-reqd -K "$CURLRC" -sS -m 120)
```

`--ssl-reqd` 는 **TLS 를 못 걸면 실패**시킵니다(평문으로 조용히 내려앉지 않음).

### 1-3 흐름

```
자격정보 확인 ─→ 없으면 만드는 법을 적어서 중단 (§2-2-4)
      ↓
문(門) 3개 ─→ .json 이 아니면 거부 / 경로에 .. 이 있으면 거부 / 파일이 없으면 거부
      ↓
--dry-run 이면 여기서 「무엇이 어디로」만 찍고 종료
      ↓
curl -T 로 업로드 (FTPS)
      ↓
curl --head 로 원격 크기를 다시 읽어 로컬 바이트 수와 대조 (§2-2-6)
      ↓
「사람이 할 일」 두 줄을 안내로 찍고 끝 (§4)
```

### 1-4 보내는 곳

`FTP_DIR=/` 은 **이 계정에게 `content/` 가 곧 최상위**라서입니다(지시서 §1-2).
원격 파일명은 **로컬 경로의 basename 만** 씁니다 — 하위 디렉터리를 만들지 않습니다.

```bash
DIR=${FTP_DIR:-/};  case "$DIR" in */) ;; *) DIR="$DIR/";; esac
BASE="ftp://$FTP_HOST$DIR"
"${CURL[@]}" -T "$FILE" "$BASE$NAME"
```

### 1-5 삭제는 만들지 않습니다 (§2-3)

`DELE`·`rm`·`--quote` 를 한 글자도 쓰지 않습니다. 지우는 일은 File Manager 로 사람이 합니다.

---

## 2. 코드 스니펫 — 실제로 들어갈 것

### 2-1 자격정보가 없을 때 (§2-2-4)

```bash
CONF=${FTP_CONTENT_CONF:-~/.config/kstudy101/ftp-content.conf}
if [ ! -f "$CONF" ]; then
  cat >&2 <<EOF
✗ 原稿用 FTP の資格情報がありません: $CONF

  cPanel → FTP Accounts で 1 つ作ってください（指示書⑬ §1-1）:
    Log In      content            → content@kstudy101.jp になります
    Password    生成ボタンで作る（手で決めない）
    Directory   kstudy101-line/content   ★ 既定の public_html/content ではありません
    Quota       50 MB

  出てきた値を、チャットに貼らずファイルへ:
    mkdir -p ~/.config/kstudy101
    cat > $CONF        （下を貼って Ctrl-D）
      FTP_HOST=ftp.kstudy101.jp
      FTP_USER=content@kstudy101.jp
      FTP_PASS=<生成したパスワード>
      FTP_DIR=/
    chmod 600 $CONF
EOF
  exit 1
fi
. "$CONF"
```

읽은 뒤 빠진 항목은 `deploy-server.sh` 와 같이 **모아서 한 번에** 말합니다(0-2).

### 2-2 문(門) 3개 (§2-2-7·8)

```bash
case "$ARG" in
  *..*) echo "✗ 経路に .. は使えません: $ARG" >&2; exit 1 ;;
esac
case "$ARG" in
  *.json) ;;
  *) echo "✗ .json 以外は上げません: $ARG" >&2; exit 1 ;;
esac
if [ ! -f "$ARG" ]; then
  echo "✗ そのファイルがありません: $ARG" >&2
  # 「content/… で呼ばれたが実体は server/content/…」を名指しで助ける（0-4）
  alt="$ROOT/server/content/$(basename "$ARG")"
  [ -f "$alt" ] && echo "  こちらのことですか: server/content/$(basename "$ARG")" >&2
  exit 1
fi
```

### 2-3 올린 뒤 원격 크기를 다시 읽어 대조 (§2-2-6)

```bash
LOCAL=$(wc -c < "$ARG" | tr -d ' ')
"${CURL[@]}" -T "$ARG" "$BASE$NAME"

# FTP の -I は SIZE/MDTM を投げ、Content-Length として返す。
REMOTE=$("${CURL[@]}" --head "$BASE$NAME" | tr -d '\r' | sed -n 's/^Content-Length: //p')
if [ "$REMOTE" != "$LOCAL" ]; then
  echo "✗ 大きさが合いません（手元 $LOCAL / 向こう $REMOTE バイト）" >&2
  echo "  切れたまま上がっています。もう一度同じ命令を流してください。" >&2
  exit 1
fi
echo "✓ $NAME ($LOCAL バイト) — 向こうで読み直して一致"
```

### 2-4 `--dry-run` 출력 (§2-2-5)

```
── これから上げるもの（--dry-run。まだ上げていません）──
  手元       server/content/beginner-51-60.json
  大きさ     8,412 バイト
  送り先     ftp://ftp.kstudy101.jp/beginner-51-60.json   （FTPS・明示的 TLS）
  利用者     content@kstudy101.jp
  ※ この口は content/ より上へ行けません（Directory 制限）。
```

**비밀번호는 어떤 출력에도 나오지 않습니다**(§2-2-3). 실패해도 사용자명까지입니다.

---

## 3. 관문 — 「이 뒷일은 사람이 지키는 약속인데, 약속을 싫어한다」

`tools/verify-server.mjs` 끝(배치 검사 §1070 이웃)에 절을 하나 더 답니다.
전부 **소스 문자열 검사**라 FTP 접속도 자격정보도 필요 없습니다.

```js
head("[原稿の送り口]  上げるだけの口が、上げるだけであり続ける");

const up = () => read("tools/upload-content.sh");

check("--trace / -v の類いが無い（漏れたらパスワードを渡したのと同じ）", () => {
  const src = up();
  for (const bad of ["--trace", "--trace-ascii", "--trace-time", "--verbose"]) {
    assert(!src.includes(bad), `${bad} があります`);
  }
  assert(!/(^|\s)-v(\s|$)/m.test(src), "-v があります");
  return "4 種 + -v";
});

check("パスワードがコマンドラインの引数に出ない", () => {
  const src = up();
  assert(!/--user\b/.test(src), "--user で渡しています（ps に出ます）");
  assert(!/-u\s+["$]/.test(src),  "-u で渡しています（ps に出ます）");
  // 資格を書き出す先は curl の設定ファイルだけ
  assert(/-K\s+"\$CURLRC"/.test(src), "-K で設定ファイルを渡していません");
  assert(/\btrap\b[^\n]*rm -f "\$CURLRC"/.test(src), "設定ファイルを消す trap がありません");
  assert(/\bumask 077\b/.test(src), "umask 077 がありません（設定ファイルが読まれます）");
  return "-K + trap + umask";
});

check("平文 FTP で繋がない（--ssl-reqd が全部の curl に付く）", () => {
  const src = stripComments(up());
  const calls = src.match(/curl[^\n]*/g) || [];
  assert(calls.length > 0, "curl の呼び出しが見つかりません");
  for (const c of calls) assert(c.includes("--ssl-reqd"), `--ssl-reqd の無い curl: ${c.trim()}`);
  return `curl ${calls.length} 箇所`;
});

check("消す道具が無い（DELE / rm / --quote）", () => {
  const src = stripComments(up());
  assert(!/\bDELE\b/.test(src), "DELE があります");
  assert(!/(--quote|-Q)\b/.test(src), "--quote があります（任意の FTP 命令が撃てます）");
  assert(!/\bcurl\b[^\n]*\brm\b/.test(src), "curl 経由の rm があります");
  return "上げるだけ";
});

check(".json 以外と .. を門で止める", () => {
  const src = stripComments(up());
  assert(/\*\.json\)/.test(src), ".json の判定がありません");
  assert(/\*\.\.\*\)/.test(src), ".. の判定がありません");
  return "拡張子と経路";
});

check("資格情報はリポジトリの外に置く", () => {
  const src = up();
  assert(/~\/\.config\/kstudy101\/ftp-content\.conf/.test(src), "既定の置き場が違います");
  assert(!/FTP_PASS=[^$\n]/.test(src), "パスワードが直書きされています");
  return "~/.config/kstudy101/";
});

check("上げたあと向こうの大きさを読み直す", () => {
  const src = stripComments(up());
  assert(/--head/.test(src), "--head による読み直しがありません");
  assert(/Content-Length/.test(src), "大きさの取り出しがありません");
  return "切れたまま上がったのを捕まえる";
});
```

**구현 결과: 9항목 증가 → `verify-server` 84 → 93.**
(계획 시점엔 7항목으로 잡았으나, 「존재·형식」과 「비밀번호가 설정파일 밖으로 안 나감」을
따로 세는 편이 실패했을 때 어디가 무너졌는지 바로 보이므로 9개로 쪼갬.)

실측 전체 수는 **651 → 660** 입니다. 지시서 §6 의 「603」은 그보다 이전 시점의 수로 보입니다
(관문별 실측: saju 20 / fortune 20 / study 20 / name 25 / omikuji 15 / gilbang 15 / amulet 28 /
birth 17 / pages 15 / **server 93** / webhook 52 / onboarding 85 / render 49 / push 56 /
fortune-server 19 / evening 32 / billing 67 / quiz 18 / kana 14).

### 3-1 관문이 실제로 떨어지는지 확인 (변이 시험)

「떨어질 수 없는 관문」은 관문이 아니므로, 台本을 8가지로 망가뜨려 전부 잡히는 것을 확인했습니다.
(임시 변형 → 검사 → 원복. 마지막에 무변경 PASS 재확인.)

| 망가뜨린 것 | 잡힘 |
|---|---|
| `--trace out.txt` 추가 | ✓ |
| `--ssl-reqd` 제거 | ✓ |
| `echo` 에 `$FTP_PASS` 섞기 | ✓ |
| `-K` 를 `--user "$FTP_USER:$FTP_PASS"` 로 교체 | ✓ |
| `trap` 삭제 | ✓ |
| `--quote "DELE …"` 추가 | ✓ |
| `.json` 판정 삭제 | ✓ |
| 크기 대조(`--head`) 제거 | ✓ |

---

## 4. 수정 대상 파일

| 파일 | 무엇을 |
|---|---|
| `tools/upload-content.sh` | **신규** (약 130행, bash) |
| `tools/verify-server.mjs` | 끝에 `[原稿の送り口]` 절 7항목 추가 |
| `STATUS.md` | §5 에 「원고를 올리는 길」 한 절 + 이력 1행 |
| `docs/plan-upload-content.md` | 이 문서(구현 후 완료 표시) |

**건드리지 않는 것:** `.cpanel.yml` · `deploy-server.sh` · `deploy.yml` ·
`server/**` 전부 · 미커밋 상태인 `content-check.mjs` / `verify-render.mjs`(0-9).

### 결정 D3 — 관문을 새 파일로 뽑지 않는 이유

`tools/verify-upload.mjs` 를 새로 만들면 **20종**이 되고 `deploy.yml`(한 줄씩 나열)·
`deploy-server.yml`(목록)·`CLAUDE.md`·`STATUS.md` 4곳을 같이 고쳐야 합니다.
검사 내용이 `verify-server` 가 이미 하고 있는 「배치 경로의 소스 문자열 검사」와
같은 종류이므로(0-7), **기존 파일에 절을 더하는 쪽**을 권합니다.
새 파일을 원하시면 그렇게 하겠습니다 — 4곳 동시 수정이 늘 뿐, 위험은 아닙니다.

---

## 5. 대표님 결정이 필요한 것 3건

### D1 — 로컬 경로 규약 (0-4)

지시서 §3 은 `bash tools/upload-content.sh content/beginner-51-60.json` 인데,
**로컬 원고는 `server/content/` 에 있습니다.** 저장소 루트에 `content/` 는 없습니다.

| 안 | 내용 | 평가 |
|---|---|---|
| **(가) 권장** | 인자를 있는 그대로 받는다. 못 찾으면 `server/content/<같은 이름>` 이 있는지 보고 **이름으로 알려준다**(2-2). 지시서의 명령은 `server/content/…` 로 읽는다 | 조용히 다른 파일을 집는 일이 없다 |
| (나) | `content/x.json` 을 `server/content/x.json` 으로 **자동 치환** | 지시서 문면 그대로 돌아가지만, 「지정한 것과 다른 파일이 올라갈 수 있는」 경로가 생긴다 |

### D2 — 업로드 전에 로컬에서 JSON 을 한 번 파싱할까요

§2-2-6 의 크기 대조는 **전송 중 잘림**을 잡습니다. 손에서 이미 깨져 있는 파일은 못 잡습니다.

| 안 | 내용 |
|---|---|
| **(가) 권장** | 넣지 않는다. 지시서 §4 가 그 일을 사람(`seed --check`)에게 배정했고, 도구가 반쯤 검사하면 「도구가 봐줬다」는 착각이 생긴다 |
| (나) | `node -e` 로 `JSON.parse` 만 1회. 의존은 늘지 않지만(node 는 이미 필수) 검사 책임이 두 곳으로 갈라진다 |

### D3 — 관문 위치 (§4 참조). 권장: `verify-server.mjs` 에 추가

---

## 6. 트레이드오프·위험

| # | 사안 | 판단 |
|---|---|---|
| 6-1 | **FTPS 인증서 이름** — 공유호스팅의 FTP 는 `ftp.kstudy101.jp` 가 아니라 서버 실호스트명(`rs6-kor…`)의 증서를 내밀 수 있습니다. 그러면 검증에서 끊깁니다 | **`-k`(검증 끄기)를 넣지 않습니다.** 끊기면 「`FTP_HOST` 를 cPanel 이 안내하는 호스트명으로 바꾸십시오」라고 안내하고 멈춥니다. 검증을 끄면 §2-2-1 이 지키려던 것이 사라집니다 |
| 6-2 | `wc -c` 는 로컬 바이트 수 | CRLF 로 체크아웃돼도 올린 바이트 그대로 대조되므로 문제 없습니다(FTP 는 바이너리 전송) |
| 6-3 | 실패 시 저쪽에 **잘린 파일이 남습니다** | 삭제 기능이 없으므로(§2-3) 같은 명령을 다시 흘려 덮어씁니다. 안내문에 그렇게 씁니다. 지우고 싶으면 File Manager |
| 6-4 | `mktemp` 를 쓰므로 `$TMPDIR` 가 딴 사람이 읽을 수 있는 곳이면? | `umask 077` + `mktemp` 로 600, `trap` 으로 즉시 삭제. 그래도 「손이 죽는」 순간이 있으면 파일 1개가 남을 수 있어, 남는 것은 **평문 비밀번호**입니다 — 이것이 이 설계에서 가장 얇은 곳입니다 |
| 6-5 | 이 도구는 **DB 에 넣지 않습니다** | 올린 뒤 `seed-content` 는 사람이 cPanel Terminal 에서 돕니다(지시서 §7). 다음 배치에서 `.cpanel.yml` 이 자동으로 흘리기도 합니다 |
| 6-6 | 저녁 배치 전에 끝낼 것 | STATUS §8-9 — JST 18시 뒤에 그날 원고를 갈아끼우면 문제와 답이 어긋납니다. 안내문 마지막 줄에 넣습니다 |

---

## 7. 구현 순서 (승인 후)

- [x] 1. `tools/upload-content.sh` 작성 → `bash -n` 통과 · 자격정보 없으면 §2-1 안내로 중단(종료코드 1)
- [x] 2. `verify-server.mjs` 에 절 추가 → `node tools/verify-server.mjs` **93항목 전부 성공**
- [x] 3. 관문 19종 재실행 → 전부 PASS (651 → 660)
- [x] 4. 변이 시험 8종 → 전부 잡힘 (§3-1)
- [x] 5. 더미 자격정보(`FTP_CONTENT_CONF` 로 저장소 밖 지정)로 `--dry-run`·안내문 채취 →
      비밀번호 등장 0회 / 임시 자격파일 잔여 0개(`trap` 동작 확인)
- [x] 6. 커밋(`0f94fee`) → §8 보고 → **대표 확인·완료 처리 (2026-08-07)**
- [ ] 7. **대표님 실기** (저장소 밖) — 계정 생성 → §3 탈출 시험 → 실업로드 → §4 두 줄.
      STATUS **A0**. 이 항목은 이 계획의 미완이 아니라, 다음 사람이 밟을 순서입니다

## 8. 보고할 것 (지시서 §6)

1·2·4·6·7 은 제가 냅니다. **3(탈출 시험)·5(업로드 후 두 줄)는 계정이 생긴 뒤 대표님 손에서만 나옵니다** —
비밀번호를 제게 보내지 않기로 한 §1-3 의 필연적인 결과입니다.
「3번이 이 일의 합격 기준」이므로, 이 계획은 §7-6 이 끝나야 완료입니다.

---

## 9. 별건 — 첨부하신 `beginner-51-60.json`

같이 주신 원고 본문이 **제 쪽에서는 mojibake(`ì´ê¸ 51~60ì¼ì°¨`) 로 도착했습니다.**
UTF-8 을 latin-1 로 읽은 전형적인 형태라 되돌릴 수는 있지만, **되돌린 것을 원고로 쓰지 않겠습니다** —
지시서 §4 가 잡으라고 한 사고를 제가 만드는 셈이 됩니다.

- 로컬 `server/content/` 에 `beginner-51-60.json` 은 **없습니다**(0-5). 대표님 손의 원본을 그대로 쓰십시오.
- 이 원고를 저장소에 두는 것도 안 됩니다 — `.gitignore` 가 `server/content/` 를 막고 있고, 유료물입니다.
- 필요하시면 대표님이 파일을 `server/content/` 에 놓으신 뒤 알려주십시오. `--dry-run` 을 실물로 한 번 찍겠습니다.
