#!/usr/bin/env node
/* ==================================================================
   verify-no-fortune.mjs — 運勢は事業から外した（2026-08-16）

     使い方:  node tools/verify-no-fortune.mjs

   【なぜ「無いこと」を見る関門が要るのか】
   2026-08-16 の事業転換（docs/plan-fortune-removal.md）で、運勢・
   おみくじ・方位・부적を廃止した。理由は Stripe の審査基準で、
   これらは制限業種にあたる ── **戻ってきた日が、決済が止まる日**。

   このとき運勢を見張っていた関門 8 種も一緒に消した。対象が無い
   関門は必ず緑になるので、残すと「検査があるから守られている」と
   いう誤解だけが残るからだ。その 8 種の跡地に置くのがこれで、
   見るものが逆になっている ── 「正しく動くか」ではなく
   「戻ってきていないか」。

   【この関門が見ない場所と、その理由】
   ・コメント（コード・HTML とも剥がしてから見る）
     ── 「なぜ消したか」は残さないと、次の人が善意で戻す
   ・docs/ ・README.md ・.github/ ・server/db/migrations ・schema.sql
     ── 意思決定の記録と、既に本番に適用済みの履歴。書き換えない
   ・tools/verify-*.mjs
     ── 廃止を見張っている側。禁止語を持っていて当然
   ・識別子（fortune_bridge / saju_profiles / getSajuProfile …）
     ── D4(가)・D5(가) で「列と表は残す」と決めた。見るのは
        利用者に届く**文面**であって、DB の列名ではない
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

let failed = 0, passed = 0;
const check = (label, fn) => {
  try { const d = fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);
const read = (p) => fs.readFileSync(p, "utf8");

/* 利用者に届く言葉だけを見る。DB の列名（fortune_bridge）や表名
   （saju_profiles）は含めない ── そちらは残すと決めている。 */
const BANNED = [
  /사주|운세|부적|점술/,
  /四柱|運勢|占い|お守り|おみくじ|吉方|運気/
];

const stripJs   = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")
                          .replace(/(^|[^:])\/\/.*$/gm, "$1");
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, "");

const hits = (src) => src.split("\n")
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => BANNED.some((re) => re.test(l)))
  .map(([n, l]) => `${n}: ${l.trim().slice(0, 60)}`);


/* ---- 1. 実体が戻っていないか ---------------------------------------- */

head("[不在]  消したものが戻ってくる ── それが再発の経路そのもの");

/* 「本番で消えている」のではなく「リポジトリに無い」を見る。
   PUBLIC は許可リストなので、ファイルが戻れば次に足す人が拾う。 */
const GONE_FILES = [
  // サイト（占いエンジンとページ）
  "saju.js", "fortune.js", "birth.js", "study.js",
  "omikuji.html", "gilbang.html", "amulet.html", "words.html",
  "omikuji.js", "gilbang.js", "amulet.js",
  "solar-terms.json", "new-moons.json",
  // 配信サーバー（node:vm でサイトの 1 部を動かしていた）
  "server/lib/fortune.mjs", "server/lib/fortune-text.mjs",
  // 廃止した関門（対象が無いのに緑になる）
  "tools/verify-saju.mjs", "tools/verify-fortune.mjs", "tools/verify-study.mjs",
  "tools/verify-omikuji.mjs", "tools/verify-gilbang.mjs", "tools/verify-amulet.mjs",
  "tools/verify-birth.mjs", "tools/verify-fortune-server.mjs"
];

check("廃止したファイルが 1 つも戻っていない", () => {
  const back = GONE_FILES.filter((f) => fs.existsSync(f));
  assert(!back.length, `戻っています: ${back.join(" ")}`);
  return `${GONE_FILES.length} ファイルとも不在`;
});


/* ---- 2. 公開ページの本文 -------------------------------------------- */

head("[サイト]  審査は索引ではなくページを見る");

/* privacy.html だけは例外がある。「2026-08-16 に廃止した」と書く項で、
   廃止したものの名前を挙げないと何を廃止したのか伝わらない。
   その 1 段落（class="note" かつ「廃止しました」を含む）だけ剥がして
   から見る ── 例外を丸ごと「privacy は見ない」にすると、
   第2項に運勢の説明が戻っても気づけなくなる。 */
const dropRemovalNote = (s) =>
  s.replace(/<p class="note">[\s\S]*?<\/p>/g, (m) => /廃止しました/.test(m) ? "" : m);

const PUBLIC_HTML = ["index.html", "privacy.html", "contact.html",
                     "tokushoho.html", "tips.html", "404.html"];

check("公開ページの本文に運勢の言葉が 1 つも無い", () => {
  const bad = [];
  for (const f of PUBLIC_HTML) {
    const h = hits(dropRemovalNote(stripHtml(read(f))));
    if (h.length) bad.push(`${f}\n        ${h.join("\n        ")}`);
  }
  assert(!bad.length, bad.join("\n      "));
  return `${PUBLIC_HTML.length} ページ`;
});

