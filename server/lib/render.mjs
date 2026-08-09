/* ==================================================================
   lib/render.mjs — 原稿 + 利用者 → 実際に送るメッセージ

   content_templates の 1 行は原稿であって、そのままでは送れない。
   {NAME} のような差し込み口が入っているのと、1 日ぶんを LINE の
   何通に分けるかが決まっていないため。ここがその両方を決める。

   【なぜ差し込み口を増やしたか】
   韓国語の助詞は直前の文字にパッチム（終声）があるかで形が変わる。
      켄  (パッチムあり) → 켄이에요 / 켄은 / 켄이 / 켄아
      아이(パッチムなし) → 아이예요 / 아이는 / 아이가 / 아이야
   {NAME}입니다 はどちらでも成り立つが、{NAME}는 は成り立たない。
   原稿を書く人に「パッチムのある名前でも大丈夫な文だけ書いてくれ」と
   頼むのは無理があるので、助詞ごとに差し込み口を用意して、
   選ぶのはこちらの仕事にする。

   規則はサイト本体（index.html の hasJong / ieyo / ega / fillName）と
   同じものを移した。別々に書くと、同じ名前がウェブと LINE で違う
   助詞になる。実際サイトでは一度「켄 씨은」を出しており、これは
   学習コンテンツとしては誤りを教えることになる。

   【助詞は直前の文字に従う】
   差し込み口は名前の直後にだけ置く。「{NAME} 씨{EUN}」のように
   間に語が入ると、助詞が従うのは 씨 であって名前ではない。
   原稿規則として禁じ、renderer 側でも検出する。
   ================================================================== */

/* ---- ハングルのパッチム判定 ---------------------------------------
   末尾の 1 文字だけ見る。合成済みハングル（AC00〜D7A3）は
   (초성×21 + 중성)×28 + 종성 で並んでいるので、28 の剰余が 0 で
   なければ終声がある。分解表を持つ必要はない。 */
const HANGUL_FIRST = 0xac00;
const HANGUL_LAST  = 0xd7a3;

/* 判定できないときは null を返す（空・ハングル以外）。false は
   「終声が無い」という判定であって、「分からない」ではない。
   混ぜると、名前が空のときに母音終わりの助詞が付いてしまう。 */
export function hasJong(word) {
  if (word === null || word === undefined) return null;
  const s = String(word).trim();
  if (!s) return null;
  const code = s.codePointAt(s.length - 1);
  if (code < HANGUL_FIRST || code > HANGUL_LAST) return null;  /* ハングル以外 */
  return (code - HANGUL_FIRST) % 28 !== 0;
}

/* ---- 差し込み口 ----------------------------------------------------
   はじめは名前だけだったが、この講座は「四柱で韓国語を学ぶ」ものなので、
   五行と干支も本文に出す。どれも助詞が付くと받침で形が変わるので、
   名前と同じ仕組みをそのまま広げる。

     {NAME}    다나카      {NAME_JP}    たなか
     {OHAENG}  목          {OHAENG_JP}  木
     {ZODIAC}  돼지        {ZODIAC_JP}  いのしし

   助詞付きは {OHAENG_EUN} → 목은 / {ZODIAC_EUN} → 돼지는 のように、
   値ごと置き換わる（名前と同じ規則）。

   日本語版はサーバーで対応表を持つ。サイトは韓国語しか送ってこないので
   ── 送らせるようにすると、同じ表がウェブとサーバーの 2 か所になる。 */
const PARTICLES = Object.freeze({
  IEYO: ["이에요", "예요"],   /* 〜です（打ち解けた丁寧） */
  EUN:  ["은", "는"],         /* 〜は */
  GA:   ["이", "가"],         /* 〜が */
  EUL:  ["을", "를"],         /* 〜を */
  WA:   ["과", "와"],         /* 〜と */
  VOC:  ["아", "야"]          /* 呼びかけ */
});

/* 差し込める値。kr は韓国語の行に、jp は日本語の行に出す。 */
const BASES = Object.freeze(["NAME", "OHAENG", "ZODIAC"]);

const OHAENG_JP = Object.freeze({
  "목": "木", "화": "火", "토": "土", "금": "金", "수": "水"
});

