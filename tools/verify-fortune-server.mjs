/* ==================================================================
   verify-fortune-server.mjs — サーバーの運勢が、サイトと同じであること

   利用者は同じ日に、サイトでも LINE でも運勢を見る。片方が大吉で
   片方が小吉なら、そこで信用が終わる。しかも食い違いは静かに起きる
   ── どちらも「それらしい数字」を出すので、並べて見るまで分からない。

   食い違いの起こし方は 2 つしかない。

     1  server/ の中に saju.js / fortune.js の写しを置く
     2  今日の柱を出すとき、出生地ではなく固定の都市を使う

   1 は「直したつもりが片方だけ」になる。2 は東京生まれの人だけ
   ずれる、という一番読みにくい形で出る。両方をここで見る。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fortuneFor, engineDir, categories } from "../server/lib/fortune.mjs";
import {
  checkLines, fortuneMessage, rankCats, CAT_IDS, GRADES_KO, SIPSIN
} from "../server/lib/fortune-text.mjs";

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
const assert = (c, m) => { if (!c) throw new Error(m || "満たしていません"); };

const ME = { birth_date: "1995-04-12", birth_time: "09:00:00",
             raw_result_json: { city: "tokyo", zodiac: "돼지" } };

console.log("[出どころ]  写しを持たない");

check("server/ に saju.js / fortune.js の写しが無い", () => {
  /* 置いた瞬間、直したつもりが片方だけになる。 */
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "engine") continue;  /* engine は配置が写す */
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^(saju|fortune)\.js$/.test(e.name)) found.push(p);
    }
  })("server");
  assert(!found.length,
    `写しがあります: ${found.join(", ")}\n      サイトと別々に直せる状態です`);
  return "リポジトリに 1 部だけ";
});

check("エンジンを見つけて読み込める", () => {
  const d = engineDir();
  for (const f of ["saju.js", "fortune.js", "solar-terms.json"]) {
    assert(fs.existsSync(path.join(d, f)), `${f} がありません`);
  }
  return path.basename(d) || d;
});

console.log("\n[計算]  サイトと同じ引数で呼ぶ");

check("6 項目そろって出る", () => {
  const f = fortuneFor(ME, "2026-08-04");
  assert(f, "出ませんでした");
  const ids = categories().map((c) => c.id);
  for (const id of ids) {
    assert(Number.isFinite(f.scores[id]), `${id} の点が数値でありません`);
    assert(f.grades[id] && f.grades[id].ko, `${id} の等級がありません`);
  }
  return ids.join(" / ");
});

check("点は 0〜100 に収まる", () => {
  /* はみ出すと等級表の外に落ち、grades が undefined になる。 */
  let n = 0;
  for (let d = 1; d <= 28; d++) {
    const f = fortuneFor(ME, `2026-02-${String(d).padStart(2, "0")}`);
    for (const c of categories()) {
      const s = f.scores[c.id];
      assert(s >= 0 && s <= 100, `${c.id} が ${s}`);
      n++;
    }
  }
  return `${n} 通り`;
});

check("十神が出る（点の根拠がここ）", () => {
  const f = fortuneFor(ME, "2026-08-04");
  const TEN = ["비견","겁재","식신","상관","편재","정재","편관","정관","편인","정인"];
  assert(TEN.includes(f.god.stem), `stem: ${f.god.stem}`);
  assert(TEN.includes(f.god.branch), `branch: ${f.god.branch}`);
  return `${f.god.stem} / ${f.god.branch}`;
});

console.log("\n[取り違えやすい所]");

check("今日の柱は「出生地」で出す（固定の都市ではない）", () => {
  /* ソウル固定にすると、東京生まれの人だけ結果がずれる。
     ずれても数字は出るので、画面を見ていても気づけない。
     都市を変えたときに結果が動くことで、使っていることを確かめる。 */
  const days = ["2026-01-15", "2026-03-20", "2026-08-04", "2026-11-09"];
  const diff = days.filter((d) => {
    const a = fortuneFor(ME, d);
    const b = fortuneFor({ ...ME, raw_result_json: { ...ME.raw_result_json, city: "seoul" } }, d);
    return JSON.stringify(a.scores) !== JSON.stringify(b.scores);
  });
  assert(diff.length, "東京とソウルで結果が 1 日も変わりません。出生地を使っていません");
  return `${diff.length}/${days.length} 日で差が出る`;
});

check("日が変われば結果も変わる（日付を無視していない）", () => {
  const a = fortuneFor(ME, "2026-08-04");
  const b = fortuneFor(ME, "2026-08-05");
  assert(JSON.stringify(a.scores) !== JSON.stringify(b.scores),
    "翌日と同じ結果です。日付を使っていません");
  return "8/4 ≠ 8/5";
});

