/* ==================================================================
   richmenu.mjs — 画面の下に常に出ているメニュー

   友だち追加した人が最初に見るのは挨拶の 1 通だけで、そのあとは
   こちらから送るまで何も無い。受講料を見る所も、進み具合を見る所も、
   トーク画面のどこにも無かった ── 「どこから買うのか」が分からない。

   リッチメニューは 1 度登録すれば全員の画面に出続ける。配信でも
   配置でもないので、cron にも .cpanel.yml にも入れない。
   変えるときだけ tools/setup-richmenu.mjs を手で走らせる。

   ┌─────────────┬─────────────┬─────────────┐
   │  講座について │   受講料     │   進み具合   │
   ├─────────────┴─────────────┴─────────────┤
   │              お問い合わせ                 │
   └──────────────────────────────────────────┘

   【画像が要る】
   LINE は「画像 1 枚 ＋ 押せる範囲の座標」でメニューを作る。文字も
   画像の中に描く ── こちらから文字を送る仕組みは無い。

     2500 × 1686 px（この 4 分割の型）／ JPEG か PNG ／ 1MB 以下

   画像は用意してもらう。無いまま登録しようとすると LINE が 400 を
   返すので、tools/setup-richmenu.mjs が先に見て止める。

   【座標の取り方】
   原点は左上。分割の境目を 1px でもずらすと、押しても何も起きない
   帯ができる ── 見た目には出ないので、押した人だけが気づく。
   下の AREAS は 2500×1686 をきっちり割り切っている。
   ================================================================== */
import fs from "node:fs";
import { loadEnv } from "./env.mjs";

const API = () => `${process.env.LINE_API_BASE || "https://api.line.me"}/v2/bot`;
/* 画像だけ宛先が違う。api ではなく api-data。ここを取り違えると
   404 が返るが、原因が URL だとは読み取れない。 */
const DATA_API = () => process.env.LINE_DATA_API_BASE || "https://api-data.line.me/v2/bot";

const W = 2500, H = 1686;
const TOP_H = 1124, BOTTOM_H = H - TOP_H;      // 上段 2/3・下段 1/3
const COL = Math.floor(W / 3);                 // 833
const COL_LAST = W - COL * 2;                  // 834（余りを最後の列へ）

/* 押せる範囲。隙間も重なりも作らない ── 隙間は「押しても何も
   起きない帯」になり、重なりは先に書いたほうが勝つ。 */
export const AREAS = Object.freeze([
  { bounds: { x: 0,        y: 0,     width: COL,      height: TOP_H },
    action: { type: "postback", data: "action=about",  displayText: "講座について" } },
  { bounds: { x: COL,      y: 0,     width: COL,      height: TOP_H },
    action: { type: "postback", data: "action=plans",  displayText: "受講料を見ます" } },
  { bounds: { x: COL * 2,  y: 0,     width: COL_LAST, height: TOP_H },
    action: { type: "postback", data: "action=status", displayText: "進み具合" } },
  { bounds: { x: 0,        y: TOP_H, width: W,        height: BOTTOM_H },
    action: { type: "uri",
              uri: `${process.env.SITE_URL || "https://www.kstudy101.jp"}/contact` } }
]);

export function menuDefinition() {
  return {
    size: { width: W, height: H },
    /* 既定で開いた状態にする。閉じていると、そこにメニューがあること
       自体に気づかない人が出る。 */
    selected: true,
    name: "kstudy101-main",
    /* トーク画面の下に出る文字。押す前に何ができるか分かるようにする。 */
    chatBarText: "メニュー",
    areas: AREAS
  };
}

async function call(url, { method = "POST", body = null, headers = {}, raw = null } = {}) {
  loadEnv();
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE ${res.status} (${url}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export async function createMenu() {
  const r = await call(`${API()}/richmenu`, { body: menuDefinition() });
  if (!r.richMenuId) throw new Error("richMenuId が返りませんでした");
  return r.richMenuId;
}

/* 画像は JSON ではなく生のバイト列で送る。Content-Type を取り違えると
   400 になり、理由は「画像が不正」としか出ない。 */
export async function uploadImage(richMenuId, file) {
  if (!fs.existsSync(file)) throw new Error(`画像がありません: ${file}`);
  const buf = fs.readFileSync(file);
  const type = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  /* LINE の上限は 1MB。超えると 400 だが、原因が大きさだとは出ない。 */
  if (buf.length > 1024 * 1024) {
    throw new Error(`画像が大きすぎます（${Math.round(buf.length / 1024)}KB > 1024KB）`);
  }
  return call(`${DATA_API()}/richmenu/${encodeURIComponent(richMenuId)}/content`, {
    headers: { "Content-Type": type }, raw: buf
  });
}

/* 全員の既定にする。個別に付ける口もあるが、ここは全員同じでよい。 */
export async function setDefault(richMenuId) {
  return call(`${API()}/user/all/richmenu/${encodeURIComponent(richMenuId)}`, { method: "POST" });
}

export async function listMenus() {
  const r = await call(`${API()}/richmenu/list`, { method: "GET" });
  return r.richmenus || [];
}

export async function deleteMenu(richMenuId) {
  return call(`${API()}/richmenu/${encodeURIComponent(richMenuId)}`, { method: "DELETE" });
}

/* 古いものを消してから新しいものを既定にする。消さずに積むと、
   LINE 側の上限（1000 件）に当たるまで増え続け、どれが今のものか
   分からなくなる。

   ★ 順番が要る。新しいものを既定にしてから古いのを消す ── 逆に
   すると、消してから登録するまでのあいだメニューが消える。 */
export async function install(imagePath) {
  const before = await listMenus();
  const id = await createMenu();
  await uploadImage(id, imagePath);
  await setDefault(id);

  const removed = [];
  for (const m of before) {
    try { await deleteMenu(m.richMenuId); removed.push(m.richMenuId); }
    catch { /* 消せなくても新しいほうは既定になっている */ }
  }
  return { richMenuId: id, removed };
}
