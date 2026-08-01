#!/usr/bin/env node
/* ==================================================================
   verify-study.mjs — study.js（単語帳・出席・助詞）を確かめる

     使い方:  node tools/verify-study.mjs

   ここで確かめるのは 3 つ。

     1 助詞     パッチムの有無で「을/를」「이/가」が正しく変わるか。
                間違えると学習コンテンツとして誤りを教えることになる
     2 単語帳   重複を持たない・消せる・上限で黙って失敗しない（§6）
     3 出席     日をまたぐ・間が空く・同じ日に何度も来る（§9）

   加えて単語データ自体も見る。ローマ字や意味の抜けは画面で
   「undefined」として出るので、置いた時点で気づけるようにしておく。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
vm.runInThisContext(fs.readFileSync("study.js", "utf8"), { filename: "study.js" });

let failed = 0, passed = 0;
const check = (label, fn) => {
  try { const d = fn(); passed++; console.log(`  ✓ ${label}${d ? "  " + d : ""}`); }
  catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const head = (s) => console.log(`\n${s}`);

/** localStorage の代わり。容量超過も再現できるようにしてある。 */
function fakeStorage(limit) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (limit && String(v).length > limit) { const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e; }
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    _dump: () => JSON.stringify([...m]),
    _keys: () => [...m.keys()],
  };
}
const fresh = (limit) => { globalThis.localStorage = fakeStorage(limit); };

/* ---- 1. 助詞 -------------------------------------------------------- */

head("[助詞]  パッチムの有無で形が変わる");

check("パッチムの判定", () => {
  const yes = ["책", "지갑", "돈", "인연", "건강", "한 단어만", "물"];
  const no  = ["나", "기회", "회의", "가方", "머리", "우유", "커피"];
  for (const w of yes) assert(Study.hasJong(w), `${w} はパッチムありのはず`);
  for (const w of no)  assert(!Study.hasJong(w), `${w} はパッチムなしのはず`);
  return `あり ${yes.length} 件 / なし ${no.length} 件`;
});

check("을/를・이/가 の選択", () => {
  const cases = [
    ["지갑", "을", "지갑を"], ["기회", "를", "機会を"],
    ["돈", "을", "お金を"],   ["회의", "를", "会議を"],
  ];
  for (const [w, want] of cases) {
    const got = Study.josa(w, "을", "를");
    assert(got === want, `${w}+${got}（${want} のはず）`);
  }
  assert(Study.josa("지갑", "이", "가") === "이", "지갑이 のはず");
  assert(Study.josa("기회", "이", "가") === "가", "기회가 のはず");
  return cases.map(([w, j]) => w + j).join(" / ");
});

check("ハングル以外が混ざっても落ちない", () => {
  // 「단어(單語)」のように漢字や記号が付く見出しがある。
  assert(Study.hasJong("단어(單語)") === false, "단어 はパッチムなし");
  assert(Study.hasJong("지갑(紙匣)") === true, "지갑 はパッチムあり");
  for (const w of ["", null, undefined, "abc", "漢字", "123"])
    assert(Study.hasJong(w) === false, `${JSON.stringify(w)} で false にならない`);
  return "括弧つき見出し・空・非ハングルすべて通る";
});

/* ---- 2. 単語データ -------------------------------------------------- */

head("[単語データ]  画面に undefined を出さない");

check("6 項目すべてに単語があり、必須の欄が埋まっている", () => {
  const ids = ["total", "money", "love", "work", "health", "study"];
  let n = 0;
  const seen = new Set();
  for (const id of ids) {
    const a = Study.WORDS[id];
    assert(Array.isArray(a) && a.length >= 3, `${id} の単語が ${a ? a.length : 0} 件`);
    for (const w of a) {
      for (const f of ["k", "r", "j", "g"])
        assert(typeof w[f] === "string" && w[f].length, `${id}/${w.k}: ${f} が空`);
      assert(Array.isArray(w.p) && w.p.length, `${id}/${w.k}: 分解が空`);
      for (const part of w.p)
        assert(part.length === 2 && part[0] && part[1], `${id}/${w.k}: 分解の形が違います`);
      assert(/[가-힣]/.test(w.k), `${id}/${w.k}: ハングルが入っていません`);
      assert(!seen.has(w.k), `${w.k} が重複しています`);
      seen.add(w.k);
      n++;
    }
  }
  return `${n} 語 / 重複なし`;
});

