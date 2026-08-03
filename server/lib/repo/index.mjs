/* ==================================================================
   repo/index.mjs — 4 つをまとめて渡す

     import { users, billing, learning, pushlogs } from './lib/repo/index.mjs';
     const u = await users.findByLineUserId(conn, lineUserId);

   名前空間ごと渡すのは、呼ぶ側で users.setStatus と
   billing.setPaymentStatus のような似た名前が並んだときに、
   どちらの表を触っているかが読んで分かるようにするため。

   4 つの分け方は表ごとではなく、「必ず一緒に動く単位」。
   users+saju（一緒に生まれる）、purchases+subscriptions（一緒に増える）、
   progress+templates+checkpoints（次に何を送るかを一緒に決める）、
   push_logs（残すだけ）。理由は各ファイルの頭に書いてある。
   ================================================================== */
export * as users from "./users.mjs";
export * as billing from "./billing.mjs";
export * as learning from "./learning.mjs";
export * as pushlogs from "./pushlogs.mjs";
/* links だけは利用者に紐づかない。ウェブで四柱が出た時点では
   まだ LINE の誰かが分からないので、揃うまでの預かり場所（P3）。 */
export * as links from "./links.mjs";
