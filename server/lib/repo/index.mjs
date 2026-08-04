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

/* 前払いの回数券（migrations/002）。billing が「払った台帳」なのに対し、
   こちらは「いま何日ぶん持っているか」。分けたのは寿命が違うため ──
   台帳は消さないが、保有日数は買うたびに動く。 */
export * as entitlements from "./entitlements.mjs";

/* 途中で切れて戻って来ない人の台帳。状態は持たず、出来事だけ。
   理由は lapses.mjs の頭に書いた。 */
export * as lapses from "./lapses.mjs";
