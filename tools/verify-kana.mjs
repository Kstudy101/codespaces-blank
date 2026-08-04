/* ==================================================================
   verify-kana.mjs — かな→ハングル変換の移植と、名前教正の対話

   server/lib/kana2hangul.mjs は index.html の変換部の**写し**で、
   この repo で写しは本来禁じ手（ウェブと LINE で同じ名前が違う
   ハングルになったら、どちらももっともらしいので並べるまで
   気づけない）。写しを許した唯一の担保がこの関門 ──

     index.html から実物を vm で切り出し、移植版と突き合わせる。
     全表 + 規則の境界。1 件でも違えば配置が止まる。

   後半は step① の対話（2026-08-04 Phase 1 指示書）。守るものは:
     ・サイトへ戻さない（そこで離脱が起きていた）
     ・確定名は DB の候補から作り直す ── postback data の名前は信じない
     ・確認（OK?）の前に name_kr を書かない ── 未確定の名前で
       101 日が始まらない
   ================================================================== */
import fs from "node:fs";
import vm from "node:vm";
import * as srv from "../server/lib/kana2hangul.mjs";
import { handlePostback } from "../server/lib/handlers/postback.mjs";
import { handleMessage } from "../server/lib/handlers/message.mjs";

let pass = 0;
const fails = [];
async function check(label, fn) {
  try {
    const note = await fn();
    pass++;
    console.log(`  ✓ ${label}${note ? `　（${note}）` : ""}`);
  } catch (e) {
    fails.push(`${label} — ${e.message}`);
    console.log(`  ✗ ${label} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "満たしていません"); }

/* ---- 実物を index.html から切り出す（verify-name と同じやり方）---- */
const IDX = fs.readFileSync("index.html", "utf8");
const from = IDX.indexOf("const CHO = [");
const to   = IDX.indexOf("const HANJA = {");
if (from < 0 || to <= from) {
  console.error("✗ index.html から変換部を切り出せません（節の見出しが変わった可能性）");
  process.exit(1);
}
const box = {};
vm.createContext(box);
vm.runInContext(IDX.slice(from, to)
  + "\n;globalThis.KANA1=KANA1;globalThis.KANA2=KANA2;"
  + "globalThis.isKana=isKana;globalThis.toHira=toHira;",
  box, { filename: "index.html<kana>" });

const web = (s) => box.kanaToHangul(s).join("");
const mod = (s) => srv.kanaToHangul(s).join("");

console.log("[写しの突き合わせ]  1 件でも違えば、ウェブと LINE で名前が割れている");

let compared = 0;
const diff = [];
const cmp = (input) => {
  compared++;
  const a = web(input), b = mod(input);
  if (a !== b) diff.push(`「${input}」 web=${a} / server=${b}`);
};

await check("表そのものが同一（鍵と値の完全一致）", () => {
  for (const t of ["KANA1", "KANA2"]) {
    const w = box[t], s = srv[t];
    const wk = Object.keys(w), sk = Object.keys(s);
    assert(wk.length === sk.length, `${t} の項目数が違います: web ${wk.length} / server ${sk.length}`);
    for (const k of wk) assert(s[k] === w[k], `${t}['${k}']: web ${w[k]} / server ${s[k]}`);
  }
  return `KANA1 ${Object.keys(box.KANA1).length} + KANA2 ${Object.keys(box.KANA2).length} 項目`;
});

await check("全項目を単独・撥音付き・促音付き・長音付きで変換して一致", () => {
  const keys = [...Object.keys(box.KANA1), ...Object.keys(box.KANA2)];
  for (const k of keys) {
    cmp(k);
    cmp(k + "ん");
    cmp("か" + "っ" + k);   /* 促音は直前の音節に効く ── 前に置いて試す */
    cmp(k + "ー");
  }
  assert(!diff.length, `${diff.length} 件不一致:\n      ${diff.slice(0, 5).join("\n      ")}`);
  return `${compared} 通り一致`;
});

await check("規則の境界 ── 長母音・独立モーラ・小書き・カタカナ", () => {
  const CASES = [
    "とうきょう", "とーきょー", "おおさか", "こうすけ", "ゆうき", "りょうた",
    /* う/お の直後が母音なら独立モーラ（いのうえ → 이노우에） */
    "いのうえ", "おおうえ", "さとう", "かとうあい",
    /* 促音・撥音の連続と末尾 */
    "きって", "さっか", "けん", "しんいち", "じゅん", "はっとり",
    /* 拗音が KANA1 に勝つこと */
    "きゃんでぃ", "しょうこ", "ちゅうや", "じぇいむす",
    /* 小書き・ゔ・ヶヵヮ（README の ヶ 消失バグの再発防止） */
    "ゔぃおら", "ヴィヴィアン", "三ヶ田".replace("三", "み").replace("田", "た"),
    "ミヶタ", "ハヮイ", "ヵナ",
    /* 空白まじり・全カタカナ */
    "たなか はなこ", "タナカ　ハナコ", "ウェンディ", "ファビオ"
  ];
  for (const c of CASES) cmp(c);
  assert(!diff.length, `${diff.length} 件不一致:\n      ${diff.join("\n      ")}`);
  return `境界 ${CASES.length} 通り一致（累計 ${compared} 通り）`;
});

await check("isKana の判定も同一（受け入れの境界がずれない）", () => {
  const CASES = ["はなこ", "タロウ", "Hanako", "hanako", "다나카", "花子",
    "はなこ🎸", "", " ", "たなか はなこ", "ター", "ｱｲｳ"];
  for (const c of CASES) {
    assert(box.isKana(c) === srv.isKana(c),
      `isKana("${c}"): web ${box.isKana(c)} / server ${srv.isKana(c)}`);
  }
  return `${CASES.length} 通り`;
});

await check("変換できないものは null（空の名前を作らない）", () => {
  for (const bad of ["Hanako", "", "  ", "花子", "🎸"]) {
    assert(srv.kanaNameToHangul(bad) === null, `「${bad}」が ${srv.kanaNameToHangul(bad)} になりました`);
  }
  assert(srv.kanaNameToHangul("はなこ") === "하나코", "はなこ が 하나코 になりません");
  return "かな以外・空は null";
});

/* ---- step① の対話（偽の接続。verify-push と同じやり方）------------ */
console.log("\n[対話]  サイトへ戻さない・data の名前を信じない・確定前に書かない");

function fakeConn(rows = {}) {
  const calls = [];
  return {
    calls,
    sql: () => calls.map((c) => c.sql.replace(/\s+/g, " ").trim()),
    async execute(sql, params = []) {
      calls.push({ sql, params });
      for (const [pattern, value] of Object.entries(rows)) {
        if (new RegExp(pattern, "i").test(sql)) {
          return [typeof value === "function" ? value(sql, params) : value, []];
        }
      }
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }, []];
      return [[], []];
    }
  };
}

const U = (over = {}) => [{
  id: 7, line_user_id: "U_test", display_name: "タロウ",
  name_kanji: null, name_reading: null, name_kr: null, name_source: null,
  status: "active", active_track: null, ...over
}];

const PB = (data) => ({ source: { userId: "U_test" }, replyToken: "rt", postback: { data } });
/* handleMessage は replyMessage を直接呼ぶ。LINE Developers の「検証」
   ボタンと同じダミー token（0 の並び）を渡すと送信を飛ばすので、
   ここでもそれを使う ── 見たいのは DB と判定で、送信ではない。 */
const MSG = (text) => ({ source: { userId: "U_test" }, replyToken: "00000000",
  message: { type: "text", text } });

const nameUpdates = (conn) =>
  conn.calls.filter((c) => /UPDATE users SET name_kanji/i.test(c.sql));

await check("表示名がかな → その場で変換して「OK?」。確定はまだ書かない", async () => {
  const conn = fakeConn({ "FROM users": U() });
  let replied = null;
  const r = await handlePostback(conn, PB("action=name&use=line"),
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.pendingConfirm, JSON.stringify(r));
  assert(replied[0].text.includes("타로"), `変換が出ていません: ${replied[0].text}`);
  const ups = nameUpdates(conn);
  assert(ups.length === 1 && ups[0].params[1] === "タロウ" && ups[0].params[2] === null,
    "候補の置き方が違います（name_reading に候補・name_kr は空のはず）");
  assert(!JSON.stringify(replied).includes("kstudy101.jp"), "サイトへ戻しています");
  return "タロウ → 타로 の確認へ";
});

await check("表示名がかなでない → 読みを 1 行たのむ。サイトへ戻さない", async () => {
  const conn = fakeConn({ "FROM users": U({ display_name: "John🎸" }) });
  let replied = null;
  const r = await handlePostback(conn, PB("action=name&use=line"),
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.askedReading, JSON.stringify(r));
  assert(replied[0].text.includes("読み方"), replied[0].text);
  assert(!replied[0].text.includes("kstudy101.jp"), "最初の案内にサイトを出しています（最後の手段のはず）");
  return "John🎸 → 読み仮名の入力へ";
});

await check("「べつの名前にする」も読みの入力へ", async () => {
  const conn = fakeConn({ "FROM users": U() });
  let replied = null;
  const r = await handlePostback(conn, PB("action=name&use=other"),
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.askedReading && replied[0].text.includes("読み方"), JSON.stringify(r));
  return "第 3 の名前も同じ道";
});

await check("待っている人のかな 1 行 → 候補を置いて「OK?」", async () => {
  const conn = fakeConn({ "FROM users": U({ name_source: "line" }) });
  let replied = null;
  const r = await handleMessage(conn, MSG("はなこ"));
  /* handleMessage は replyMessage を直接呼ぶ ── 検証では replyToken "rt" が
     偽物なので送信は失敗しうる。見るのは DB の側。 */
  const ups = nameUpdates(conn);
  assert(ups.length === 1 && ups[0].params[1] === "はなこ" && ups[0].params[2] === null,
    `候補の置き方が違います: ${JSON.stringify(ups.map((u) => u.params))}`);
  assert(r.reading === "candidate", JSON.stringify(r));
  return "はなこ → 하나코 の確認へ";
});

await check("読めない入力 → 再入力の案内。DB には触らない", async () => {
  const conn = fakeConn({ "FROM users": U({ name_source: "line" }) });
  const r = await handleMessage(conn, MSG("hanako"));
  assert(r.reading === "retry", JSON.stringify(r));
  assert(nameUpdates(conn).length === 0, "読めないのに候補を書いています");
  return "案内 + 最後の手段のサイト";
});

await check("待っている人でも「解約」は素通し（名前として拾わない）", async () => {
  const conn = fakeConn({ "FROM users": U({ name_source: "line" }) });
  const r = await handleMessage(conn, MSG("やめたい"));
  assert(r.reading === undefined, `名前として拾いました: ${JSON.stringify(r)}`);
  assert(nameUpdates(conn).length === 0, "候補を書いています");
  return "ブロックの案内側へ";
});

await check("確定は DB の候補から作り直す ── data の名前は無力", async () => {
  const conn = fakeConn({ "FROM users": U({ name_source: "line", name_reading: "はなこ" }) });
  let replied = null;
  const r = await handlePostback(conn,
    PB("action=name&use=confirm&ok=1&name=악당&kr=악당"),   /* 改竄を装う */
    { send: async (_t, m) => { replied = m; return {}; } });
  assert(r.ok === true && r.nameKr === "하나코", JSON.stringify(r));
  const ups = nameUpdates(conn);
  assert(ups.length === 1 && ups[0].params[2] === "하나코",
    `確定の書き込みが違います: ${JSON.stringify(ups.map((u) => u.params))}`);
  assert(!JSON.stringify(replied).includes("악당"), "data の名前が文面に出ています");
  return "data の 악당 は捨てられ、DB の はなこ → 하나코";
});

await check("「入れ直す」→ 候補を消して、もう一度読みから", async () => {
  const conn = fakeConn({ "FROM users": U({ name_source: "line", name_reading: "はなこ" }) });
  let replied = null;
  const r = await handlePostback(conn, PB("action=name&use=confirm&ok=0"),
    { send: async (_t, m) => { replied = m; return {}; } });
  const ups = nameUpdates(conn);
  assert(ups.length === 1 && ups[0].params[1] === null && ups[0].params[2] === null,
    "候補が消えていません");
  assert(replied[0].text.includes("読み方"), replied[0].text);
  return "やり直しは読みから";
});

await check("サイトの名前を選ぶ道は変わっていない（回帰）", async () => {
  const conn = fakeConn({ "FROM users": U({ name_kr: "다나카", name_reading: "たなか" }) });
  const r = await handlePostback(conn, PB("action=name&use=web"),
    { send: async () => ({}) });
  assert(r.use === "web", JSON.stringify(r));
  assert(conn.sql().some((s) => /UPDATE users SET name_source/i.test(s)), "name_source が入っていません");
  assert(nameUpdates(conn).length === 0, "ウェブの名前を書き換えています");
  return "現行維持";
});

console.log(fails.length
  ? `\n✗ ${fails.length} 件が満たされていません`
  : `\n✓ ${pass} 件、すべて満たしています`);
process.exit(fails.length ? 1 : 0);
