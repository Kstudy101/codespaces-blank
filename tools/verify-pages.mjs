#!/usr/bin/env node
/* ==================================================================
   verify-pages.mjs — ページの構造・メタ・リンク

     使い方:  node tools/verify-pages.mjs

   計画書 §9 が「ページ構造・リンク・メタ」を jsdom で見る予定にしていた
   ぶん。jsdom はこの저장소に無い（package.json 自体が無い）ので、
   正規表現で見る。HTML の完全な解析はしないが、ここで見たいのは
   「書き忘れ」と「片方だけ直した」であって構文解析ではない。

   他の 6 つの関門が「計算が合っているか」を見るのに対し、こちらは
   9 ページを横に並べて食い違いを探す。ページが増えるほど、増えた 1 枚
   だけ何かが抜ける確率が上がる ── 実際に見つかったもの:

     ・index.html の <label> 7 個に for が無く、読み上げに繋がっていなかった
       （後から作った gilbang / amulet では付いていた）

   ページを足したら EXPECT に 1 行足すこと。足し忘れると
   「知らないページがある」で落ちる ── 黙って検査対象から漏れるより良い。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

/* 各ページに何を期待するか。noindex と広告の有無はページごとに違うので、
   ここに意図として書いておく ── 「たまたまそうなっている」と
   「そうしたいからそうなっている」を区別するため。 */
const EXPECT = {
  "index.html":   { url: "/",         index: true,  ads: true  },
  "privacy.html": { url: "/privacy",  index: true,  ads: true  },
  "contact.html": { url: "/contact",  index: true,  ads: true  },
  "tokushoho.html": { url: "/tokushoho", index: true, ads: true },
  "tips.html":    { url: "/tips",     index: true,  ads: true  },
  "omikuji.html": { url: "/omikuji",  index: true,  ads: true  },
  "gilbang.html": { url: "/gilbang",  index: true,  ads: true  },
  "amulet.html":  { url: "/amulet",   index: true,  ads: true  },
  // 端末ごとの一覧なので、クローラーには常に空に見える。載せない。
  "words.html":   { url: "/words",    index: false, ads: true  },
  // エラーページ。canonical も広告も持たせない。
  "404.html":     { url: null,        index: false, ads: false }
};

let failed = 0, passed = 0;
/* 同期 check に async の検査を渡すと、失敗しても緑になる ── 実際に
   verify-onboarding で 1 件起きた（2026-08-06 指示書 §1）。Promise が
   返ってきた時点で検査そのものを失敗させる。async は acheck へ。 */