/* 干支。サイトは韓国語（쥐・소…）で送ってくる。 */
const ZODIAC_JP = Object.freeze({
  "쥐": "ねずみ", "소": "うし", "호랑이": "とら", "토끼": "うさぎ",
  "용": "たつ", "뱀": "へび", "말": "うま", "양": "ひつじ",
  "원숭이": "さる", "닭": "とり", "개": "いぬ", "돼지": "いのしし"
});

export const SLOTS = Object.freeze(
  BASES.flatMap((b) => [b, `${b}_JP`, ...Object.keys(PARTICLES).map((p) => `${b}_${p}`)]));

/* 助詞スロットは値を含めて置き換わる（{OHAENG_EUN} → 목은）。
   なので {OHAENG} と続けて書くと値が二重になる。

     {NAME}{NAME_EUN}       → 아이아이는     二重
     {NAME} 씨{NAME_EUN}    → 아이 씨아이는  二重、しかも助詞は 씨 に従うべき
     {NAME_EUN}             → 아이는         これが正しい

   「씨」を付けたい日は助詞スロットを使わず「{NAME} 씨는」と literal で書く。
   씨 は母音終わりなので、値に関係なく 는 で固定できる。 */
const MISPLACED = new RegExp(
  `\\{(${BASES.join("|")})\\}[^{]*?\\{(?:${BASES.join("|")})_(?:${Object.keys(PARTICLES).join("|")})\\}`
);

export function findMisplacedSlot(text) {
  const m = MISPLACED.exec(String(text ?? ""));
  return m ? m[0] : null;
}

/* 利用者の 1 行から、差し込む値を取り出す。
   四柱は名前と同時にしか入らない（handlers/link.mjs が同じ往復で
   両方書き、follow だけの人はどちらも空）。だから「名前が無い日」の
   扱いがそのまま四柱にも効く ── 別の分岐を増やさない。 */
function valuesOf(user = {}) {
  const raw = user.raw_result_json && typeof user.raw_result_json === "object"
    ? user.raw_result_json : {};
  const ohaeng = user.ohaeng_main || raw.ohaeng || null;
  const zodiac = raw.zodiac || null;
  return {
    NAME:   { kr: user.name_kr || null,  jp: user.name_reading || user.name_kr || null },
    OHAENG: { kr: ohaeng, jp: ohaeng ? (OHAENG_JP[ohaeng] || ohaeng) : null },
    ZODIAC: { kr: zodiac, jp: zodiac ? (ZODIAC_JP[zodiac] || zodiac) : null }
  };
}

/* ---- 差し込み ------------------------------------------------------
   要る値が無いときは null を返す。呼ぶ側が代替文へ切り替える。
   ここで勝手に既定を入れると、全員が同じ名前・同じ五行になる。 */
export function fillSlots(text, user = {}) {
  const t = String(text ?? "");
  if (!t) return "";

  const v = valuesOf(user);
  let out = t;

  for (const base of BASES) {
    const { kr, jp } = v[base];
    const used = new RegExp(`\\{${base}(_[A-Z]+)?\\}`).test(out);
    if (!used) continue;
    if (!kr) return null;                       /* 要るのに無い */

    const j = hasJong(kr);
    const jong = j === null ? false : j;        /* ハングルでなければ母音終わり扱い */

    for (const [p, [withJong, without]] of Object.entries(PARTICLES)) {
      out = out.split(`{${base}_${p}}`).join(kr + (jong ? withJong : without));
    }
    out = out.split(`{${base}_JP}`).join(jp || kr);
    out = out.split(`{${base}}`).join(kr);
  }
  return out;
}

/* ---- 신양식（지시서㉑）의 부품 --------------------------------------
   섹션 헤더（📘🔗💡💬📚❓🍀）는 전부 이 파일이 소유한다. 원고 JSON 에
   넣으면 입고 검사（content-check §2-5）가 거부한다 ── 303일 × 헤더
   복제를 원천 차단하기 위해서다.

   신양식 판정은 §2 와 한 문장: vocab_3 항목에 pos 가 하나라도 있으면
   신양식. 판정을 두 군데에 두면 렌더러와 입고 검사가 다른 답을 낸다. */
export function isNewFormat(template) {
  const v = Array.isArray(template?.vocab_3) ? template.vocab_3 : [];
  return v.some((w) => w && w.pos);
}

