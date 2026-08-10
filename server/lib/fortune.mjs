/* ==================================================================
   lib/fortune.mjs — サイトと同じ運勢を、サーバーでも出す

   この講座は「自分の四柱で韓国語を学ぶ」ものなので、毎朝の便に
   その日の運勢が付く。計算はサイト本体（saju.js / fortune.js）が
   すでに持っていて、国立天文台の暦と 366 人 × 120 日の標本で
   検証も済んでいる。作り直さない。

   【写しを置かない】
   server/ の中に saju.js / fortune.js を複製しない。複製すると
   ウェブと LINE の運勢が食い違うが、食い違ったことに気づく手が無い
   ── どちらも「それらしい数字」を出すので、並べて見るまで分からない。
   ましてや利用者にとっては「昨日サイトで大吉だったのに今朝は小吉」で、
   そこで信用が終わる。

   実体はリポジトリに 1 部だけ置き、配置のときに $APP/engine/ へ
   写す（.cpanel.yml）。ここはそれを読むだけ。

   【ブラウザ向けのファイルをそのまま読む】
   どちらも globalThis に付ける書き方なので、node:vm に通せば
   そのまま動く。DOM は 1 か所も見ていない。ESM に書き換えると
   サイト側と別物になり、上の「写しを置かない」が崩れる。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 本番は $APP/engine/、手元はリポジトリの根。
   探す順を固定しておくと、手元で確かめたものがそのまま本番になる。 */
const CANDIDATES = [
  path.join(SERVER_DIR, "engine"),
  path.resolve(SERVER_DIR, "..")
];

let engine = null;

function load() {
  if (engine) return engine;

  const dir = CANDIDATES.find((d) =>
    ["saju.js", "fortune.js", "solar-terms.json"].every((f) => fs.existsSync(path.join(d, f))));

  if (!dir) {
    throw new Error(
      "運勢エンジンが見つかりません。探した場所:\n" +
      CANDIDATES.map((d) => `  ・${d}`).join("\n") +
      "\n本番では .cpanel.yml が engine/ へ写します。");
  }

  /* console だけ渡す。ファイル読み込みもネットワークも要らない
     ── 要るようになったら、それはサイト側が壊れている。 */
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["saju.js", "fortune.js"]) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
  }
  ctx.Saju.load(JSON.parse(fs.readFileSync(path.join(dir, "solar-terms.json"), "utf8")));

  engine = { Saju: ctx.Saju, Fortune: ctx.Fortune, dir };
  return engine;
}

export function engineDir() { return load().dir; }
export function categories() { return load().Fortune.CATS; }

/* ---- その人の、その日の運勢 ---------------------------------------
   サイトと同じ引数で呼ぶ（index.html の 3199〜3200 行）:

     自分  … 生年月日 + 生まれた時刻 + 出生地
     今日  … 今日の日付 + hour 12 + 「出生地と同じ都市」

   最後のところを取り違えやすい。今日の柱をソウル固定にすると、
   東京生まれの人だけ結果がずれる。ずれても数字は出るので気づけない。

   時刻が分からない人は hour を null で渡す。サイトも同じ扱い。 */
export function fortuneFor(user, dateStr) {
  const { Saju, Fortune } = load();

  const birth = user?.birth_date ? String(user.birth_date).slice(0, 10) : null;
  if (!birth) return null;                       /* 四柱が無い人には出さない */

  const raw = user?.raw_result_json && typeof user.raw_result_json === "object"
    ? user.raw_result_json : {};
  const city = raw.city || "tokyo";

  const [by, bm, bd] = birth.split("-").map(Number);
  const bh = user.birth_time ? Number(String(user.birth_time).slice(0, 2)) : null;

  const [ty, tm, td] = String(dateStr).slice(0, 10).split("-").map(Number);
  if (!ty || !tm || !td) throw new Error(`日付が読めません: ${dateStr}`);

  const mine  = Saju.pillars({ y: by, m: bm, d: bd, hour: bh, city });
  const today = Saju.pillars({ y: ty, m: tm, d: td, hour: 12, city });

  const r = Fortune.of(mine, today);
  return { ...r, cats: Fortune.CATS, date: `${ty}-${String(tm).padStart(2,"0")}-${String(td).padStart(2,"0")}` };
}
