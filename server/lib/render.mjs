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

/* ---- 1 日ぶんを組み立てる ------------------------------------------
   2 通に分ける。1 通に詰めると長くて読み飛ばされ、3 通以上だと
   通知が続けて鳴る。pushMessage は配列を受けるので、2 通でも
   API 呼び出しは 1 回で済む。

     1 通目  文法 + 会話
     2 通目  単語 3 語

   返すのは LINE の messages 配列そのもの。送信は呼ぶ側の仕事で、
   ここは文字列を作るだけにしておく ── そうしておくと、送らずに
   中身だけ確かめられる。 */
export function renderDay(template, user = {}) {
  if (!template) throw new Error("template がありません");

  const day  = Number(template.day_number);
  const lines = [];

  /* --- 1 通目 --- */
  const head = [`📚 ${day}日目`];
  if (template.grammar_point)  head.push(`【今日の文法】${template.grammar_point}`);
  if (template.grammar_tip_kr) head.push(template.grammar_tip_kr);

  /* 会話は 1 往復ごとに空行で離す。詰めて並べると、韓国語と訳が
     交互に 6 行続いて、どこまでが一人の台詞か読めなくなる。

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
    body.push(ja ? `${who}${kr}\n${ja}` : `${who}${kr}`);
  }
  if (body.length) head.push("", body.join("\n\n"));
  lines.push(head.join("\n"));

  /* --- 2 通目 --- */
  const vocab = Array.isArray(template.vocab_3) ? template.vocab_3 : [];
  if (vocab.length) {
    const v = ["🔖 今日の単語"];
    for (const w of vocab) {
      const note = w.note ? `　（${w.note}）` : "";
      v.push(`・${w.kr}　${w.meaning}${note}`);
    }
    lines.push(v.join("\n"));
  }

  return lines.map((text) => ({ type: "text", text }));
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