/* pos 의 값이자 표시 순서. 원고는 이 세 값만 쓸 수 있고（content-check）,
   화면의 【名詞】 같은 묶음 헤더도 여기서 나온다 ── 표기는 한 곳에만. */
export const POS = Object.freeze(["名詞", "形容詞", "動詞"]);

/* tip 은 「形　…／使　…／落　…」의 3행 정형（새 필드를 만들지 않는다
   ── grammar_tip_kr 하나에 들어 있고 여기서 접두어로 나눈다）.
   행머리가 形/使/落 이면 그 버킷을 열고, 무표지 행은 직전 버킷에
   이어 붙인다. 3버킷이 다 차지 않으면 null ── 구양식으로 간주하고
   호출측이 통째로 표시한다（§1-2: 렌더러는 거부하지 않는다）. */
export function parseTip(tip) {
  const s = String(tip ?? "");
  if (!s) return null;
  const buckets = { "形": [], "使": [], "落": [] };
  let cur = null;
  for (const line of s.split("\n")) {
    const m = /^([形使落])[　\s]*(.*)$/.exec(line);
    if (m) { cur = m[1]; buckets[cur].push(m[2]); }
    else if (cur !== null) buckets[cur].push(line);
    else return null;                          /* 첫 행부터 무표지 ── 정형이 아니다 */
  }
  if (!buckets["形"].length || !buckets["使"].length || !buckets["落"].length) return null;
  return { form: buckets["形"], use: buckets["使"], fall: buckets["落"] };
}

/* grammar_point 의 말미 전각（…）를 일본어부로 나눈다.
   「-다고 하다（〜だと言う）」→ 한국어부 + [일본어부] 의 2행.
   괄호가 없으면 일본어부 없이 1행 ── 구양식·신양식 공통. */
function splitGrammarPoint(point) {
  const s = String(point ?? "").trim();
  const m = /^(.+?)（([^（）]+)）$/.exec(s);
  return m ? { kr: m[1].trim(), ja: m[2].trim() } : { kr: s, ja: null };
}

/* quiz 열의 형. 깨져 있으면 null ── 보내지 않을 뿐, 본편은 간다.
   원래 repo/learning.mjs 에 있던 것을 이리로 옮겼다（learning 이
   재수출한다）── 렌더러가 꼬리통을 만들 때 같은 판정이 필요한데,
   render → repo 방향의 import 는 층을 거꾸로 탄다. */
export function usableQuiz(q) {
  if (!q || typeof q.question !== "string" || !q.question
      || !Array.isArray(q.choices) || q.choices.length < 2
      || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
    return null;
  }
  return q;
}

/* ---- 1 日ぶんを組み立てる（지시서㉑ 신양식）--------------------------
   레슨은 2통 + 신양식이면 꼬리통 1개.

     1 통目   📘 Day N : 문법 / [일본어부] / 🔗 接続 / 💡 学習ポイント / 💬 회화
     2 通目   📚 今日の単語（신양식: 품사 2·2·2 묶음 / 구양식: 평면 목록）
     꼬리통   ❓ 今日のクイズ + ①②③ + quickReply（신양식만）

   🍀 今日のひとこと（fortune_bridge.ja）는 레슨의 **마지막 통** 말미에
   붙는다 ── 꼬리통이 있으면 거기, 없으면（구양식） 2통째. 표시는 ja 만
   （§1-3 ── kr 은 집필·검수용으로 원고에 남는다）.

   ★ 꼬리통의 quickReply 는 아침 묶음의 마지막 1통에서만 열린다（LINE
   사양·절목 퀴즈가 말미로 가는 이유와 같다）. 그래서 push-daily 가
   꼬리통을 뽑아 운세·부적 뒤（묶음 맨 끝）에 다시 붙인다. 판별은
   「quickReply 를 가진 마지막 요소」── 1·2통째에는 quickReply 가 없다.

   ★ 구양식 원고（tip 무정형·vocab 3어 pos 없음·quiz/bridge 부재）도
   여기서 throw 하지 않는다（§1-2）. 신양식 검사는 입고 관문의 일이고,
   렌더러는 있는 것을 무너지지 않게 보여준다. 구양식의 quiz 는 데일리
   꼬리통을 만들지 않는다 ── 배포① 시점의 화면 변화를 「헤더 + bridge
   위치」로 한정하기 위해（복습·절목 퀴즈의 현행 거동 유지）.

   quizSection: false 는 절목（30/50/75）의 아침 ── 그날은 절목 퀴즈
   （기록 있음·action=quiz）가 말미에 오므로, 무보존의 데일리 ❓를
   접는다. 같은 아침에 퀴즈 2건을 두지 않는 기존 원칙.

   返すのは LINE の messages 配列そのもの。送信は呼ぶ側の仕事で、
   ここは文字列を作るだけにしておく ── そうしておくと、送らずに
   中身だけ確かめられる。 */
