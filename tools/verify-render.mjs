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
  hasJong, fillSlots, renderDay, findMisplacedSlot, SLOTS, nameMissingNotice
} from "../server/lib/render.mjs";
import { semesterForDay, SEMESTERS, TOTAL_DAYS } from "../server/lib/repo/learning.mjs";

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
      assert(fillSlots(`{${slot}}`, { nameKr: n }) === n + r.yes,
        `${n} + ${slot} → ${fillSlots(`{${slot}}`, { nameKr: n })}（期待 ${n + r.yes}）`);
  return `${WITH_JONG.length} 名 × ${Object.keys(RULE).length} 助詞`;
});

check("パッチムのない名前に、なし側の助詞が付く", () => {
  for (const n of WITHOUT_JONG)
    for (const [slot, r] of Object.entries(RULE))
      assert(fillSlots(`{${slot}}`, { nameKr: n }) === n + r.no,
        `${n} + ${slot} → ${fillSlots(`{${slot}}`, { nameKr: n })}（期待 ${n + r.no}）`);
  return `${WITHOUT_JONG.length} 名 × ${Object.keys(RULE).length} 助詞`;
});

/* サイトが一度「켄 씨은」を出した。逆側の助詞が付いていないかを、
   規則の反対を組み立てて名指しで見る。 */
check("逆側の助詞が付かない", () => {
  for (const n of [...WITH_JONG, ...WITHOUT_JONG]) {
    const j = hasJong(n);
    for (const [slot, r] of Object.entries(RULE)) {
      const got   = fillSlots(`{${slot}}`, { nameKr: n });
      const wrong = n + (j ? r.no : r.yes);      /* 逆側 */
      assert(got !== wrong, `${n} + ${slot} → ${got}（逆側が付きました）`);
    }
  }
  const pairs = WITH_JONG.length + WITHOUT_JONG.length;
  return `${pairs} 名 × ${Object.keys(RULE).length} 助詞の逆形`;
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

check("二重になる書き方は実際に名前が重なる（検出の根拠）", () => {
  const got = fillSlots("{NAME}{NAME_EUN}", { nameKr: "아이" });
  assert(got === "아이아이는", got);
  return `아이 → ${got}`;
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

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