const guardSync = (d, label) => {
  if (d && typeof d.then === "function") {
    throw new Error("async の検査を同期 check に渡しています（acheck を使うこと）");
  }
};
const check = (label, fn) => {
  try { const d = fn(); guardSync(d, label); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);

const src = {};
for (const f of Object.keys(EXPECT)) {
  assert(fs.existsSync(f), `${f} がありません`);
  src[f] = fs.readFileSync(f, "utf8");
}
const pages = Object.keys(EXPECT);
const one = (s, re) => { const m = re.exec(s); return m ? m[1].trim() : null; };

/* ---- 1. 一覧の取りこぼし -------------------------------------------- */

head("[一覧]  ページを足したのに検査対象に入っていない、を防ぐ");

check("リポジトリの .html が EXPECT と一致する", () => {
  const onDisk = fs.readdirSync(".").filter(f => f.endsWith(".html")).sort();
  const listed = pages.slice().sort();
  const missing = onDisk.filter(f => !listed.includes(f));
  const extra   = listed.filter(f => !onDisk.includes(f));
  assert(!missing.length, `EXPECT に無いページ: ${missing.join(" ")}（この表に足してください）`);
  assert(!extra.length,   `EXPECT にあるのに実体が無い: ${extra.join(" ")}`);
  return `${onDisk.length} ページ`;
});

/* ---- 2. メタ -------------------------------------------------------- */

head("[メタ]  9 ページを横に並べて、1 枚だけ抜けているものを探す");

check("title・description・lang・viewport がすべてある", () => {
  const bad = [];
  for (const p of pages) {
    const s = src[p];
    if (!one(s, /<title>(.*?)<\/title>/s))                          bad.push(`${p}: title`);
    if (!one(s, /<meta name="description" content="(.*?)"/s))        bad.push(`${p}: description`);
    if (one(s, /<html lang="(.*?)"/) !== "ja")                       bad.push(`${p}: lang`);
    if (!/<meta name="viewport"/.test(s))                            bad.push(`${p}: viewport`);
  }
  assert(!bad.length, bad.join(" / "));
  return `${pages.length} ページ`;
});

check("canonical がファイル名と一致し、og:url と揃っている", () => {
  const bad = [];
  for (const p of pages) {
    const s = src[p], want = EXPECT[p].url;
    const canon = one(s, /<link rel="canonical" href="(.*?)"/);
    const ogurl = one(s, /<meta property="og:url" content="(.*?)"/);
    if (want === null) {
      // 404 に canonical を付けると「このURLが正」と言うことになる
      if (canon) bad.push(`${p}: canonical があります（${canon}）`);
      continue;
    }
    if (!canon) { bad.push(`${p}: canonical がありません`); continue; }
    const host = /^https:\/\/([^/]+)/.exec(canon);
    if (!host) { bad.push(`${p}: canonical が絶対URLではありません`); continue; }
    const expect = `https://${host[1]}${want}`;
    if (canon !== expect) bad.push(`${p}: canonical が ${canon}（${expect} のはず）`);
    if (ogurl !== canon)  bad.push(`${p}: og:url が canonical と違います（${ogurl}）`);
  }
  assert(!bad.length, bad.join(" / "));
  return "canonical == og:url == ファイル名";
});

check("すべての canonical が同じホストを指す", () => {
  // 一括置換で 1 枚だけ取りこぼす、が起きる。build-site.sh も別角度で見ている。
  const hosts = new Set();
  for (const p of pages) {
    const c = one(src[p], /<link rel="canonical" href="https:\/\/([^/"]+)/);
    if (c) hosts.add(c);
  }
  assert(hosts.size === 1, `ホストが ${hosts.size} 種類あります: ${[...hosts].join(" ")}`);
  return [...hosts][0];
});

check("title と description がページごとに違う", () => {
  // 同じ文言が並ぶと検索結果でどれを出すか決められなくなる。
  for (const key of ["title", "desc"]) {
    const seen = {};
    for (const p of pages) {
      const v = key === "title"
        ? one(src[p], /<title>(.*?)<\/title>/s)
        : one(src[p], /<meta name="description" content="(.*?)"/s);
      if (!v) continue;
      (seen[v] = seen[v] || []).push(p);
    }
    for (const v in seen)
      assert(seen[v].length === 1, `${key} が重複: ${seen[v].join(" / ")}`);
  }
  return "重複なし";
});

check("OG と Twitter の画像・題名がそろっている", () => {
  const bad = [];
  for (const p of pages) {
    if (EXPECT[p].url === null) continue;             // 404 は共有されない
    for (const [name, re] of [
      ["og:title",       /<meta property="og:title"/],
      ["og:description", /<meta property="og:description"/],
      ["og:image",       /<meta property="og:image"/],
      ["twitter:card",   /<meta name="twitter:card"/],
      ["twitter:image",  /<meta name="twitter:image"/]
    ]) if (!re.test(src[p])) bad.push(`${p}: ${name}`);
  }
  assert(!bad.length, bad.join(" / "));
  return "og:title / og:description / og:image / twitter:card / twitter:image";
});

check("noindex が意図どおりのページにだけ付いている", () => {
  const bad = [];
  for (const p of pages) {
    const robots = one(src[p], /<meta name="robots" content="(.*?)"/) || "";
    const noindex = /noindex/.test(robots);
    if (noindex !== !EXPECT[p].index)
      bad.push(`${p}: robots="${robots}"（${EXPECT[p].index ? "索引させたい" : "noindex のはず"}）`);
  }
  assert(!bad.length, bad.join(" / "));
  return "words・404 のみ noindex";
});