check("sitemap.xml と robots.txt に廃止 URL が無い", () => {
  const both = read("sitemap.xml") + read("robots.txt");
  for (const p of ["omikuji", "gilbang", "amulet", "words"]) {
    assert(!both.includes(p), `${p} が残っています`);
  }
  return "4 URL とも不在";
});

check("PUBLIC（配置する許可リスト）に廃止分が無い", () => {
  /* ここが最後の砦。ファイルが戻っても PUBLIC に無ければ配置されず、
     PUBLIC に書き足せば配置される。両方を別々に見る。 */
  const sh = read("tools/build-site.sh");
  const block = sh.slice(sh.indexOf("PUBLIC=("), sh.indexOf(")", sh.indexOf("PUBLIC=(")));
  for (const f of ["omikuji", "gilbang", "amulet", "words", "saju.js",
                   "fortune.js", "study.js", "birth.js",
                   "solar-terms.json", "new-moons.json"]) {
    assert(!block.includes(f), `PUBLIC に ${f} が戻っています`);
  }
  return "10 項目とも不在";
});

check(".htaccess が廃止 URL に 410 を返す（404 ではなく）", () => {
  /* 404 は「今は無い」。クローラーはしばらく取りに来続ける。
     410 は「意図して廃止した」で、再試行が止まる。 */
  const ht = read(".htaccess");
  assert(/RedirectMatch\s+gone\s+\^\/\(omikuji\|gilbang\|amulet\|words\)\$/.test(ht),
    "RedirectMatch gone がありません（消しただけでは 404 になります）");
  return "410 Gone";
});


/* ---- 3. LINE に届く文面 --------------------------------------------- */

head("[配信]  朝夕の便に運勢が混ざっていないか");

/* 利用者の目に入る文字列を作っている場所だけを見る。repo/ や
   migrate.mjs は列名を扱うだけで、文面は持たない。 */
const MESSAGE_SRC = [
  "server/lib/onboarding.mjs", "server/lib/pages.mjs", "server/lib/render.mjs",
  "server/lib/richmenu.mjs", "server/lib/webhook.mjs",
  "server/lib/handlers/checkout.mjs", "server/lib/handlers/follow.mjs",
  "server/lib/handlers/link.mjs", "server/lib/handlers/message.mjs",
  "server/lib/handlers/postback.mjs", "server/lib/handlers/profile.mjs",
  "server/db/push-daily.mjs", "server/db/push-evening.mjs"
];

check("文面を作る 13 ファイルに運勢の言葉が無い", () => {
  const bad = [];
  for (const f of MESSAGE_SRC) {
    const h = hits(stripJs(read(f)));
    if (h.length) bad.push(`${f}\n        ${h.join("\n        ")}`);
  }
  assert(!bad.length, bad.join("\n      "));
  return `${MESSAGE_SRC.length} ファイル`;
});

check("原稿の入稿検査は、運勢の断定を禁じ続けている", () => {
  /* ここだけは禁止語を持っていて正しい ── 原稿に「運がよい」の類いが
     混ざるのを止めている当人だから。消えていたら、原稿から運勢が
     戻る道が開く。無いことではなく**在ること**を見る唯一の項。 */
  const cc = read("server/lib/content-check.mjs");
  assert(/const FORTUNE_ASSERT = /.test(cc), "FORTUNE_ASSERT が消えています");
  assert(/運がよ[\s\S]*?운세가 좋/.test(cc), "禁止パターンが痩せています");
  assert(/운세 단정/.test(cc), "入稿で弾く文言がありません");
  return "FORTUNE_ASSERT 健在";
});


/* ---- 4. CI の配線 ---------------------------------------------------- */

head("[CI]  対象の無い関門を残すと、緑が意味を失う");

check("deploy.yml に廃止した関門のステップが無い", () => {
  const yml = read(".github/workflows/deploy.yml");
  for (const g of ["verify-saju.mjs", "verify-fortune.mjs", "verify-study.mjs",
                   "verify-omikuji.mjs", "verify-gilbang.mjs", "verify-amulet.mjs",
                   "verify-birth.mjs", "verify-fortune-server.mjs"]) {
    assert(!yml.includes(g), `${g} を走らせようとしています（ファイルは無いので必ず落ちます）`);
  }
  return "8 ステップとも不在";
});

check("deploy.yml がこの関門を走らせている", () => {
  /* 自分が呼ばれていないことは、自分では気づけない。 */
  const yml = read(".github/workflows/deploy.yml");
  assert(/node tools\/verify-no-fortune\.mjs/.test(yml),
    "deploy.yml がこの関門を呼んでいません ── 誰も見ていない検査になります");
  return "Verify no-fortune";
});

check(".cpanel.yml が運勢エンジンを配置していない", () => {
  /* サイトの saju.js / fortune.js を $APP/engine/ へ cp していた。
     消えたファイルを cp すると set -e で 12 作業が止まり、
     配信サーバーの配置が丸ごと失敗する。 */
  const cp = read(".cpanel.yml");
  for (const f of ["saju.js", "fortune.js", "solar-terms.json"]) {
    assert(!new RegExp(`cp[^\\n]*${f.replace(".", "\\.")}`).test(cp),
      `${f} を配置しようとしています`);
  }
  return "engine/ の複写なし";
});


console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