export function renderDay(template, user = {}, { quizSection = true } = {}) {
  if (!template) throw new Error("template がありません");

  const day  = Number(template.day_number);
  const texts = [];

  /* --- 1 通目 --- */
  const gp = splitGrammarPoint(template.grammar_point);
  const head = [`📘 Day ${day} : ${gp.kr}`];
  if (gp.ja) head.push(`[${gp.ja}]`);

  const tip = parseTip(template.grammar_tip_kr);
  if (tip) {
    head.push("", "🔗 接続 (活用ルール)", ...tip.form);
    /* 形도 学習ポイントに出す（2026-08-09 Day2 검수）── 接続と重複してよい. */
    head.push("", "💡 学習ポイント",
      `・形: ${tip.form[0]}`, ...tip.form.slice(1),
      `・使: ${tip.use[0]}`, ...tip.use.slice(1),
      `・落: ${tip.fall[0]}`, ...tip.fall.slice(1));
  } else if (template.grammar_tip_kr) {
    /* 구양식: 분해하지 않고 💡 아래 통째로（§1-2）. */
    head.push("", "💡 学習ポイント", template.grammar_tip_kr);
  }

  /* 会話は 1 往復ごとに空行で離す。詰めて並べると、韓国語と訳が
     交互に続いて、どこまでが一人の台詞か読めなくなる。
     일본어 역은 「  （…）」── 들여쓰기 + 전각 괄호（§1-1 스케치）.

     who は任意。付いていれば「A：」のように頭に置く。
     無いと、問いかけと答えが同じ人の独り言に見える ── 実際
     組み上げて読むまで気づかなかった。列は JSON なので、
     使う日だけ付ければよく、原稿側の負担にはならない。 */
  const dialogue = Array.isArray(template.dialogue_template) ? template.dialogue_template : [];
  const body = [];
  for (const row of dialogue) {
    const kr = fillSlots(row.kr, user);
    if (kr === null) return null;              /* 名前が要るのに無い */
    const ja  = row.ja ? fillSlots(row.ja, user) : "";

    /* 話者の札。名前が無い人には「あなた」を置く。
       ここに既定を置くのは、名前に既定を置くのとは別のこと ──
       札は役どころで、本文の「저는 ○○입니다」とは違う。
       置かないと {NAME_JP} という 9 文字がそのまま画面に出る。 */
    const label = row.who
      ? (fillSlots(row.who, user) ?? String(row.who).replace(/\{[A-Z_]+\}/g, "あなた"))
      : "";
    const who = label ? `${label}：` : "";
    body.push(ja ? `${who}${kr}\n  （${ja}）` : `${who}${kr}`);
  }
  if (body.length) head.push("", "💬 実際に使ってみよう", body.join("\n\n"));
  texts.push(head.join("\n"));

  /* --- 2 通目 --- */
  const vocab = Array.isArray(template.vocab_3) ? template.vocab_3 : [];
  if (vocab.length) {
    const v = ["📚 今日の単語"];
    /* 전 항목에 아는 pos 가 있어야 묶는다. 섞여 있으면（입고 검사가
       막지만, 만에 하나 들어와도） 단어를 잃지 않게 평면으로 낸다. */
    if (vocab.every((w) => w && POS.includes(w.pos))) {
      let n = 0;
      for (const pos of POS) {
        const ws = vocab.filter((w) => w.pos === pos);
        if (!ws.length) continue;
        /* 품사 헤더 다음, 단어 1개 = 1행（2026-08-09 Day2 검수 · 가독성）. */
        v.push(`【${pos}】`);
        for (const w of ws) {
          n++;
          const note = w.note ? `（${w.note}）` : "";
          v.push(`${n}. ${w.kr}　${w.meaning}${note}`);
        }
      }
    } else {
      for (const w of vocab) {
        const note = w.note ? `　（${w.note}）` : "";
        v.push(`・${w.kr}　${w.meaning}${note}`);
      }
    }
    texts.push(v.join("\n"));
  }

  const msgs = texts.map((text) => ({ type: "text", text }));

  /* --- 꼬리통（신양식 데일리 퀴즈）---
     postback 은 기존 review 방（무보존·즉시 채점）을 그대로 쓴다
     ── data 에 answer 를 싣지 않는 규칙도 quizMessage 가 그대로 진다. */
  if (quizSection && isNewFormat(template)) {
    const q = usableQuiz(template.quiz);
    if (q) msgs.push(quizMessage("❓ 今日のクイズ", "review", day, q));
  }

  /* --- 🍀 今日のひとこと ── 레슨 마지막 통의 말미 --- */
  const bridge = template.fortune_bridge;
  if (bridge && bridge.ja && msgs.length) {
    msgs[msgs.length - 1].text += `\n\n🍀 今日のひとこと\n${bridge.ja}`;
  }

  return msgs;
}