check("広告と計測が意図どおりのページに入っている", () => {
  const bad = [];
  for (const p of pages) {
    const want = EXPECT[p].ads;
    const has = /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/.test(src[p]);
    if (has !== want) bad.push(`${p}: AdSense が ${has ? "あります" : "ありません"}`);
    // GA と Clarity は 404 にも入れている（どこで落ちたか知りたいので）
    if (!/www\.googletagmanager\.com\/gtag\/js/.test(src[p])) bad.push(`${p}: GA4`);
    if (!/clarity\.ms\/tag\//.test(src[p]))                   bad.push(`${p}: Clarity`);
  }
  assert(!bad.length, bad.join(" / "));
  return "AdSense は 404 以外 / GA4・Clarity は全ページ";
});

/* ---- 3. リンク ------------------------------------------------------ */

head("[リンク]  行き先の無いリンクは、押した人にしか分からない");

check("ページ内アンカー（#foo）の行き先がある", () => {
  const bad = [];
  for (const p of pages) {
    const ids = new Set([...src[p].matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    for (const m of src[p].matchAll(/href="#([^"]+)"/g))
      if (!ids.has(m[1])) bad.push(`${p}: #${m[1]}`);
  }
  assert(!bad.length, bad.join(" / "));
  return "すべて存在";
});

check("サイト内リンク（/foo）の実体がある", () => {
  const bad = [];
  for (const p of pages) {
    for (const m of src[p].matchAll(/href="\/([a-z0-9-]*)"/g)) {
      const t = m[1] === "" ? "index" : m[1];
      if (!fs.existsSync(`${t}.html`)) bad.push(`${p}: /${m[1]}`);
    }
  }
  assert(!bad.length, bad.join(" / "));
  return "すべて存在";
});

/* ---- 4. 読み上げ ---------------------------------------------------- */

head("[読み上げ]  見えている文字と、機械に渡る文字は別");

check("入力欄に label が結びついている", () => {
  // 見た目の label があっても for が無ければ、読み上げには何も渡らない。
  // label を押しても入力欄に移らないので、指で使う人にも影響する。
  const bad = [];
  for (const p of pages) {
    const s = src[p];
    const fors = new Set([...s.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(m => m[1]));
    // <label>…<input>…</label> の入れ子も正しい結びつけ方なので、その範囲を拾う
    const wrapped = [...s.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)]
      .map(m => [m.index, m.index + m[0].length]);
    for (const m of s.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = m[2];
      if (/type="hidden"/.test(attrs)) continue;
      if (/aria-label/.test(attrs)) continue;
      if (wrapped.some(([a, b]) => m.index > a && m.index < b)) continue;
      const id = /\bid="([^"]+)"/.exec(attrs);
      if (!id) { bad.push(`${p}: <${m[1]}> に id がありません`); continue; }
      if (!fors.has(id[1])) bad.push(`${p}: #${id[1]}`);
    }
  }
  assert(!bad.length, bad.join(" / "));
  return "すべて結びつけ済み";
});

check("ボタンに読み上げられる名前がある", () => {
  const bad = [];
  for (const p of pages)
    for (const m of src[p].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      if (/aria-label/.test(m[1])) continue;
      const text = m[2].replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
      if (!text) bad.push(`${p}: <button${m[1].slice(0, 40)}>`);
    }
  assert(!bad.length, bad.join(" / "));
  return "すべて名前あり";
});

check("img に alt がある", () => {
  const bad = [];
  for (const p of pages)
    for (const m of src[p].matchAll(/<img\b([^>]*)>/g))
      if (!/\balt=/.test(m[1])) bad.push(`${p}: <img${m[1].slice(0, 40)}>`);
  assert(!bad.length, bad.join(" / "));
  return "すべて alt あり";
});

check("id が 1 ページに 2 つ以上ない", () => {
  // 重複していると getElementById が先頭しか返さず、後ろは動かない。
  const bad = [];
  for (const p of pages) {
    const ids = [...src[p].matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    const dup = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
    if (dup.length) bad.push(`${p}: ${dup.join(" ")}`);
  }
  assert(!bad.length, bad.join(" / "));
  return "重複なし";
});

check("サイドメニュー関連サイト — 見出し・引き出し・開閉配列の 3 点（지시서㉒ §1-2）", () => {
  /* 開閉は sideSecs 配列が回している。ボタンだけ足して配列に足し忘れると、
     見出しは出るのに押しても開かない ── 「押しても何も起きない」は、
     見た目が完成しているぶん一番気づきにくい壊れ方。3 点を一緒に見る。 */
  const s = src["index.html"];
  assert(/id="side-tog-related"/.test(s), "見出しボタン #side-tog-related がありません");
  assert(/id="side-related"/.test(s), "引き出し #side-related がありません");
  assert(/\{ btn: \$\('side-tog-related'\), list: \$\('side-related'\) \}/.test(s),
    "sideSecs 配列に関連サイトがありません ── 見出しは出るのに開きません");
  return "見出し・引き出し・配列";
});

check("関連サイトは詳細窓を挟む — 引き出しから直に外へ出さない（代表指示 2026-08-09）", () => {
  /* 引き出しの中に外部リンクを戻すと、詳細を読ませてから出すという
     構造そのものが消える。見た目は同じように動くので、並べないと
     気づけない ── ここで固定する。 */
  const m = /<nav class="side-list" id="side-related"[^>]*>([\s\S]*?)<\/nav>/.exec(src["index.html"]);
  assert(m, "引き出し #side-related がありません");
  assert(!/href="https?:/.test(m[1]),
    "引き出しの中に外部リンクが直に置かれています ── 詳細窓を挟む構造が崩れています");
  assert(/id="rel-open-sinokubo"/.test(m[1]), "詳細窓を開くボタンがありません");
  assert(/新大久保グルメ/.test(m[1]), "表示名「新大久保グルメ」がありません");
  return "名前だけ → 詳細窓";
});

check("詳細窓に URL と説明があり、別タブ + rel=noopener で開く", () => {
  /* サイトで唯一の外部リンク。noopener が無いと、開いた先から
     window.opener でこちらのタブを差し替えられる。 */
  const s = src["index.html"];
  const dlg = /<dialog[^>]*id="rel-dlg"[\s\S]*?<\/dialog>/.exec(s);
  assert(dlg, "詳細窓 #rel-dlg がありません");
  const m = /<a[^>]*href="https:\/\/sinokubo\.pages\.dev\/"([^>]*)>/.exec(dlg[0]);
  assert(m, "詳細窓に URL がありません");
  assert(/target="_blank"/.test(m[1]), "別タブで開きません（ここで離脱させないため）");
  assert(/rel="[^"]*\bnoopener\b/.test(m[1]), "rel に noopener がありません");
  assert(/新大久保の韓国グルメを「本場度」で選ぶ/.test(dlg[0]), "説明文がありません");
  /* Esc を両方が拾うと、詳細窓と一緒にメニューまで閉じる。 */
  assert(/!relDlg\.open && side\.classList\.contains\('on'\)/.test(s),
    "Esc が詳細窓とメニューを同時に閉じます");
  return "URL・説明・別タブ・noopener・Esc";
});

check("privacy に性別の文言が無い（지시서⑱ ── 集めない・書かない）", () => {
  /* 性別の収集をやめた。ポリシーに残っていれば「集めていないのに
     集めると書く」逆向きの食い違い ── 4 回踏んだ「방침과 코드의
     어긋남」의 5회째를 막는다. */
  assert(!/性別/.test(src["privacy.html"]), "privacy.html に性別の文言が残っています");
  assert(!/大運/.test(src["privacy.html"]), "大運の説明段落が残っています");
  return "성별·大運 문구 0";
});

check("amulet.html の ?cat= は KINDS で照合してから使う（지시서⑪）", () => {
  /* LINE の부적 버튼이 실어 오는 유일한 파라미터。知らない値を
     Amulet.of へ渡すと throw ── 照合に落ちたら「無かったこと」にして
     従来の画面。パラメータ無しの既定（total）は変えない ──
     サイトから直接来る人のほうがずっと多い。 */
  const a = src["amulet.html"];
  assert(/URLSearchParams\(location\.search\)\.get\('cat'\)/.test(a), "?cat の受け口がありません");
  assert(/Amulet\.KINDS\.some\(k => k\.cat === urlCat\)/.test(a),
    "KINDS で照合していません ── 知らない値が Amulet.of へ行くと throw します");
  assert(/let cat  = 'total'/.test(a), "パラメータ無しの既定（total）が変わっています");
  const guard = a.indexOf("Amulet.KINDS.some");
  const firstRender = a.indexOf("\nrender();");
  assert(guard > 0 && firstRender > guard, "照合より先に描いています");
  return "照合 → 既定 total → render の順";
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : "") + `　（${pages.length} ページ）`);
process.exit(failed ? 1 : 0);