check("同じ人・同じ日なら、何度呼んでも同じ", () => {
  /* 朝の便と、あとで見返したときで違っては困る。 */
  const a = JSON.stringify(fortuneFor(ME, "2026-08-04").scores);
  for (let i = 0; i < 5; i++) {
    assert(JSON.stringify(fortuneFor(ME, "2026-08-04").scores) === a, "呼ぶたびに変わります");
  }
  return "5 回とも同じ";
});

check("生まれた時刻が分からない人にも出る", () => {
  const f = fortuneFor({ ...ME, birth_time: null }, "2026-08-04");
  assert(f && Number.isFinite(f.scores.total), "出ませんでした");
  return "hour = null";
});

check("top / bottom は同点でも決定的（지시서⑪ §2-2）", () => {
  /* sort の比較関数だけだと同点の順序は保証されない ── 同じ人に
     2 回計算して別の부적が出る。CAT_IDS の並びが 2 次基準。 */
  const tie = { total: 80, money: 60, love: 60, work: 60, health: 60, study: 60 };
  const a = rankCats(tie);
  for (let i = 0; i < 10; i++) {
    const b = rankCats({ ...tie });
    assert(b.top === a.top && b.bottom === a.bottom, "同点で答えが揺れます");
  }
  assert(a.top === "money" && a.bottom === "study",
    `全同点の答えが CAT_IDS 順ではありません: ${a.top}/${a.bottom}`);
  assert(rankCats({ total: 1 }).bottom === null, "total だけで bottom が出ました");
  return "全同点 → top=money / bottom=study（CAT_IDS 순）";
});

check("本文の「いちばん低い項目」と부적の願いが常に一致 ── 判定は 1 か所", () => {
  /* fortuneMessage も부적（push-daily の amuletSection）も rankCats を
     読む。sort がこのファイルに 1 つしか無いことまで見る ── 2 つ目の
     並べ替えが生えた日が、本文と부적が割れる日。 */
  const src = fs.readFileSync("server/lib/fortune-text.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert((src.match(/\.sort\(/g) || []).length === 1,
    "fortune-text.mjs に並べ替えが 2 つ以上あります");
  const f = fortuneFor(ME, "2026-08-04");
  const { bottom } = rankCats(f.scores);
  const lines = { cats: Object.fromEntries(CAT_IDS.map((id) =>
      [id, Object.fromEntries(GRADES_KO.map((g) => [g, { kr: `${id}-kr`, ja: `${id}-ja` }]))])),
    sipsin: Object.fromEntries(SIPSIN.map((s) => [s, { kr: "k", ja: "j" }])) };
  const m = fortuneMessage(f, lines);
  assert(m.text.includes(`${bottom}-kr`),
    `本文に bottom（${bottom}）の文章が出ていません`);
  return `bottom=${bottom} が本文と一致`;
});

check("gender は運勢を変えない（'N' 追加が結果に触れない・지시서⑩）", () => {
  /* 대표 결정(2026-08-06): 성별은 저장만, 계산 미사용。'N'(答えない)
     추가가 운세를 바꾸면 그 결정이 조용히 깨진 것。 */
  const base = JSON.stringify(fortuneFor({ ...ME, gender: "U" }, "2026-08-04"));
  for (const g of ["M", "F", "N"]) {
    assert(JSON.stringify(fortuneFor({ ...ME, gender: g }, "2026-08-04")) === base,
      `gender=${g} で運勢が変わりました`);
  }
  return "M / F / U / N とも同一";
});

check("四柱が無い人には出さない（既定の運勢を作らない）", () => {
  /* 作ってしまうと、全員が同じ運勢を受け取る。 */
  assert(fortuneFor({}, "2026-08-04") === null, "出してしまいました");
  assert(fortuneFor({ birth_date: null }, "2026-08-04") === null, "出してしまいました");
  return "null";
});

console.log("\n[文面]  数字を言葉にする所。当てはめ先が欠けると、その等級の日だけ消える");

/* 実物（server/content/fortune-lines.json）は公開リポジトリに無い。
   ここで見るのは「受け入れる条件」の側 ── 原稿を持っていない環境
   でも、何を満たすべきかは検査できる。lib/content-check.mjs と同じ。 */
const FULL = {
  cats: Object.fromEntries(CAT_IDS.map((c) =>
    [c, Object.fromEntries(GRADES_KO.map((g) => [g, { kr: `${c}${g}`, ja: `${c}${g}` }]))])),
  sipsin: Object.fromEntries(SIPSIN.map((s) => [s, { kr: `${s}kr`, ja: `${s}ja` }]))
};