/* ---- 夕方のふりかえり（지시서⑨で「押して開く」形へ）-----------------
   朝と同じものを送り直さない。同じ 2 通がもう一度届くだけなら、
   通知が 1 回増えただけで読まれない。

   問いにして送る。朝に読んだ会話文を韓国語だけで出し、単語は
   ハングルだけを並べる ── 思い出そうとした分だけ残るので、
   読み流しとは別のことが起きる。

     夕方の便   問い（Flex 1 通、「こたえを見る」ボタン）
     押したら   答え（テキスト 1 通、postback の answer）

   はじめは 2 通同時だった ── 「2 通に分ければ思い出す間ができる」
   つもりが、LINE は配列を**同時に**表示するので、答えが問いのすぐ
   下に並んで間は生まれていなかった（지시서⑨ §0）。

   進みには触らない。復習は「保有日数を削らないボーナス」という
   取り決め（計画書 1-2）で、current_day を動かすのは朝だけ。
   だからこの関数は DB を知らない ── 文字列を作るだけにしておくと、
   触りようが無い。 */
/* ---- 共通部（지시서⑨ §2-4）------------------------------------------
   会話 1 文の**選び方**とスロット置換は、問いと答えでここ 1 か所を
   共有する ── 別々に選ぶと、直した日に問いと答えが別の文になり、
   利用者にはただの故障に見える。選び方は決定的（同じ原稿なら
   いつ呼んでも同じ文）── この性質を崩さないこと。

   会話は 1 文だけ拾う。全部出すと朝の再送になる。
   名前の入る文を優先するのは、この講座で覚えてほしいのが
   「自分の名前で言える形」だから ── 無ければ先頭で足りる。 */
function reviewParts(template, user) {
  if (!template) throw new Error("template がありません");
  const day = Number(template.day_number);
  const dialogue = Array.isArray(template.dialogue_template) ? template.dialogue_template : [];
  const pick = dialogue.find((r) => /\{NAME(_[A-Z]+)?\}/.test(String(r.kr ?? ""))) || dialogue[0] || null;

  const krLine = pick ? fillSlots(pick.kr, user) : null;
  if (pick && krLine === null) return null;        /* 名前が要るのに無い */
  const jaLine = pick && pick.ja ? fillSlots(pick.ja, user) : "";
  const vocab = Array.isArray(template.vocab_3) ? template.vocab_3 : [];
  return { day, krLine, jaLine, vocab };
}

/* 問いの本文（文字列）。Flex でもテキスト 2 通のフォールバックでも
   同じ行を使う ── スロット置換は文字列の段階で終える（§4-4。
   ロジックを JSON ツリーの中へ持ち込まない）。 */
function questionLines(template, p) {
  const q = [`🌙 ${p.day}日目のふりかえり`];
  if (template.grammar_point) q.push("", `【今日の文法】${template.grammar_point}`);
  if (p.krLine) {
    q.push("", "今朝の会話から1文。意味を思い出せますか？", `　${p.krLine}`);
  }
  if (p.vocab.length) {
    q.push("", "🔖 今日の単語", ...p.vocab.map((w) => `　${w.kr}`));
  }
  return q;
}