check("pick() は同じ番号なら同じ語、番号が負でも落ちない", () => {
  for (const id of Object.keys(Study.WORDS)) {
    const a = Study.WORDS[id];
    assert(Study.pick(id, 0).k === a[0].k, `${id} の 0 番`);
    assert(Study.pick(id, a.length).k === a[0].k, `${id} の一巡`);
    assert(Study.pick(id, -1).k === a[a.length - 1].k, `${id} の −1`);
    assert(Study.pick(id, 7).k === Study.pick(id, 7).k, `${id} が呼ぶたび変わります`);
  }
  assert(Study.pick("nosuch", 0), "知らない項目でも何か返すこと");
  return `${Object.keys(Study.WORDS).length} 項目`;
});

/* ---- 3. 単語帳 ------------------------------------------------------ */

head("[単語帳]  重複しない・消せる・黙って失敗しない");

check("保存すると一覧に入る", () => {
  fresh();
  assert(Study.list().length === 0, "最初は空のはず");
  assert(Study.add(Study.WORDS.study[0], "2026-08-01") === "added", "保存できません");
  const a = Study.list();
  assert(a.length === 1 && a[0].k === Study.WORDS.study[0].k, `一覧が ${JSON.stringify(a)}`);
  assert(a[0].d === "2026-08-01", "保存日が入っていません");
  return `${a[0].k}（${a[0].j}）`;
});

check("同じ語は二度入らない", () => {
  fresh();
  const w = Study.WORDS.money[0];
  assert(Study.add(w) === "added", "1 回目");
  assert(Study.add(w) === "duplicate", "2 回目が duplicate になりません");
  assert(Study.list().length === 1, `${Study.list().length} 件入っています`);
  assert(Study.has(w.k) === true, "has() が false");
  return "2 回押しても 1 件";
});

check("個別に消せる・全部消せる", () => {
  fresh();
  const ws = [Study.WORDS.love[0], Study.WORDS.work[0], Study.WORDS.health[0]];
  ws.forEach((w) => Study.add(w));
  assert(Study.remove(ws[1].k) === true, "削除できません");
  assert(Study.list().length === 2, `${Study.list().length} 件`);
  assert(!Study.has(ws[1].k), "消したのに残っています");
  assert(Study.remove("무無無") === false, "無い語の削除が true を返します");
  Study.clearWords();
  assert(Study.list().length === 0, "全消しできません");
  return "個別 → 全消し";
});

check("上限に達したら full を返す（黙って捨てない）", () => {
  fresh();
  for (let i = 0; i < Study.MAX_WORDS; i++)
    assert(Study.add({ k: "말" + i, r: "mal" + i, j: "語" + i }) === "added", `${i} 件目`);
  const r = Study.add({ k: "넘침", r: "neomchim", j: "あふれ" });
  assert(r === "full", `上限を超えたのに ${r}`);
  assert(Study.list().length === Study.MAX_WORDS, "上限を超えて入っています");
  return `${Study.MAX_WORDS} 件で頭打ち`;
});

check("容量超過は failed を返す（added と偽らない）", () => {
  fresh(50);          // 何を書いても超過する狭さ
  const r = Study.add(Study.WORDS.study[1]);
  assert(r === "failed", `容量超過なのに ${r}`);
  assert(Study.list().length === 0, "入っていないのに一覧にあります");
  return "failed";
});

check("localStorage が使えなくても落ちない", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
  };
  assert(Study.list().length === 0, "一覧で落ちます");
  assert(Study.add(Study.WORDS.total[0]) === "failed", "add が failed を返しません");
  assert(Study.has("운이 좋다") === false, "has で落ちます");
  assert(Study.clearWords() === false, "clear が true を返します");
  delete globalThis.localStorage;
  return "例外を投げるだけの localStorage でも通る";
});

/* ---- 4. 出席 -------------------------------------------------------- */

head("[出席]  日をまたぐ・間が空く・同じ日に何度も来る");

check("同じ日に何度来ても 1 日", () => {
  fresh();
  const a = Study.mark("2026-08-01");
  assert(a.days === 1 && a.streak === 1 && a.isNew, `${JSON.stringify(a)}`);
  const b = Study.mark("2026-08-01");
  assert(b.days === 1 && b.streak === 1 && !b.isNew, `2 回目が ${JSON.stringify(b)}`);
  return "1 日 / 連続 1 日";
});

