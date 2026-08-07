/* ==================================================================
   verify-render.mjs — 原稿の差し込みを確かめる

   ここが間違うと、間違った韓国語を毎朝 101 日ぶん配ることになる。
   画面で見て気づける類いではない ── 「켄은」も「켄는」も、
   韓国語を知らない読み手には同じに見える。

   基準は 2 つ。
     1) サイト本体（index.html）と同じ助詞を返すこと。
        別々に持つと、同じ名前がウェブと LINE で違う形になる。
     2) 助詞の形が、名前のパッチムと一致すること。
        規則そのものを、コードとは別に書き下して突き合わせる。

   DB もネットワークも要らない。文字列を作る関数だけを見る。
   ================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  hasJong, fillSlots, renderDay, renderReview, renderReviewQuestion,
  renderReviewAnswer, findMisplacedSlot, SLOTS, nameMissingNotice
} from "../server/lib/render.mjs";
import { semesterForDay, SEMESTERS, TOTAL_DAYS } from "../server/lib/repo/learning.mjs";
/* 入稿の受け入れ条件。原稿そのものは公開リポジトリに無いが、
   「四柱の無い人が読めない日は入れない」は差し込みの規則なので
   この関門が見る（末尾）。 */
import { checkDay } from "../server/lib/content-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const fails = [];
function check(label, fn) {
  try {
    const note = fn();
    pass++;
    console.log(`  ✓ ${label}${note ? `　（${note}）` : ""}`);
  } catch (e) {
    fails.push(`${label} — ${e.message}`);
    console.log(`  ✗ ${label} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "満たしていません"); }

console.log("[パッチム判定]");

/* 末尾がパッチムを持つ名前と持たない名前。
   最後の 1 文字だけで決まるので、長さは関係ない。 */
const WITH_JONG    = ["켄", "전중", "다나카 켄", "김", "박", "윤", "홍길동"];
const WITHOUT_JONG = ["아이", "다나카", "미유", "사쿠라", "유키", "료"];

check("パッチムのある名前を見分ける", () => {
  for (const n of WITH_JONG) assert(hasJong(n) === true, `${n} を false と判定`);
  return `${WITH_JONG.length} 件`;
});
check("パッチムのない名前を見分ける", () => {
  for (const n of WITHOUT_JONG) assert(hasJong(n) === false, `${n} を true と判定`);
  return `${WITHOUT_JONG.length} 件`;
});
check("判定できないものは null（false と区別する）", () => {
  /* false は「終声が無い」で、null は「分からない」。
     混ぜると名前が空のときに母音終わりの助詞が付く。 */
  for (const n of ["Ken", "たなか", "田中", "", "  ", null, undefined])
    assert(hasJong(n) === null, `${JSON.stringify(n)} → ${hasJong(n)}（null のはず）`);
  return "英字・かな・漢字・空・null";
});

/* 合成ハングル全域。28 の剰余が 0 のときだけ終声が無い、という
   規則そのものと突き合わせる。実装と同じ式で照らすのではなく、
   終声なしの音節を並べて確かめる。 */
check("合成ハングル 11,172 字すべてで規則どおり", () => {
  let bad = 0;
  for (let c = 0xac00; c <= 0xd7a3; c++) {
    const ch = String.fromCharCode(c);
    const expect = (c - 0xac00) % 28 !== 0;
    if (hasJong(ch) !== expect) bad++;
  }
  assert(bad === 0, `${bad} 字で不一致`);
  return "11,172 字";
});

console.log("\n[助詞の選択]");

/* 規則を実装とは別にもう一度書き下す。
   実装を写すのではなく、韓国語の規則として書く。 */
const RULE = {
  NAME_IEYO: { yes: "이에요", no: "예요" },
  NAME_EUN:  { yes: "은",     no: "는"   },
  NAME_GA:   { yes: "이",     no: "가"   },
  NAME_EUL:  { yes: "을",     no: "를"   },
  NAME_WA:   { yes: "과",     no: "와"   },
  NAME_VOC:  { yes: "아",     no: "야"   }
};

check("パッチムのある名前に、あり側の助詞が付く", () => {
  for (const n of WITH_JONG)
    for (const [slot, r] of Object.entries(RULE))
      assert(fillSlots(`{${slot}}`, { name_kr: n }) === n + r.yes,
        `${n} + ${slot} → ${fillSlots(`{${slot}}`, { name_kr: n })}（期待 ${n + r.yes}）`);
  return `${WITH_JONG.length} 名 × ${Object.keys(RULE).length} 助詞`;
});

check("パッチムのない名前に、なし側の助詞が付く", () => {
  for (const n of WITHOUT_JONG)
    for (const [slot, r] of Object.entries(RULE))
      assert(fillSlots(`{${slot}}`, { name_kr: n }) === n + r.no,
        `${n} + ${slot} → ${fillSlots(`{${slot}}`, { name_kr: n })}（期待 ${n + r.no}）`);
  return `${WITHOUT_JONG.length} 名 × ${Object.keys(RULE).length} 助詞`;
});

/* サイトが一度「켄 씨은」を出した。逆側の助詞が付いていないかを、
   規則の反対を組み立てて名指しで見る。 */
check("逆側の助詞が付かない", () => {
  for (const n of [...WITH_JONG, ...WITHOUT_JONG]) {
    const j = hasJong(n);
    for (const [slot, r] of Object.entries(RULE)) {
      const got   = fillSlots(`{${slot}}`, { name_kr: n });
      const wrong = n + (j ? r.no : r.yes);      /* 逆側 */
      assert(got !== wrong, `${n} + ${slot} → ${got}（逆側が付きました）`);
    }
  }
  const pairs = WITH_JONG.length + WITHOUT_JONG.length;
  return `${pairs} 名 × ${Object.keys(RULE).length} 助詞の逆形`;
});

console.log("\n[四柱の差し込み]  この講座は四柱で韓国語を教える");

/* 五行と干支にも助詞が付く。値ごとに받침が違うので、
   名前と同じ規則が要る ── 목은 / 화는、돼지는 / 닭은。 */
const SAJU = { name_kr: "켄", name_reading: "けん",
               ohaeng_main: "목", raw_result_json: { zodiac: "돼지" } };

check("五行に助詞が付く（목=받침あり / 화=なし）", () => {
  assert(fillSlots("{OHAENG_EUN}", SAJU) === "목은", fillSlots("{OHAENG_EUN}", SAJU));
  const hwa = { ...SAJU, ohaeng_main: "화" };
  assert(fillSlots("{OHAENG_EUN}", hwa) === "화는", fillSlots("{OHAENG_EUN}", hwa));
  assert(fillSlots("{OHAENG_IEYO}", SAJU) === "목이에요", fillSlots("{OHAENG_IEYO}", SAJU));
  return "목은 / 화는 / 목이에요";
});

check("五行 5 つすべてで規則どおり", () => {
  /* 목·금 は받침あり、화·토·수 はなし。 */
  for (const [o, want] of [["목","목은"],["화","화는"],["토","토는"],["금","금은"],["수","수는"]]) {
    const got = fillSlots("{OHAENG_EUN}", { ...SAJU, ohaeng_main: o });
    assert(got === want, `${o} → ${got}（期待 ${want}）`);
  }
  return "목·금 は은 / 화·토·수 は는";
});

check("干支 12 すべてで規則どおり", () => {
  const want = { "쥐":"쥐가","소":"소가","호랑이":"호랑이가","토끼":"토끼가","용":"용이",
                 "뱀":"뱀이","말":"말이","양":"양이","원숭이":"원숭이가","닭":"닭이",
                 "개":"개가","돼지":"돼지가" };
  for (const [z, w] of Object.entries(want)) {
    const got = fillSlots("{ZODIAC_GA}", { ...SAJU, raw_result_json: { zodiac: z } });
    assert(got === w, `${z} → ${got}（期待 ${w}）`);
  }
  return "12 支";
});

check("日本語版はサーバーの表から出る（サイトは韓国語しか送らない）", () => {
  assert(fillSlots("{OHAENG_JP}", SAJU) === "木", fillSlots("{OHAENG_JP}", SAJU));
  assert(fillSlots("{ZODIAC_JP}", SAJU) === "いのしし", fillSlots("{ZODIAC_JP}", SAJU));
  return "목→木 / 돼지→いのしし";
});

check("四柱が無い人には組み立てない（既定の五行を入れない）", () => {
  /* 入れてしまうと、全員が同じ五行で占われる。 */
  assert(fillSlots("{OHAENG_EUN} 나무예요", { name_kr: "켄" }) === null, "既定を入れました");
  assert(fillSlots("{ZODIAC_GA} 좋아요", { name_kr: "켄" }) === null, "既定を入れました");
  return "null を返す";
});

check("五行・干支でも二重書きを見つける", () => {
  assert(findMisplacedSlot("{OHAENG}{OHAENG_EUN}"), "見逃しました");
  assert(findMisplacedSlot("{ZODIAC}{ZODIAC_GA}"), "見逃しました");
  assert(findMisplacedSlot("{OHAENG_EUN} 나무예요") === null, "正しい書き方を誤りとしました");
  return "OHAENG / ZODIAC";
});

console.log("\n[サイト本体との一致]");

/* index.html の fillName / ieyo / ega と同じ結果になるか。
   ソースから規則を読み出して、写し間違いではなく実物と比べる。 */
check("index.html の助詞規則と同じ", () => {
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  const site = {};
  for (const [re, slot] of [
    [/\.replace\(\/\\\{ieyo\\\}\/g,\s*j \? '([^']+)' : '([^']+)'\)/, "NAME_IEYO"],
    [/\.replace\(\/\\\{eun\\\}\/g,\s*j \? '([^']+)' : '([^']+)'\)/,   "NAME_EUN"],
    [/\.replace\(\/\\\{ga\\\}\/g,\s*j \? '([^']+)' : '([^']+)'\)/,    "NAME_GA"]
  ]) {
    const m = re.exec(src);
    assert(m, `index.html から ${slot} の規則を読めません`);
    site[slot] = { yes: m[1], no: m[2] };
  }
  for (const [slot, r] of Object.entries(site)) {
    assert(RULE[slot].yes === r.yes && RULE[slot].no === r.no,
      `${slot}: サイト ${r.yes}/${r.no} ・ サーバー ${RULE[slot].yes}/${RULE[slot].no}`);
  }
  return `${Object.keys(site).length} 助詞を実ソースから照合`;
});

console.log("\n[原稿の書き方]");

check("名前が二重になる書き方を見つける", () => {
  /* 助詞スロットは名前ごと置き換わるので、{NAME} と並べると二重になる。 */
  assert(findMisplacedSlot("{NAME}{NAME_EUN}"), "{NAME}{NAME_EUN} を見逃しました");
  assert(findMisplacedSlot("{NAME} 씨{NAME_EUN} 어디예요?"), "씨 が挟まる例を見逃しました");
  assert(findMisplacedSlot("{NAME_EUN} 일본에서 왔어요.") === null, "正しい書き方を誤りとしました");
  assert(findMisplacedSlot("{NAME}입니다.") === null, "助詞の無い文を誤りとしました");
  assert(findMisplacedSlot("{NAME} 씨는 어디예요?") === null, "literal の 씨는 を誤りとしました");
  return "二重・씨 挟み を検出";
});

check("二重になる書き方は実際に値が重なる（検出の根拠）", () => {
  const got = fillSlots("{NAME}{NAME_EUN}", { name_kr: "아이" });
  assert(got === "아이아이는", String(got));
  const o = fillSlots("{OHAENG}{OHAENG_EUN}", { ohaeng_main: "목" });
  assert(o === "목목은", String(o));
  return `아이 → ${got} / 목 → ${o}`;
});

check("差し込み口の一覧が実装と合っている", () => {
  assert(SLOTS.includes("NAME") && SLOTS.includes("NAME_JP"), "NAME / NAME_JP がありません");
  for (const s of Object.keys(RULE)) assert(SLOTS.includes(s), `${s} がありません`);
  return `${SLOTS.length} 種`;
});

console.log("\n[学期の切れ目]");

/* 原稿には学期を書かない（upsertTemplate が自分で入れる）。
   だから切れ目がずれると、原稿を直しても直らない。
   計画書が名指しした 1・30・31・50・51・75・76・101 を見る。 */
check("計画書どおりの切れ目", () => {
  const want = { 1:1, 30:1, 31:2, 50:2, 51:3, 75:3, 76:4, 101:4 };
  for (const [d, s] of Object.entries(want))
    assert(semesterForDay(Number(d)) === s, `${d}日目 → ${semesterForDay(Number(d))}（期待 ${s}）`);
  return "8 境界";
});

check("1〜101 日が隙間なく 1 学期に入る", () => {
  const count = {};
  for (let d = 1; d <= TOTAL_DAYS; d++) {
    const s = semesterForDay(d);
    assert(s >= 1 && s <= SEMESTERS.length, `${d}日目 → ${s}`);
    count[s] = (count[s] || 0) + 1;
  }
  for (const s of SEMESTERS)
    assert(count[s.semester] === s.to - s.from + 1,
      `${s.semester}学期 ${count[s.semester]}日（期待 ${s.to - s.from + 1}）`);
  assert(TOTAL_DAYS === SEMESTERS[SEMESTERS.length - 1].to, "TOTAL_DAYS と最終日がずれています");
  return "30 / 20 / 25 / 26 日";
});

console.log("\n[1 日ぶんの組み立て]");

const TPL = {
  day_number: 1,
  semester: 1,
  grammar_point: "-입니다 / -입니까?",
  grammar_tip_kr: "정중한 종결어미입니다。ていねいな文末。",
  dialogue_template: [
    { kr: "안녕하세요. 저는 {NAME}입니다.", ja: "こんにちは。わたしは{NAME_JP}です。" },
    { kr: "{NAME_EUN} 일본에서 왔어요.", ja: "{NAME_JP}は日本から来ました。" }
  ],
  vocab_3: [
    { kr: "안녕하세요", meaning: "こんにちは" },
    { kr: "저", meaning: "わたし", note: "へりくだった言い方" },
    { kr: "일본", meaning: "日本" }
  ],
  requires_name_slot: true
};

check("2 通に分かれる", () => {
  const m = renderDay(TPL, { name_kr: "아이", name_reading: "あい" });
  assert(m.length === 2, `${m.length} 通になりました`);
  assert(m.every((x) => x.type === "text"), "text 以外が混ざっています");
  return "文法+会話 / 単語";
});

check("韓国語の行に名前と助詞が入る", () => {
  const m = renderDay(TPL, { name_kr: "아이", name_reading: "あい" });
  assert(m[0].text.includes("저는 아이입니다"), m[0].text);
  assert(m[0].text.includes("아이는 일본에서"), m[0].text);
  return "아이 → 는";
});

check("パッチムのある名前では助詞が変わる", () => {
  const m = renderDay(TPL, { name_kr: "켄", name_reading: "けん" });
  assert(m[0].text.includes("켄은 일본에서"), m[0].text);
  assert(!m[0].text.includes("켄는"), "켄는 が出ました");
  return "켄 → 은";
});

check("会話は 1 往復ごとに空行で離れる", () => {
  const m = renderDay(TPL, { name_kr: "아이", name_reading: "あい" });
  /* 会話 2 往復 → 間に空行 1 つ。詰まると独り言に見える。 */
  assert(/입니다\.\nこんにちは。わたしはあいです。\n\n/.test(m[0].text),
    JSON.stringify(m[0].text));
  return "往復の間に空行";
});

check("話者（who）は任意で、付ければ頭に出る", () => {
  const withWho = { ...TPL, dialogue_template: [
    { who: "友だち", kr: "{NAME_GA} 누구예요?", ja: "{NAME_JP}さんはだれ？" },
    { who: "{NAME_JP}", kr: "저예요.", ja: "わたしです。" }] };
  const m = renderDay(withWho, { name_kr: "켄", name_reading: "けん" });
  assert(m[0].text.includes("友だち：켄이 누구예요?"), m[0].text);
  assert(m[0].text.includes("けん：저예요."), m[0].text);
  /* who を書かない日はそのまま（既存の原稿を壊さない） */
  const plain = renderDay(TPL, { name_kr: "켄", name_reading: "けん" });
  assert(!plain[0].text.includes("："), "who が無いのに区切りが出ました");
  return "who あり / なし 両方";
});

check("名前が無い人の話者札は「あなた」になる", () => {
  /* {NAME_JP} を札に使った日を、名前の無い人へ配ったときに
     「{NAME_JP}：」という文字がそのまま出ていた。
     札は名前ではなく役どころなので、既定を置いてよい ──
     置かないと差し込み口が画面に出る。 */
  const withWho = { ...TPL, requires_name_slot: false,
    dialogue_template: [{ who: "{NAME_JP}", kr: "학교에 가요.", ja: "学校に行きます。" }] };
  const m = renderDay(withWho, {});
  assert(m, "名前が無いだけで組み立てられませんでした");
  assert(!/\{NAME/.test(m[0].text), `差し込み口が出ました: ${m[0].text}`);
  assert(m[0].text.includes("あなた：学校に行きます。".slice(0,4)), m[0].text);
  return "あなた：";
});

check("名前がある人の話者札は、その人の呼び名になる", () => {
  const withWho = { ...TPL, requires_name_slot: false,
    dialogue_template: [{ who: "{NAME_JP}", kr: "학교에 가요.", ja: "学校に行きます。" }] };
  const m = renderDay(withWho, { name_kr: "켄", name_reading: "けん" });
  assert(m[0].text.includes("けん："), m[0].text);
  assert(!m[0].text.includes("あなた"), "名前があるのに あなた になりました");
  return "けん：";
});

check("組み立てた文に名前が二重に出ない", () => {
  for (const [kr, jp] of [["아이", "あい"], ["켄", "けん"], ["사쿠라", "さくら"]]) {
    const m = renderDay(TPL, { name_kr: kr, name_reading: jp });
    assert(!m[0].text.includes(kr + kr), `${kr} が二重に出ました: ${m[0].text}`);
  }
  return "3 名で確認";
});

check("日本語の行にはふりがなが入る（ハングルではない）", () => {
  const m = renderDay(TPL, { name_kr: "아이", name_reading: "あい" });
  const ja = m[0].text.split("\n").find((l) => l.includes("わたしは"));
  assert(ja.includes("あい"), ja);
  assert(!ja.includes("아이"), `日本語の行にハングルが出ました: ${ja}`);
  return "あい / 아이 を出し分け";
});

check("単語 3 語が 2 通目に入る", () => {
  const m = renderDay(TPL, { name_kr: "아이", name_reading: "あい" });
  for (const w of TPL.vocab_3) assert(m[1].text.includes(w.kr), `${w.kr} がありません`);
  assert(m[1].text.includes("へりくだった言い方"), "note が落ちています");
  return "note 付きも";
});

check("名前が要るのに無ければ null（勝手に既定名を入れない）", () => {
  assert(renderDay(TPL, {}) === null, "名前なしで組み立ててしまいました");
  assert(fillSlots("{NAME}입니다", {}) === null, "fillSlots が null を返しません");
  return "呼ぶ側が代替へ切り替える";
});

check("名前を使わない原稿は名前が無くても組み立つ", () => {
  const noName = { ...TPL, requires_name_slot: false,
    dialogue_template: [{ kr: "안녕하세요.", ja: "こんにちは。" }] };
  const m = renderDay(noName, {});
  assert(m && m.length === 2, "組み立てられませんでした");
  return "挨拶だけの日";
});

check("名前が無い日の案内文がある", () => {
  const n = nameMissingNotice(7);
  assert(n.type === "text" && n.text.includes("7日目"), JSON.stringify(n));
  assert(n.text.includes("お名前"), "名前登録を促していません");
  return "101 日の数を崩さず促す";
});

console.log("\n[ふりかえり]  夕方の便。朝の再送にしない");

const REVIEW_TPL = {
  ...TPL,
  dialogue_template: [
    { kr: "안녕하세요.", ja: "こんにちは。" },
    { kr: "{NAME_IEYO}.", ja: "{NAME_JP}です。" },
    { kr: "반가워요.", ja: "はじめまして。" }
  ]
};

check("問いと答えの 2 通になる", () => {
  const m = renderReview(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" });
  assert(m && m.length === 2, `${m ? m.length : 0} 通`);
  assert(m[0].type === "text" && m[1].type === "text", JSON.stringify(m));
  return "問い → 答え";
});

check("会話は 1 文だけ拾う（全部出すと朝の再送になる）", () => {
  const m = renderReview(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" });
  const q = m[0].text;
  /* 3 文のうち出るのは 1 文。名前を使う文が優先 ── この講座で
     覚えてほしいのは「自分の名前で言える形」なので。 */
  assert(q.includes("아이예요"), `名前の文が選ばれていません: ${q}`);
  assert(!q.includes("반가워요"), `会話を全部出しています: ${q}`);
  return "名前の入る 1 文";
});

check("名前を使う文が無ければ、先頭の文で足りる", () => {
  const noName = { ...REVIEW_TPL, requires_name_slot: false,
    dialogue_template: [{ kr: "안녕하세요.", ja: "こんにちは。" }] };
  const m = renderReview(noName, {});
  assert(m && m[0].text.includes("안녕하세요"), JSON.stringify(m));
  return "先頭の 1 文";
});

check("問いの側に訳と意味を出さない", () => {
  /* 同じ画面に答えが出ていると、思い出す間が無い。
     ここが崩れると、復習が「もう一度読むだけ」に戻る。 */
  const m = renderReview(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" });
  const [q, a] = m.map((x) => x.text);
  assert(!q.includes("あいです"), `1 通目に訳が出ています: ${q}`);
  assert(a.includes("あいです"), `2 通目に訳がありません: ${a}`);
  /* 単語はハングルだけ。「일본」は 1 通目に出て、「日本」は出ない。 */
  assert(q.includes("일본"), `1 通目に単語がありません: ${q}`);
  assert(!q.includes("日本"), `1 通目に単語の意味が出ています: ${q}`);
  assert(a.includes("日本"), `2 通目に単語の意味がありません: ${a}`);
  return "訳と意味は 2 通目だけ";
});

check("受け取る側が何日目か分かる", () => {
  const m = renderReview(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" });
  assert(m[0].text.includes(`${TPL.day_number}日目`), m[0].text.slice(0, 30));
  return `${TPL.day_number}日目`;
});

check("名前が要るのに無ければ null（朝と同じ扱い）", () => {
  /* 既定名を入れない。入れると全員が同じ名前で呼ばれる。 */
  assert(renderReview(REVIEW_TPL, {}) === null, "名前なしで組み立ててしまいました");
  /* Flex の問い・押されたときの答えも同じ扱い（지시서⑨ §2-5）。 */
  assert(renderReviewQuestion(REVIEW_TPL, {}) === null, "Flex 問いが名前なしで組めました");
  assert(renderReviewAnswer(REVIEW_TPL, {}) === null, "答えが名前なしで組めました");
  return "呼ぶ側が黙る（Flex・答えも）";
});

/* ---- 夕方の問いは Flex（지시서⑨）------------------------------------ */

const flexQ = () => renderReviewQuestion(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" });
const flexBodyText = (m) => m.contents.body.contents[0].text;

check("問いは Flex 1 通で、altText に答えを入れない（§4-1）", () => {
  const m = flexQ();
  assert(m.type === "flex", m.type);
  /* altText: LINE 公式リファレンス（index.html.md 原文、2026-08-06 確認）
     Max character limit: 1500・Unicode emoji 可。通知プレビューに
     出る文字列なので、答え（訳・意味）を入れたらこの仕組みごと無意味。 */
  assert(m.altText && m.altText.length <= 1500, `altText: ${m.altText}`);
  assert(new RegExp(`^🌙 ${REVIEW_TPL.day_number}日目のふりかえり$`).test(m.altText), m.altText);
  assert(!m.altText.includes("あいです") && !m.altText.includes("日本"),
    `altText に答えが入っています: ${m.altText}`);
  return m.altText;
});

check("ボタンは action=answer&day= の postback（label 40 字以内）", () => {
  const m = flexQ();
  const btn = m.contents.footer.contents[0];
  assert(btn.type === "button", JSON.stringify(btn));
  const a = btn.action;
  assert(a.type === "postback", a.type);
  assert(a.data === `action=answer&day=${REVIEW_TPL.day_number}`, a.data);
  /* Flex Message の Button 上の postback label は Required・Max 40
     （公式「Specifications of the label」の表、2026-08-06 確認）。
     data は Max 300 ── どちらも余裕の内であることを機械で保つ。 */
  assert(a.label && a.label.length <= 40, `label: ${a.label}`);
  assert(a.data.length <= 300, `data が 300 字を超えています`);
  return `${a.label} → ${a.data}`;
});

check("Flex の問い本文にも答えを入れない・差し込み口を残さない", () => {
  const t = flexBodyText(flexQ());
  assert(t.includes("아이예요"), `名前の文がありません: ${t}`);
  assert(!t.includes("あいです"), `問いに訳が出ています: ${t}`);
  assert(t.includes("일본") && !t.includes("日本"), `単語の意味が出ています: ${t}`);
  assert(!/\{[A-Z_]+\}/.test(t), "差し込み口が残っています");
  return "問いはハングルだけ";
});

check("問いと答えが同じ会話文 1 文を選ぶ（共通部の共有・§2-4）", () => {
  /* 選び方が 2 か所にあると、直した日に問いと答えが別の文になり、
     利用者にはただの故障に見える。 */
  const q = flexBodyText(flexQ());
  const a = renderReviewAnswer(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" }).text;
  assert(q.includes("아이예요") && a.includes("아이예요"), "同じ文を選んでいません");
  assert(!q.includes("반가워요") && !a.includes("반가워요"), "別の文が混ざっています");
  return "同じ 1 文";
});

check("答えの末尾に「明日の朝7時」が残る（§2-6 ── ⑧の --not-after が真に保つ）", () => {
  const a = renderReviewAnswer(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" }).text;
  assert(/明日の朝7時に、次の日をおとどけします。/.test(a), a.split("\n").pop());
  return "残す（配達の約束は cron の上限が守る）";
});

check("받침 の規則は朝と同じものを通る", () => {
  const jong  = renderReview(REVIEW_TPL, { name_kr: "켄", name_reading: "けん" });
  const vowel = renderReview(REVIEW_TPL, { name_kr: "아이", name_reading: "あい" });
  assert(jong[0].text.includes("켄이에요"), jong[0].text);
  assert(vowel[0].text.includes("아이예요"), vowel[0].text);
  /* 差し込み口が残っていない。残ると {NAME_IEYO} が画面に出る。 */
  for (const m of [...jong, ...vowel]) {
    assert(!/\{[A-Z_]+\}/.test(m.text), `差し込み口が残っています: ${m.text}`);
  }
  return "켄이에요 / 아이예요";
});

/* ---- 原稿の受け入れ ── 四柱の無い人（2026-08-07 대표 승인）------------
   ここは render そのものではなく「入稿できる形か」だが、この関門に
   置く。守っているのが差し込みの規則そのものだからで、離すと
   「render は通るのに配れない日」がどちらの関門からも落ちる。 */

console.log("\n[原稿の受け入れ]  四柱の無い人（LINE 直接）が読めるか");

const SAJU_TPL = {
  day_number: 53,
  grammar_point: "-와 / -과",
  grammar_tip_kr: "どちらも〜と。書き言葉は -와/과。",
  requires_name_slot: true,
  dialogue_template: [
    { kr: "{NAME_EUN} {OHAENG_GA} 좋아요.", ja: "{NAME_JP}は五行が良いです。" },
    { kr: "저도 그래요.", ja: "わたしもそうです。" }
  ],
  vocab_3: [
    { kr: "오행", meaning: "五行" },
    { kr: "띠",   meaning: "干支" },
    { kr: "같다", meaning: "同じだ" }
  ]
};

check("四柱を使った日は入稿できない（その人の講座がそこで永久に止まる）", () => {
  /* LINE から直接来た人に ohaeng_main が入る道はコードに無い。
     入れると renderDay が null → push-daily が「名前が無い」と読んで
     日を進めず、2 回促して黙る。名前はもう在るので出口が無い。 */
  const bad = checkDay(SAJU_TPL);
  assert(bad.length > 0, "{OHAENG} を使った日が通ってしまいました");
  assert(bad.some((m) => m.includes("{OHAENG}")),
    `理由が名指しされていません: ${bad.join(" / ")}`);
  return bad.length + " 件";
});

check("四柱を使わない日は通る（誤検知しない）", () => {
  /* 3 人目を足したせいで、名前だけの日まで落ちるようになっていないか。
     ここが無いと「全部落ちる関門」でも合格に見える。 */
  const ok = { ...SAJU_TPL, dialogue_template: [
    { kr: "{NAME_EUN} 학생이에요.", ja: "{NAME_JP}は学生です。" },
    { kr: "저도 그래요.",           ja: "わたしもそうです。" }
  ] };
  const bad = checkDay(ok);
  assert(bad.length === 0, bad.join(" / "));
  return "名前だけの日は通る";
});

check("説明（grammar_tip_kr）の差し込み口を欄の名前で止める", () => {
  /* renderDay は tip を fillSlots に通さない。書くと {NAME_EUN} が
     文字のまま届く。組み立ての検査でも落ちるが、どの欄かを言わないと
     51 日ぶん書いてから気づくことになる。 */
  const tip = { ...SAJU_TPL, requires_name_slot: false,
    grammar_tip_kr: "{NAME_EUN} こう言います。",
    dialogue_template: [
      { kr: "안녕하세요.", ja: "こんにちは。" },
      { kr: "저도 그래요.", ja: "わたしもそうです。" }
    ] };
  const bad = checkDay(tip);
  assert(bad.some((m) => m.includes("grammar_tip_kr")),
    `欄の名前が出ていません: ${bad.join(" / ")}`);
  return "欄の名前で言う";
});

check("説明に差し込み口が無ければ requires_name_slot は本文だけで決まる", () => {
  /* tip を数えたままだと、tip に書いた日が「欄が違う」と
     「申告が違う」の 2 つで落ちて、直す所がぼやける。 */
  const bodyOnly = { ...SAJU_TPL, requires_name_slot: false,
    grammar_tip_kr: "どちらも〜と。",
    dialogue_template: [
      { kr: "안녕하세요.", ja: "こんにちは。" },
      { kr: "저도 그래요.", ja: "わたしもそうです。" }
    ] };
  assert(checkDay(bodyOnly).length === 0, checkDay(bodyOnly).join(" / "));
  /* 本文で使えば true が要る、は今までどおり。 */
  const named = { ...bodyOnly, dialogue_template: [
    { kr: "{NAME_EUN} 학생이에요.", ja: "{NAME_JP}は学生です。" },
    { kr: "저도 그래요.",           ja: "わたしもそうです。" }
  ] };
  assert(checkDay(named).some((m) => m.includes("requires_name_slot")),
    "本文で名前を使ったのに申告の食い違いを見ていません");
  return "本文だけを見る";
});

check("vocab_3・fortune_bridge・quiz の差し込み口禁止は NAME だけでなく全部（2026-08-07）", () => {
  /* この 3 つは fillSlots を一度も通らない ── {NAME} も {OHAENG_GA} も
     区別なく文字のまま画面に出る。SQL3(A) の指摘で、以前は {NAME}
     だけを見ていて OHAENG/ZODIAC が漏れていたことに気づいた。 */
  const base = { day_number: 60, grammar_point: "-마다", grammar_tip_kr: "〜ごとに。",
    requires_name_slot: false,
    dialogue_template: [{ kr: "안녕하세요.", ja: "こんにちは。" },
                         { kr: "반가워요.", ja: "はじめまして。" }] };

  const vocabBad = checkDay({ ...base,
    vocab_3: [{ kr: "{OHAENG} 좋다", meaning: "良い" }, { kr: "봄", meaning: "春" }, { kr: "가을", meaning: "秋" }] });
  assert(vocabBad.some((m) => m.includes("単語") && m.includes("差し込み口")), vocabBad.join(" / "));

  const fbBad = checkDay({ ...base,
    vocab_3: [{ kr: "봄", meaning: "春" }, { kr: "가을", meaning: "秋" }, { kr: "겨울", meaning: "冬" }],
    fortune_bridge: { kr: "{ZODIAC_EUN} 기운이 좋아요." } });
  assert(fbBad.some((m) => m.includes("fortune_bridge に差し込み口は使えません")), fbBad.join(" / "));

  const quizBad = checkDay({ ...base,
    vocab_3: [{ kr: "봄", meaning: "春" }, { kr: "가을", meaning: "秋" }, { kr: "겨울", meaning: "冬" }],
    quiz: { question: "{OHAENG} 다음 조사는?", choices: ["이", "가"], answer: 0 } });
  assert(quizBad.some((m) => m.includes("quiz に差し込み口は使えません")), quizBad.join(" / "));

  return "vocab_3 / fortune_bridge / quiz 全部で検出";
});

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