function answerLines(template, p) {
  const a = ["✅ こたえ"];
  if (template.grammar_point) a.push("", `【文法】${template.grammar_point}`);
  if (template.grammar_tip_kr) a.push(template.grammar_tip_kr);
  if (p.krLine) {
    a.push("", `　${p.krLine}`);
    if (p.jaLine) a.push(`　${p.jaLine}`);
  }
  if (p.vocab.length) {
    a.push("", ...p.vocab.map((w) => {
      const note = w.note ? `　（${w.note}）` : "";
      return `　${w.kr}　${w.meaning}${note}`;
    }));
  }
  /* 「明日の朝 7 時」は지시서⑧の --not-after=9 が真に保つ（§2-6）。 */
  a.push("", "明日の朝7時に、次の日をおとどけします。");
  return a;
}

/* ---- 問い：Flex 1 通（지시서⑨）--------------------------------------
   答えは同封しない ── 携帯の画面では 2 通が同時に並び、思い出す間が
   作られていなかった。ボタン「こたえを見る」を押して初めて答えが来る。

   quickReply にしないのは、体験 2 日目の勧誘が後ろに付く夕方が
   実在するため（push-evening の bundle）── quickReply は次の
   メッセージで消えるが、Flex のボタンは吹き出しに残り、あとから
   でも押せる。この repo で Flex を使う最初の場所（承認 2026-08-06）。

   LINE 公式リファレンス（developers.line.biz/en/reference/messaging-api/
   の原文 index.html.md、2026-08-06 確認）:
     ・altText  Max character limit: 1500（Unicode emoji 可）
     ・postback action の label、Flex Message Button 上では Required・Max 40
       （「Specifications of the label」の表）
     ・postback action の data  Max character limit: 300
   「こたえを見る」は 6 字、data は 20 字前後 ── 余裕の内。

   altText に答えを入れない（§4-1）── 通知プレビューに答えが出たら、
   この仕組み全体が無意味になる。 */
export function renderReviewQuestion(template, user = {}) {
  const p = reviewParts(template, user);
  if (p === null) return null;                     /* 名前待ち ── 夕方は黙る */
  return {
    type: "flex",
    altText: `🌙 ${p.day}日目のふりかえり`,
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical",
        contents: [
          { type: "text", text: questionLines(template, p).join("\n"),
            wrap: true, size: "sm" }
        ]
      },
      footer: {
        type: "box", layout: "vertical",
        contents: [
          { type: "button", style: "primary", height: "sm",
            action: { type: "postback", label: "こたえを見る",
                      data: `action=answer&day=${p.day}`,
                      displayText: "こたえを見る" } }
        ]
      }
    }
  };
}

/* ---- 答え：テキスト 1 通。押されたときだけ（handlers/postback.mjs）。 */
export function renderReviewAnswer(template, user = {}) {
  const p = reviewParts(template, user);
  if (p === null) return null;
  return { type: "text", text: answerLines(template, p).join("\n") };
}

/* ---- テキスト 2 通（Flex 組み立てが落ちたときのフォールバック §4-3）--
   夕方が丸ごと止まるより、答えが同時に見えるほうが軽い。
   問い・答えとも上の共通部から組む ── 3 つ目の選び方を作らない。 */
export function renderReview(template, user = {}) {
  const p = reviewParts(template, user);
  if (p === null) return null;
  const q = [...questionLines(template, p), "", "…"];
  return [q.join("\n"), answerLines(template, p).join("\n")]
    .map((text) => ({ type: "text", text }));
}


/* ---- 復習クイズ 1 通（3 日周期、docs/plan-quiz.md）------------------
   選択肢は quickReply ── オンボーディング・決済と同じ形式で、
   Flex は使わない（この repo に無い形式を増やさない）。

   data に answer を載せない。data は利用者の端末を経由して戻る
   文字列で、押す前に書き換えれば必ず正解になる ── 正答は
   postback 側がサーバーの原稿から引く（handlers/postback.mjs）。

   label は 20 字まで。超えると LINE が 400 を返し、その人の朝の
   配信ごと落ちる（quickReply は本文と同じ 1 通の中にある）。 */
const CIRCLED = ["①", "②", "③", "④"];

/* 復習と節目で違うのは頭の 1 行と action だけ（plan-quiz-checkpoint §2）。
   組み立てを分けて持つと、label の 20 字制限のような決まりを
   片方だけ直すことになる。 */
