/* ==================================================================
   seed-content.mjs — 原稿を content_templates へ入れる

     node db/seed-content.mjs                     content/ 全部
     node db/seed-content.mjs content/semester-1.json
     node db/seed-content.mjs --check             入れずに検査だけ
     node db/seed-content.mjs --track=intermediate  コースを指定して入れる
     node db/with-env.mjs db/seed-content.mjs     ChemiCloud ではこちら

   【どのコースに入るか】
   コースは 3 本あり（初級・中級・上級）、それぞれ別の 101 日。
   どこへ入れるかは次の順で決まる。

     1  --track=…            全ファイルに効く
     2  ファイルの "track"   そのファイルだけ
     3  beginner             どちらも無いとき

   3 を既定にしてあるのは、migrations/001 が既存の 50 行に入れる値と
   同じだから ── 揃えておかないと、書いた人が同じつもりで流した
   ものが別のコースに入る。どこへ入れたかは 1 ファイルずつ表示する。

   SQL の INSERT を手で書かない。原稿は人が何度も直すもので、
   直すたびに SQL を書き換えるのは間違えやすい。JSON に置いて、
   入れるところは 1 か所にする。upsertTemplate は
   ON DUPLICATE KEY UPDATE なので、何度流しても同じ結果になる。

   【入れる前に全部見る】
   1 日ぶんずつ検査して入れる、はしない。20 日目で落ちると
   1〜19 日目だけ入った半端な状態が残り、次に流すときに
   どこから直すのかが分からなくなる。全部通ってから、入れる。

   【★ 入稿前の検査は 2 段（2026-08-07 대표 확정）】
   新しい束を入れる前に --check を 2 回。どちらも 1 文字も書かない。

     ① node db/seed-content.mjs --check content/beginner-51-60.json
        その束だけを見る。形・差し込み口・クイズの添字。

     ② node db/seed-content.mjs --check          （ファイルを渡さない）
        content/ を全部読んで**まとめて**見る。①では見えないものが出る:
          ・既に入っている 1〜50 日目と同じ grammar_point
          ・コース内での日番号の重複

   ②が要るのは、重複の検査が「その実行に渡された日」の中でしか
   働かないため（content-check の checkAll）。①はファイルを名指しする
   ので、既に在る日は比較の対象に入らない ── 40 日目と同じ文法を
   57 日目にもう一度置いても、①は何も言わない。

   ①が 0 件でも、②が 0 件でなければ入れないこと。
   ②は npm run seed:check（引数なし）と同じもの。

   検査の中身は lib/content-check.mjs にある。原稿そのものは
   公開リポジトリに置いていないが、受け入れ条件は置いてある。
   ================================================================== */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool, closePool } from "../lib/db.mjs";
import { learning } from "../lib/repo/index.mjs";
import { checkAll, checkManuscriptBytes } from "../lib/content-check.mjs";

const SERVER_DIR  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = path.join(SERVER_DIR, "content");

const argv  = process.argv.slice(2);
const CHECK = argv.includes("--check");
const files = argv.filter((a) => !a.startsWith("--"));

const trackArg = (argv.find((a) => a.startsWith("--track=")) || "").slice(8) || null;
if (trackArg && !learning.isTrack(trackArg)) {
  console.error(`✗ --track は ${learning.TRACKS.join(" / ")} のどれかです: ${trackArg}`);
  process.exit(1);
}

/* ---- 原稿を読む --------------------------------------------------- */
function load() {
  /* 明示的に渡されたか、content/ を漁ったか。漁ったときだけ
     「原稿ではない JSON」を黙って飛ばす ── content/ には運勢の
     文面（fortune-lines.json）も置いてあり、これは 101 日の原稿では
     ない。名前で決め打ちにしないのは、置くものが増えるたびに
     ここへ書き足すことになるため。形で見る。

     渡されたものは飛ばさない。指定して入らなかったのに
     成功と言われるのが、いちばん困る。 */
  const scanned = !files.length;

  let list = files.map((f) => path.resolve(f));
  if (!list.length) {
    if (!existsSync(CONTENT_DIR)) {
      /* 配備（.cpanel.yml）は content/ の有無でこちらを呼ばない。
         手で --check したときにだけここに来る。 */
      console.error(`✗ ${CONTENT_DIR} がありません。`);
      console.error("  原稿は公開リポジトリに置いていないので、別に用意してください。");
      process.exit(1);
    }
    list = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".json"))
      .sort().map((f) => path.join(CONTENT_DIR, f));
  }
  /* 指示書⑮ §4-3: ファイル 0 件は配備失敗にしない（新規・コードだけの配備）。
     漁ったときだけ 0 で終わる。名指しで渡したのに 0 なら失敗のまま。 */
  if (!list.length) {
    if (scanned) {
      console.log("  原稿 JSON がありません — シードを飛ばします");
      return null;
    }
    console.error("✗ 読める原稿がありません");
    process.exit(1);
  }

  const days = [];
  for (const f of list) {
    const label = path.basename(f);
    const buf = readFileSync(f);
    let parsed;
    try {
      /* まず UTF-8 / mojibake だけ（本文は出さない）。原稿判定のあとで
         ハングル・日本語の実在も見る（指示書⑮ §7）。 */
      const encLight = checkManuscriptBytes(buf, label, { requireScripts: false });
      if (encLight.length) {
        console.error(`✗ ${encLight.length} 件（バイト検査）。1 件も入れていません。\n`);
        for (const p of encLight) console.error(`  ・${p}`);
        process.exit(1);
      }
      parsed = JSON.parse(buf.toString("utf8"));
    } catch (e) {
      console.error(`✗ ${label} が JSON として読めません: ${e.message}`);
      process.exit(1);
    }
    const got = Array.isArray(parsed) ? parsed : parsed.days;
    if (!Array.isArray(got)) {
      if (scanned) { console.log(`  ${label} — 原稿ではないので飛ばします`); continue; }
      console.error(`✗ ${label}: days が配列ではありません`);
      process.exit(1);
    }
    const encFull = checkManuscriptBytes(buf, label, { requireScripts: true });
    if (encFull.length) {
      console.error(`✗ ${encFull.length} 件（バイト検査）。1 件も入れていません。\n`);
      for (const p of encFull) console.error(`  ・${p}`);
      process.exit(1);
    }

    /* コースは --track > ファイルの track > beginner。
       ファイルに書いてあるのに読めない値なら止める ── 既定へ
       落とすと、中級のつもりで書いたものが初級を上書きする。 */
    const fileTrack = Array.isArray(parsed) ? null : parsed.track || null;
    if (fileTrack && !learning.isTrack(fileTrack)) {
      console.error(`✗ ${path.basename(f)}: track が読めません: ${fileTrack}`);
      process.exit(1);
    }
    const track = trackArg || fileTrack || "beginner";

    console.log(`  ${path.basename(f)} — ${got.length} 日ぶん → ${track}`);
    days.push(...got.map((d) => ({ ...d, __track: track })));
  }
  return days;
}

