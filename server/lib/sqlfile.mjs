/* ==================================================================
   sqlfile.mjs — .sql を文ごとに切る

     import { splitStatements } from './lib/sqlfile.mjs';
     splitStatements(fs.readFileSync('server/db/schema.sql', 'utf8'));

   text.split(';') で済ませない理由。schema.sql には

     ・-- で始まる注釈（その中に ; が出る）
     ・ENUM('7days','14days',...) の文字列
     ・DEFAULT '07:00:00' の時刻

   が入っていて、素朴に切ると ENUM の途中で分かれた壊れた文が
   MySQL へ渡る。エラーは「文法が違う」としか出ないので、
   注釈の書き方が原因だとは気づけない。

   依存を足さずに済ませたいのは、これを読むのが移行スクリプト
   だから ── 最初に動かすものが npm install を要求すると、
   設置の最初の一歩で詰まる。
   ================================================================== */

export function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    /* -- 行注釈。MySQL は "--" の直後に空白か改行を要る（"--" だけだと
       演算子と区別できないため）。a--b のような式を壊さない。 */
    if (c === "-" && next === "-" && /[\s]/.test(sql[i + 2] ?? "\n")) {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }

    /* # 行注釈（MySQL 方言） */
    if (c === "#") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }

    /* ブロック注釈。/*! で始まるものは MySQL への指示なので残す。 */
    if (c === "/" && next === "*") {
      const isHint = sql[i + 2] === "!";
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      if (isHint) buf += sql.slice(i, stop);
      i = stop;
      continue;
    }

    /* 文字列と識別子。中の ; と -- は素通しする。
       '' と "" による自身のエスケープと、バックスラッシュの
       両方を見る（MySQL は既定で両方を受ける）。 */
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      buf += c;
      i++;
      while (i < sql.length) {
        const d = sql[i];
        if (d === "\\" && quote !== "`") { buf += sql.slice(i, i + 2); i += 2; continue; }
        if (d === quote && sql[i + 1] === quote) { buf += d + d; i += 2; continue; }
        buf += d;
        i++;
        if (d === quote) break;
      }
      continue;
    }

    if (c === ";") {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      i++;
      continue;
    }

    buf += c;
    i++;
  }

  const last = buf.trim();
  if (last) out.push(last);
  return out;
}
