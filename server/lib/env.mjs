/* ==================================================================
   env.mjs — .env を読む。依存は入れない

     import { loadEnv, requireEnv } from './lib/env.mjs';
     loadEnv();                              // server/.env → process.env
     const cfg = requireEnv(['DB_HOST', 'DB_USER']);

   dotenv を入れない理由は、やることが 20 行だから、ではない。
   このファイルが読むのは接続情報と鍵で、渡すべきものが 1 つ欠けたときに
   「何が足りないか」を名前で言えるかどうかが、そのまま初回設置の
   手戻りの量になる。deploy.yml が Secret を 1 つずつ名前で確かめて
   いるのと同じ考えで、そこは自分で持つ。

   本番（cPanel の Node.js アプリ）は環境変数を管理画面から入れるので
   .env は無くてよい。無いこと自体はエラーにしない ── 「無い」と
   「値が足りない」は別で、止めるべきは後者だけ。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* KEY=VALUE を 1 行ずつ。#, 空行, 前後の空白, "..." '...' を扱う。
   export KEY=VALUE も受ける（.env をそのまま source する人がいるため）。 */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    let key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let val = line.slice(eq + 1).trim();

    /* 引用符は外す。ただし引用符の外にある # だけをコメントと見る ──
       鍵に # が入っていることがあり、そこで切ると認証が通らない。
       通らない理由は「鍵が違う」としか出ないので、まず疑えない。 */
    if ((val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
        (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      val = val.slice(1, -1);
    } else {
      const h = val.indexOf(" #");
      if (h >= 0) val = val.slice(0, h).trim();
    }

    out[key] = val;
  }
  return out;
}

/* 既にある環境変数を上書きしない。本番の管理画面で入れた値より
   置き忘れた .env が勝つ、という事故を防ぐ。 */
export function loadEnv(file = path.join(SERVER_DIR, ".env")) {
  if (!fs.existsSync(file)) return {};
  const parsed = parseEnv(fs.readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

/* 足りないものを 1 つずつ名前で出してから止める。
   1 つ目で例外にすると、直して走らせて次で止まる、を繰り返すことになる。 */
export function requireEnv(names, source = process.env) {
  const missing = names.filter((n) => !source[n]);
  if (missing.length) {
    throw new Error(
      "環境変数が足りません:\n" +
      missing.map((n) => `  ・${n}`).join("\n") +
      "\n\nserver/.env.example を server/.env に写して埋めてください。" +
      "\n本番は cPanel → Setup Node.js App → Environment variables に入れます。"
    );
  }
  return Object.fromEntries(names.map((n) => [n, source[n]]));
}