console.log("原稿を読みます");
const days = load();
if (days === null) {
  /* content/ はあるが JSON が無い。配備は成功扱い（§4-3）。 */
  process.exit(0);
}

/* ---- 検査。ここを通らなければ 1 件も入れない --------------------- */
console.log("\n検査します");
const { ok, problems, count } = checkAll(days);
if (!ok) {
  /* 失敗報告は日番号と事由まで。原稿本文は出さない（指示書⑮ §4-4）。 */
  console.error(`✗ ${problems.length} 件あります。1 件も入れていません。\n`);
  for (const p of problems) console.error(`  ・${p}`);
  process.exit(1);
}
console.log(`  ✓ ${count} 日ぶん、問題なし`);

/* ---- クイズの答え合わせ（目視用、docs/plan-quiz.md）----------------
   answer は 0 始まりの添字で、人が原稿を書くと 0/1 の取り違えが
   必ず起きる。形の検査（content-check）は「範囲内か」までしか
   見られない ── 2 番のつもりで answer:2 と書いて 3 番目が正解に
   なっている、は機械には正しく見える。

   だから添字を**解いた文字列**で並べる。ここを読む人間が
   最後の関門になる ── 復習クイズは無保存（決定B）で、配信後に
   間違いへ気づく計測が無いので、入れる前のこの目視が唯一の門。

   これは検収用の stdout であって、クイズの**応答**の記録ではない。
   無保存の原則(B)にはかからない。 */
const withQuiz = days.filter((d) => d.quiz);
if (withQuiz.length) {
  console.log(`\nクイズの答え合わせ（${withQuiz.length} 問 ── 添字を解いた文字列で確かめてください）`);
  for (const d of withQuiz) {
    const q = d.quiz;
    const resolved = Array.isArray(q.choices) ? q.choices[q.answer] : undefined;
    console.log(`  [${d.__track} day ${d.day_number}] ${q.question} → answer:${q.answer} = 「${resolved}」`);
  }
}

if (CHECK) { console.log("\n--check なので、ここで終わります"); process.exit(0); }

/* ---- 入れる ------------------------------------------------------- */
const pool = await getPool();
/* 指示書⑮ §3: quiz 無し再入稿で既存クイズを消さない。何件守ったかを
   黙らず出す ── 静かに消えるのが事故の本質だった。 */
const hadQuiz = await learning.listQuizKeys(pool);
let preserved = 0;
let done = 0;
for (const d of days) {
  const incoming = d.quiz ?? null;
  const key = `${d.__track}:${d.day_number}`;
  if (incoming == null && hadQuiz.has(key)) preserved++;

  await learning.upsertTemplate(pool, {
    track:            d.__track,
    dayNumber:        d.day_number,
    grammarPoint:     d.grammar_point,
    grammarTipKr:     d.grammar_tip_kr,
    dialogueTemplate: d.dialogue_template,
    vocab3:           d.vocab_3,
    fortuneBridge:    d.fortune_bridge ?? null,
    /* semester は渡さない。upsertTemplate が day_number から決める ──
       原稿にも書くと、学期の切れ目が 2 か所に生まれる。 */
    requiresNameSlot: !!d.requires_name_slot,
    /* 復習クイズ（任意、003）。形は content-check が入稿前に全部見る。
       null のとき upsert は既存 quiz を触らない（IF … IS NULL）。 */
    quiz:             incoming
  });
  done++;
}
console.log(`\n✓ ${done} 日ぶん入れました`);
if (preserved > 0) {
  console.log(`  既存のクイズ ${preserved} 件を保全しました（原稿に quiz が無かった日）`);
}

/* ---- 残りを数える -------------------------------------------------
   コース別に出す。合計で数えると、初級 101 日だけ揃った状態が
   「303 日中 101 日」に見えて、中級を選んだ人には 1 日目すら
   無いことが読み取れない。 */
const missing = await learning.findMissingTemplateDays(pool);
for (const track of learning.TRACKS) {
  const days = missing[track];
  if (!days.length) { console.log(`  ${track}: 101 日ぶん、すべて揃っています`); continue; }

  /* 連番はまとめて出す。「31,32,33,…,101」を全部並べても読めない。 */
  const ranges = [];
  for (const n of days) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const shown = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}〜${b}`)).join(", ");
  console.log(`  ${track}: 未入稿 ${days.length} 日 — ${shown}`);
}

await closePool();