check("続けて来ると連続日数が伸びる", () => {
  fresh();
  ["2026-07-30", "2026-07-31", "2026-08-01"].forEach((d) => Study.mark(d));
  const r = Study.attendance("2026-08-01");
  assert(r.streak === 3, `連続 ${r.streak} 日`);
  assert(r.days === 3, `のべ ${r.days} 日`);
  return "3 日連続";
});

check("1 日空くと連続が切れる", () => {
  fresh();
  ["2026-07-28", "2026-07-29", "2026-07-31", "2026-08-01"].forEach((d) => Study.mark(d));
  const r = Study.attendance("2026-08-01");
  assert(r.streak === 2, `連続 ${r.streak} 日（7/30 が抜けているので 2 のはず）`);
  assert(r.days === 4, `のべ ${r.days} 日`);
  return "のべ 4 日 / 連続 2 日";
});

check("月をまたぐ・うるう日をまたぐ", () => {
  fresh();
  ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"].forEach((d) => Study.mark(d));
  const r = Study.attendance("2028-03-01");
  assert(r.streak === 4, `連続 ${r.streak} 日（2/29 を含めて 4 のはず）`);
  fresh();
  ["2026-12-30", "2026-12-31", "2027-01-01"].forEach((d) => Study.mark(d));
  assert(Study.attendance("2027-01-01").streak === 3, "年をまたぐと切れます");
  return "2028-02-29 / 年またぎとも連続";
});

check("今日まだ来ていなければ連続は 0", () => {
  fresh();
  ["2026-07-30", "2026-07-31"].forEach((d) => Study.mark(d));
  // 昨日まで続いていても、今日ぶんを押すまでは 0。押した時点で伸びる。
  assert(Study.attendance("2026-08-01").streak === 0, "来ていないのに数えています");
  assert(Study.mark("2026-08-01").streak === 3, "押しても伸びません");
  return "押す前 0 → 押して 3";
});

check("順番が前後しても数えられる", () => {
  fresh();
  ["2026-08-01", "2026-07-30", "2026-07-31"].forEach((d) => Study.mark(d));
  assert(Study.attendance("2026-08-01").streak === 3, "並び順に依存しています");
  return "昇順に整えて保持";
});

check("保存する日数に上限がある", () => {
  fresh();
  const base = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 420; i++)
    Study.mark(new Date(base + i * 86400000).toISOString().slice(0, 10));
  const n = Study.days().length;
  assert(n <= 400, `${n} 日ぶん残っています`);
  const last = new Date(base + 419 * 86400000).toISOString().slice(0, 10);
  assert(Study.attendance(last).streak === 400, `直近の連続が ${Study.attendance(last).streak}`);
  return `${n} 日で頭打ち、直近の連続は保たれる`;
});

/* ---- 5. 保存物 ------------------------------------------------------ */

head("[保存]  学習の記録だけ。名前も生年月日も入らない");

check("保存物に個人情報が現れない", () => {
  fresh();
  Study.add(Study.WORDS.study[0], "2026-08-01");
  Study.mark("2026-08-01");
  const raw = globalThis.localStorage._dump();
  for (const bad of ["1990", "田中", "たなか", "seoul", "tokyo", "生年", "壬午"])
    assert(!raw.includes(bad), `保存物に "${bad}" が入っています`);
  const keys = globalThis.localStorage._keys().sort();
  assert(keys.join(",") === "k101.attend,k101.words", `鍵が ${keys.join(",")}`);
  return `${raw.length} バイト / 鍵 ${keys.join(" ")}`;
});

check("消したら本当に消える", () => {
  fresh();
  Study.add(Study.WORDS.total[0]);
  Study.mark("2026-08-01");
  Study.clearWords(); Study.clearAttend();
  assert(globalThis.localStorage._keys().length === 0,
    `残っています: ${globalThis.localStorage._keys()}`);
  return "鍵ごと消える";
});

console.log(`\n${failed ? "✗" : "✓"} ${passed + failed} 項目中 ${passed} 件成功`
  + (failed ? ` / ${failed} 件失敗` : ""));
process.exit(failed ? 1 : 0);