check("当てはめ先が、エンジンの出すものと同じ並び", () => {
  /* ここがずれると、当てはめ先の無い等級・項目が出る。
     出た日は運勢が落ちるだけなので、入稿漏れと区別できない。 */
  const ids = categories().map((c) => c.id);
  assert(JSON.stringify(ids) === JSON.stringify([...CAT_IDS]),
    `項目: エンジン ${ids.join(",")} / 文面 ${CAT_IDS.join(",")}`);

  /* 等級はエンジンの GRADES から読む。fortune.js は
     globalThis に付ける書き方なので、実際に呼んで確かめる。 */
  const seen = new Set();
  for (let d = 1; d <= 28; d++) {
    const f = fortuneFor(ME, `2026-02-${String(d).padStart(2, "0")}`);
    for (const id of ids) seen.add(f.grades[id].ko);
  }
  for (const g of seen) {
    assert(GRADES_KO.includes(g), `エンジンが出す等級「${g}」が文面の表にありません`);
  }
  return `${CAT_IDS.length} 項目 / ${GRADES_KO.length} 等級 / ${SIPSIN.length} 十神`;
});

check("欠番を数える（30 マス + 十神 10）", () => {
  assert(checkLines(FULL).length === 0, JSON.stringify(checkLines(FULL)));

  /* 1 マス抜くと、そこだけ指摘される。全部まとめて返るので、
     入稿で何往復もしなくて済む。 */
  const hole = JSON.parse(JSON.stringify(FULL));
  delete hole.cats.money["대길"];
  const bad = checkLines(hole);
  assert(bad.length === 1 && /money.*대길/.test(bad[0]), JSON.stringify(bad));

  const noSip = JSON.parse(JSON.stringify(FULL));
  delete noSip.sipsin["정인"];
  assert(checkLines(noSip).some((m) => /정인/.test(m)), "十神の欠けを見ていません");
  return "1 マス抜くと 1 件";
});

check("知らない項目・等級が混ざったら指摘する", () => {
  /* 綴り違い（「대길」を「대吉」）は、抜けと違って気づけない ──
     30 マスは埋まっているのに、当てはめ先だけが無い。 */
  const typo = JSON.parse(JSON.stringify(FULL));
  typo.cats.money["대吉"] = { kr: "x", ja: "x" };
  assert(checkLines(typo).some((m) => /대吉/.test(m)), "綴り違いが素通りしました");

  const extra = JSON.parse(JSON.stringify(FULL));
  extra.cats.luck = {};
  assert(checkLines(extra).some((m) => /luck/.test(m)), "知らない項目が素通りしました");
  return "綴り違いも拾う";
});

check("kr だけ・ja だけの半端も通さない", () => {
  const half = JSON.parse(JSON.stringify(FULL));
  half.cats.love["길"] = { kr: "있음" };
  assert(checkLines(half).some((m) => /love.*길/.test(m)), "日本語が無いまま通りました");
  return "両方そろって 1 マス";
});

check("実際の運勢を文にできる", () => {
  const f = fortuneFor(ME, "2026-08-04");
  const m = fortuneMessage(f, FULL);
  assert(m && m.type === "text", JSON.stringify(m));
  assert(/총운/.test(m.text), m.text);
  /* 十神の一言が入る。点の根拠がここなので、落ちると
     「なぜ今日がそうなのか」が消える。 */
  assert(SIPSIN.some((s) => m.text.includes(`${s}kr`)), `十神がありません: ${m.text}`);
  /* 6 項目すべてに一言を付けると、韓国語と訳で 12 行になり
     レッスン本体より長くなる。高い方と低い方だけ。 */
  assert(m.text.split("\n").length <= 20, `${m.text.split("\n").length} 行あります`);
  return `${m.text.split("\n").length} 行`;
});

check("文面が無ければ、既定の一言を作らない", () => {
  assert(fortuneMessage(fortuneFor(ME, "2026-08-04"), null) === null, "作ってしまいました");
  assert(fortuneMessage(null, FULL) === null, "運勢が無いのに作りました");
  return "null";
});

check("bridge 는 운세 메시지에 더 이상 없다（지시서㉑ §1-3 ── 레슨 최하단으로 이동）", () => {
  /* fortune-text.mjs 가 bridge 를 아는 순간, 레슨（render.mjs 의 🍀）과
     이중으로 나갈 길이 열린다. 식별자 자체가 소스에 없는 것을 본다
     （주석 제외）. 출력에서도 옛 구분선이 사라졌는지 확인. */
  const src = fs.readFileSync("server/lib/fortune-text.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert(!/bridge/i.test(src), "fortune-text.mjs 에 bridge 식별자가 남아 있습니다");
  const m = fortuneMessage(fortuneFor(ME, "2026-08-04"), FULL);
  assert(!/──────────/.test(m.text), "옛 bridge 구분선이 출력에 남아 있습니다");
  assert(!/ひとこと/.test(m.text), "🍀 문구가 운세에 섞였습니다");
  return "식별자 0건・구분선 없음";
});

console.log(`\n${fails.length ? "✗" : "✓"} ${pass + fails.length} 項目中 ${pass} 件成功`);
if (fails.length) { fails.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
