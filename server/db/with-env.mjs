/* ==================================================================
   with-env.mjs — cPanel がアプリに渡している環境で、db/ の道具を走らせる

     node db/with-env.mjs db/migrate.mjs
     node db/with-env.mjs db/smoke.mjs

   なぜ要るか。

   本番の接続情報は cPanel → Setup Node.js App → Environment variables
   に入れてある。ただしそれを渡すのは Passenger で、アプリを起動する
   ときだけ。Git の配置手順（.cpanel.yml）は Passenger を通らない
   別の入り口なので、そこから migrate を呼んでも DB_PASSWORD が無い。

   逃げ道は 2 つあった。

     (あ) server/.env にも同じ値を書く
     (い) cPanel が持っている値を読んで渡す

   (あ) は同じ秘密が 2 か所になる。片方だけ直した日に、画面から見える
   設定と実際に使われる値が食い違い、しかもどちらも「正しく見える」。
   (い) にした。真実は cPanel の管理画面ひとつ。

   CloudLinux の Node.js Selector は ~/.cl.selector/node-selector.json に
   アプリごとの設定を持っている。読むのはそこ。既にある環境変数は
   上書きしない ── lib/env.mjs と同じ向きに揃えてある。
   ================================================================== */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP = process.env.CL_APP_ROOT || "kstudy101-line";
const CFG = path.join(homedir(), ".cl.selector", "node-selector.json");

const target = process.argv[2];
if (!target) {
  console.error("使い方: node db/with-env.mjs <走らせるファイル>");
  process.exit(1);
}

let vars = {};
try {
  const cfg = JSON.parse(readFileSync(CFG, "utf8"));
  vars = cfg?.[APP]?.env_vars ?? {};
} catch (e) {
  console.error(`[with-env] ${CFG} を読めません: ${e.message}`);
  console.error("  cPanel → Setup Node.js App でアプリが作られているか確認してください。");
  process.exit(1);
}

const names = Object.keys(vars);
if (!names.length) {
  console.error("[with-env] 環境変数が 1 つも設定されていません。");
  console.error("  cPanel → Setup Node.js App → Environment variables に入れてください。");
  process.exit(1);
}

/* 名前だけ出す。値は出さない ── ここに出したものは配置ログに残り、
   配置ログは cPanel の画面から誰でも読める。 */
for (const [k, v] of Object.entries(vars)) {
  if (process.env[k] === undefined) process.env[k] = String(v);
}
console.log(`[with-env] 渡した設定: ${names.sort().join(", ")}`);

/* 呼ばれる側から見て、自分が直接呼ばれたのと同じ形にしてから渡す。

   直さないと argv はこうなっている:
     [0] node  [1] db/with-env.mjs  [2] db/seed-content.mjs  [3..] 本来の引数

   seed-content.mjs は argv.slice(2) を「読む原稿」と見るので、
   自分自身のファイル名を原稿として読み、JSON ではないと言って
   落ちる。実際そうなった。
   引数を取らない migrate.mjs では起きないので、道具が増えるまで
   気づけない類い。 */
const resolved = path.resolve(target);
process.argv = [process.argv[0], resolved, ...process.argv.slice(3)];

await import(pathToFileURL(resolved).href);
