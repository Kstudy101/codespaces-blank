#!/usr/bin/env node
/* ==================================================================
   setup-richmenu.mjs — リッチメニューを 1 度だけ登録する

     node tools/setup-richmenu.mjs --image=menu.png
     node tools/setup-richmenu.mjs --list          いま何が登録されているか
     node tools/setup-richmenu.mjs --disable       既定を外して定義も消す（一旦オフ）
     node tools/setup-richmenu.mjs --dry-run       送らずに中身だけ見る

   本番では cron からも配置手順からも呼ばない。メニューは 1 度
   登録すれば出続けるもので、配置のたびに作り直すと LINE 側に
   古いものが積み上がる。変えるときだけ手で走らせる。

   画像はこちらで作れない。無ければここで止める ── 無いまま
   登録しようとすると LINE が 400 を返し、理由は「画像が不正」と
   しか出ないので、原因が「まだ用意していない」だとは読めない。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../server/lib/env.mjs";
import { menuDefinition, AREAS, install, listMenus, deactivate, getDefaultId }
  from "../server/lib/richmenu.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(ROOT, "server", ".env"));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const DRY = flag("dry-run");
const IMAGE = value("image",
  process.env.RICHMENU_IMAGE || path.join(ROOT, "server", "assets", "richmenu.jpg"));

/* ---- いま何が登録されているか ---------------------------------------- */
if (flag("list")) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("✗ LINE_CHANNEL_ACCESS_TOKEN がありません");
    process.exit(1);
  }
  const defId = await getDefaultId();
  console.log(`既定: ${defId || "（なし）"}`);
  const menus = await listMenus();
  if (!menus.length) console.log("登録されているリッチメニューはありません");
  for (const m of menus) {
    const mark = m.richMenuId === defId ? " ★既定" : "";
    console.log(`  ${m.richMenuId}  ${m.name}  ${m.size.width}×${m.size.height}`
      + `  領域 ${m.areas.length}${mark}`);
  }
  process.exit(0);
}

/* ---- 一旦オフ（既定解除＋定義削除）-------------------------------- */
if (flag("disable")) {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error("✗ LINE_CHANNEL_ACCESS_TOKEN がありません");
    process.exit(1);
  }
  if (DRY) {
    console.log("--dry-run: 既定を外し、定義も消す予定です");
    process.exit(0);
  }
  try {
    const r = await deactivate();
    console.log("✓ リッチメニューを非表示にしました");
    console.log(`  直前の既定: ${r.previousDefault || "（なし）"}`);
    if (r.removed.length) console.log(`  削除した定義: ${r.removed.length} 件`);
    console.log("  トークを開き直すと下のメニューが消えます");
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

/* ---- 中身の下見 ------------------------------------------------------ */
const def = menuDefinition();
console.log(`リッチメニュー「${def.name}」 ${def.size.width}×${def.size.height}`);
for (const a of AREAS) {
  const what = a.action.type === "uri" ? a.action.uri : a.action.data;
  console.log(`  (${String(a.bounds.x).padStart(4)}, ${String(a.bounds.y).padStart(4)})`
    + ` ${String(a.bounds.width).padStart(4)}×${String(a.bounds.height).padStart(4)}`
    + `  ${what}`);
}

/* 隙間や重なりが無いか。1px でもずれると、押しても何も起きない帯が
   できる ── 見た目には出ないので、押した人だけが気づく。 */
const covered = AREAS.reduce((s, a) => s + a.bounds.width * a.bounds.height, 0);
const total = def.size.width * def.size.height;
if (covered !== total) {
  console.error(`\n✗ 領域の合計が画面と合いません（${covered} ≠ ${total}）`);
  console.error("  差のぶんは「押しても何も起きない帯」になります。");
  process.exit(1);
}
console.log(`  ✓ 4 領域で画面をちょうど覆っています`);

if (DRY) { console.log("\n--dry-run なので、ここで終わります"); process.exit(0); }

/* ---- 画像 ------------------------------------------------------------ */
if (!IMAGE) {
  console.error("\n✗ 画像を指定してください: --image=<ファイル>");
  console.error(`  ${def.size.width}×${def.size.height} px / JPEG か PNG / 1MB 以下`);
  console.error("  上の 4 領域に合わせて、文字も画像の中に描いてください");
  console.error("  （LINE には文字だけを送る仕組みがありません）");
  process.exit(1);
}
if (!fs.existsSync(IMAGE)) {
  console.error(`\n✗ 画像が見つかりません: ${IMAGE}`);
  process.exit(1);
}

if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("\n✗ LINE_CHANNEL_ACCESS_TOKEN がありません（server/.env か環境変数）");
  process.exit(1);
}

/* ---- 登録 ------------------------------------------------------------ */
try {
  const r = await install(IMAGE);
  console.log(`\n✓ 登録して既定にしました: ${r.richMenuId}`);
  if (r.removed.length) console.log(`  古いもの ${r.removed.length} 件を削除しました`);
  console.log("\n  トーク画面を開き直すと出ます（既に開いている人は少し遅れます）");
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
