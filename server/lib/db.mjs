/* ==================================================================
   db.mjs — MySQL への接続。ここだけが外部パッケージを読む

     import { getPool, withTransaction, closePool } from './lib/db.mjs';
     const pool = await getPool();          // 必ず await（mysql2 を動的に読むため）
     const [rows] = await pool.execute('SELECT 1');

   このプロジェクトに npm の依存は無い、というのが元からの決めごとで、
   README にもそう書いてある。ここで 1 つだけ入れる（mysql2）のは、
   MySQL の接続プロトコルを自分で書くのが割に合わないため ──
   認証プラグイン（caching_sha2_password）や TLS の取り回しは、
   間違えると「つながらない」ではなく「たまにつながらない」になる。

   代わりに、依存をこの 1 ファイルに閉じ込める。repo/ の下は
   mysql2 を import せず、渡された conn の .execute() だけを使う。
   おかげで tools/verify-server.mjs は npm install なしで走る ──
   検証に install が要らない、という既存 9 種の性質がそのまま続く。

   【conn の約束】
   repo/ が使うのは次の 2 つだけ。偽物を渡せば検証でき、
   本物を渡せば動く。
     conn.execute(sql, params) → [rows, fields]
     conn.beginTransaction / commit / rollback（withTransaction のみ）
   ================================================================== */
import { loadEnv, requireEnv } from "./env.mjs";

/* 作りかけの Promise を持つ。作り終えたものではなく。
   webhook と配信バッチが同時に立ち上がると getPool() が並んで呼ばれ、
   出来上がりを待って入れる形だと、待っている間にもう一方も
   createPool してしまう。接続の上限が低い共用サーバーでは、
   これだけで「たまに Too many connections」になる。 */
let poolPromise = null;

export function getPool() {
  if (poolPromise) return poolPromise;

  loadEnv();
  const env = requireEnv(["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]);

  poolPromise = import("mysql2/promise").then(({ default: mysql }) => {
    const p = mysql.createPool({
      host: env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,

      /* これはドライバが JS の Date ↔ DATETIME 文字列を変換するときの
         解釈で、DB のセッション時刻ではない。名前から取り違えやすいが、
         この指定だけでは @@session.time_zone は SYSTEM のまま ──
         実測すると NOW() が UTC を返す（下の SET time_zone が要る理由）。
         dateStrings と併用しているので変換自体は起きないが、
         将来 dateStrings を外したときのために正しい値を入れておく。 */
      timezone: "+09:00",

      /* DATE / DATETIME を Date に変換させず、文字列のまま受け取る。
         変換させるとドライバがローカル TZ を当てて解釈するので、
         せっかく JST で入れた値がサーバーの TZ で読み直される。
         こちらは jst.mjs が作った文字列を、文字列のまま扱う。 */
      dateStrings: true,

      waitForConnections: true,
      /* 共用サーバーの MySQL は同時接続の上限が低い（20〜30 のことが多い）。
         配信バッチと webhook が同時に走る前提で、上限より十分低く取る。 */
      connectionLimit: Number(process.env.DB_POOL_SIZE || 5),
      queueLimit: 0,
      enableKeepAlive: true,
      charset: "utf8mb4_unicode_ci"
    });

    /* ---- DB 側の時刻を JST に固定する --------------------------------
       上の timezone オプションではこれは起きない。実際に測ると、
       オプションだけの接続は

         @@session.time_zone = SYSTEM,  NOW() = 07:15   ← UTC
         SET time_zone を出した接続    = +09:00, NOW() = 16:15   ← JST

       と 9 時間ずれる。ずれる先は CURRENT_TIMESTAMP を既定値に
       持つ列 ── users.created_at / purchases.purchased_at /
       push_logs.sent_at。アプリは jst.mjs の JST を入れるので、
       同じ表に UTC と JST が混ざる。混ざったあとでは、どの行が
       どちらだったのか区別できない。

       プールは接続を張り直すので、作った瞬間に 1 回では足りない。
       新しい接続ができるたびに出す必要がある。 */
    p.on("connection", (conn) => {
      conn.query("SET time_zone = '+09:00'");
    });

    return p;
  }).catch((e) => {
    /* 失敗したものを握り続けると、直したあとも同じ例外が返り続ける。 */
    poolPromise = null;
    throw e;
  });

  return poolPromise;
}

/* 途中で落ちたら全部戻す。保有日数の加算のように、
   2 つの表を必ず一緒に動かす場面で使う。 */
export async function withTransaction(fn) {
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    try { await conn.rollback(); } catch { /* 戻せないなら握る。元の例外を出したい */ }
    throw e;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (!poolPromise) return;
  const p = await poolPromise;
  poolPromise = null;
  await p.end();
}