function quizMessage(head, action, day, quiz) {
  return {
    type: "text",
    text: [
      head,
      "",
      quiz.question,
      "",
      ...quiz.choices.slice(0, CIRCLED.length).map((c, i) => `${CIRCLED[i]} ${c}`)
    ].join("\n"),
    quickReply: {
      items: quiz.choices.slice(0, CIRCLED.length).map((c, i) => ({
        type: "action",
        action: {
          type: "postback",
          label: `${CIRCLED[i]} ${String(c)}`.slice(0, 20),
          data: `action=${action}&day=${day}&choice=${i}`,
          displayText: `${CIRCLED[i]} ${String(c)}`.slice(0, 20)
        }
      }))
    }
  };
}

export function renderReviewQuiz(quiz) {
  if (!quiz || !Array.isArray(quiz.choices)) throw new Error("quiz がありません");
  const day = Number(quiz.dayNumber);
  return quizMessage(`🔁 ふくしゅうクイズ（${day}日目より）`, "review", day, quiz);
}

/* 節目（30/50/75）の 1 通。復習（action=review、無保存）とは別の部屋で、
   こちらの答えは postback 側が学期の合否として記録する。 */
export function renderCheckpointQuiz(day, quiz) {
  if (!quiz || !Array.isArray(quiz.choices)) throw new Error("quiz がありません");
  const d = Number(day);
  return quizMessage(`🎯 節目クイズ（${d}日目）`, "quiz", d, quiz);
}


/* 名前が要る原稿なのに名前が無い人がいる。LINE だけ登録して
   サイトの診断をしていない場合など。その日を飛ばすと 101 日の
   数が合わなくなるので、飛ばさずに名前の登録を促す。
   何を送るかは呼ぶ側が決められるよう、文面だけ返す。 */
export function nameMissingNotice(day) {
  return {
    type: "text",
    text: [
      `📚 ${day}日目`,
      "",
      "今日の内容はお名前を使うので、先にお名前を登録してください。",
      "登録すると、今日のぶんからお届けします。"
    ].join("\n")
  };
}

/* ---- クイズ採点の返事（docs/plan-quiz-harder-distractors.md §8）------
   不正解でも「選んだ番号」と「正解」を並べ、ひとことで形の意味を足す。
   data に answer は載せない（postback がサーバー原稿から引く）。 */
/* 採点のあと・正誤共通の締め（2026-08-09 代表 · plan-quiz-harder-distractors C）.
   正解だけの「今夜また…」はやめ、どちらでも同じ終わり方にする。 */
const QUIZ_CLOSING = [
  "今日もお疲れ様でした。",
  "言語は毎日の繰り返しです！",
  "また明日お会いしましょう。오늘도 화이팅！"
].join("\n");

export function formatQuizReply(quiz, choice, {
  passed,
  checkpointSemester = null
} = {}) {
  if (passed) {
    const head = checkpointSemester != null
      ? ["⭕ よくできました！🎉",
         `第${checkpointSemester}学期の節目クイズ、合格です！`]
      : ["⭕ よくできました！🎉"];
    return [...head, "", QUIZ_CLOSING].join("\n");
  }
  const mark = (i) => CIRCLED[i] || `${Number(i) + 1}`;
  const yours = quiz?.choices?.[choice];
  const correct = quiz?.choices?.[quiz.answer];
  const lines = [
    "❌ ざんねん…",
    `あなたの答え: ${mark(choice)} ${yours ?? ""}`.trimEnd(),
    `正解: ${mark(quiz.answer)} ${correct ?? ""}`.trimEnd()
  ];
  const tip = quizExplain(quiz);
  if (tip) lines.push(`ひとこと: ${tip}`);
  lines.push("", QUIZ_CLOSING);
  return lines.join("\n");
}

function quizExplain(quiz) {
  if (quiz?.explain && String(quiz.explain).trim()) return String(quiz.explain).trim();
  const q = String(quiz?.question || "");
  const m = /「([^」]+)」/.exec(q);
  if (!m) return "";
  /* 質問が「〜の韓国語は？」なら意味そのもの、「〜に当たる形は？」なら形の意味 */
  if (/韓国語/.test(q)) return `「${m[1]}」`;
  if (/当たる形|正しい形/.test(q)) return `「${m[1]}」の形です`;
  return `「${m[1]}」`;
}
