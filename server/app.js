/* ==================================================================
   app.js — cPanel（Passenger）が最初に読むファイル

   中身は 1 行で、本体は app.mjs にある。分けているのは Passenger の
   読み込み方が版によって require か import か分かれるため。

   このファイルは CommonJS のまま置く（package.json に
   "type": "module" を書かない）。CommonJS からでも動的 import() は
   使えるので、require されても import されても app.mjs に届く。

   逆にすると詰まる。"type": "module" を入れて app.js を ESM にすると、
   require で読む Passenger では Node 22 未満が
   「require() of ES Module is not supported」で起動に失敗する。
   起動しない理由は cPanel の画面からは読み取れず、
   ログを掘るまで分からない。

   実装ファイルは全部 .mjs にしてあるので、"type" が無くても
   ESM として読まれる（.mjs は拡張子だけで決まる）。

   cPanel → Setup Node.js App の設定:
     Application startup file : app.js
     Application root         : （このディレクトリ）
   ================================================================== */
"use strict";

import("./app.mjs").catch((e) => {
  console.error("[fatal] 起動できません:", e && e.stack ? e.stack : e);
  process.exit(1);
});
