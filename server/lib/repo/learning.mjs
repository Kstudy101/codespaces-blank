/* ==================================================================
   repo/learning.mjs — learning_progress / content_templates / quiz_checkpoints

   進み具合と、配信する原稿と、節目。3 つを 1 つのファイルにしたのは
   「次に何を送るか」を決めるのに 3 つとも要るため ── 進みを 1 日ぶん
   出して、その日の原稿をひいて、節目ならクイズも足す、が 1 続き。

   計画書 1-2 の取り決めをコードの側から言い直すと:
     ・current_day を動かすのは朝の学習配信だけ
     ・夕方の復習も、節目のクイズも、この列に触らない
   だから「進める」関数は 1 つしか置いていない（advanceDay）。
   ================================================================== */
import { one, all, run, insertNew, fromJson, toJson, nn } from "./util.mjs";
import { jstDateTime } from "../jst.mjs";

/* ---- コース ------------------------------------------------------
   初級・中級・上級。**3 本の独立した 101 日**で、進み方を共有しない。

   1 本の 101 日を 3 つに割って「中級は 31 日目から」にする案もあったが、
   そちらだと中級を選んだ人の講座が 71 日で終わる ── 同じ値段で
   受け取る量が違うことになり、説明もできない。

   選ばせる以上、選んだ先にそれぞれ 101 日ぶんが要る。原稿の総量は
   3 倍（303 日）になる。今あるのは初級 50 日だけなので、中級・上級は
   入稿が済むまで content_templates が空のまま ── 配信バッチは
   「原稿なし」で日を消費せずに止まるので、空のコースを選んだ人に
   何かが届いてしまうことは無い（db/push-daily.mjs）。

   ここが唯一の出どころ。DB の ENUM と 2 か所になるので、
   verify-server.mjs が schema と突き合わせる。 */
export const TRACKS = Object.freeze(["beginner", "intermediate", "advanced"]);

/* 画面に出す名前。日本語で出す（利用者は日本語話者）。
   韓国語を併記するのは、コース名そのものが最初の単語になるため。 */
export const TRACK_LABELS = Object.freeze({
  beginner:     { ja: "初級", kr: "초급" },
  intermediate: { ja: "中級", kr: "중급" },
  advanced:     { ja: "上級", kr: "고급" }
});

export function isTrack(v) {
  return typeof v === "string" && TRACKS.includes(v);
}


/* ---- カリキュラム ------------------------------------------------
   計画書 1-2 の 4 学期。日数の切れ目はここだけに書く。
   配信側とクイズ側で別々に持つと、片方だけ直したときに
   「30 日目のクイズが 1 学期扱いで採点される」が起きる。

   学期の区切りは 3 コースで共通。コースが違っても「30 日目が節目」は
   同じにしておくと、クイズの表（quiz_checkpoints）を 3 つに増やさずに済む。 */
export const SEMESTERS = Object.freeze([
  { semester: 1, from: 1,  to: 30  },
  { semester: 2, from: 31, to: 50  },
  { semester: 3, from: 51, to: 75  },
  { semester: 4, from: 76, to: 101 }
]);

export const TOTAL_DAYS = 101;

/* 何日目が何学期か。DB を引かずに出す ── 配信バッチが
   1 人につき 1 回ずつ引くと、人数ぶんの往復になる。 */
export function semesterForDay(day) {
  const d = Number(day);
  if (!Number.isInteger(d) || d < 1) return 1;
  const hit = SEMESTERS.find((s) => d >= s.from && d <= s.to);
  return hit ? hit.semester : SEMESTERS[SEMESTERS.length - 1].semester;
}


/* ---- 進み具合 ----------------------------------------------------- */

/* ---- コース別になった（migrations/002）------------------------------
   1 人が初級 101 日を終えて中級へ進めるようにしたので、進みは
   (user_id, track) ごとに 1 行ある。track は必ず要る ── 既定を
   置くと、渡し忘れた呼び出しが初級の行を触って動いてしまう。 */
export async function getProgress(conn, userId, track) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  const row = await one(conn,
    `SELECT id, user_id, track, current_day, days_used, current_semester,
            last_sent_at, quiz_pass_log
       FROM learning_progress WHERE user_id = ? AND track = ?`, [userId, track]);
  if (!row) return null;
  return { ...row, quiz_pass_log: fromJson(row.quiz_pass_log) };
}

/* その人が持っている進み全部。「初級は終わった、中級は 12 日目」を
   一度に出すのに使う。 */
export async function listProgress(conn, userId) {
  const rows = await all(conn,
    `SELECT track, current_day, days_used, current_semester, last_sent_at
       FROM learning_progress WHERE user_id = ?
      ORDER BY FIELD(track, 'beginner','intermediate','advanced')`, [userId]);
  return rows;
}

/* 0 日目の行を用意する。既にあれば触らない ── 上書きする形にすると、
   買い直しただけで進みが 0 に戻り、受け取った日が二度と来なくなる。

   呼ぶのは購入（と体験開始）の時点。友だち追加では作らない ──
   track が鍵の一部になったので、「まだ選んでいない」行が置けない。 */
export async function ensureProgress(conn, userId, track) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  /* 一意キーは (user_id, track) 1 本なので、1062 は「もう在る」だけを
     意味する。affectedRows で見分けないのは util.mjs の insertNew の理由。 */
  const ins = await insertNew(conn,
    `INSERT INTO learning_progress (user_id, track, current_day, days_used, current_semester)
     VALUES (?, ?, 0, 0, 1)`, [userId, track]);
  return { created: ins.created, progress: await getProgress(conn, userId, track) };
}

/* 1 日進める。読んだときの値（fromDay）を渡してもらい、
   その値のままだったときだけ書き換える。

   なぜ +1 するだけでは足りないか。配信バッチが二重に走ると
   （cron の重複登録、手動での再実行、前の回が終わる前に次が始まる）、
   両方が current_day = 5 を読んでから両方が 6 を送る。単純な
   「current_day = current_day + 1」だと両方成功して 7 まで進むので、
   6 日目が二度届き、7 日目は誰も見ないまま飛ぶ。

   WHERE current_day = ? を付けると、勝つのは片方だけになる。
   負けた側は false が返るので、送らずに降りられる。

   返り値を必ず見ること。true のときだけ送る、が正しい順番 ──
   送ってから進めると、送信は成功したのに進められなかったとき
   同じ日が翌朝もう一度届く。 */
/* days_used も同じ 1 文で増やす。ここを別の文にすると、日を確保した
   のに使った日数だけ増えていない瞬間が生まれ、そこで落ちると
   1 日ぶんが無料になる。確保に勝った側だけが両方を動かす。 */
export async function advanceDay(conn, userId, track, fromDay) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  const next = Number(fromDay) + 1;
  const r = await run(conn,
    `UPDATE learning_progress
        SET current_day = ?, days_used = days_used + 1,
            current_semester = ?, last_sent_at = ?
      WHERE user_id = ? AND track = ? AND current_day = ?`,
    [next, semesterForDay(next), jstDateTime(), userId, track, fromDay]);
  return { claimed: r.affectedRows > 0, day: next };
}

/* ---- 進みの器の自己回復（docs/research-onboarding-gap.md 欠損B）-----
   配信対象の SQL は learning_progress を INNER JOIN で結ぶ。行が
   手で消される・障害で欠けると、その人は**エラーも無く**配信から
   落ち、作り直す口は購入と体験開始にしか無かった ── 袋小路。

   利用者の接点（webhook）で呼ぶ。コースが決まっていて、その
   コースの持ち日数（course_entitlements）も在るのに、進みの行だけ
   無い ── その組み合わせは「消えた」以外に説明が無いので、0 日目の
   器を置き直す。

   ★ days_used は 0 から。消えた行の使用済み日数は取り戻せない ──
   残り = entitled - used なので、行を消した時点で受け取った日数が
   復活している。ここでは直せない種類の損で、防ぐ側は
   「learning_progress の行を手で消さない」（STATUS §8）。

   entitlement が無い人には作らない。作っても配信対象の JOIN
   （course_entitlements も INNER）を通れず、意味の無い行が残るだけ。 */
export async function healProgress(conn, user) {
  const track = user?.active_track;
  if (!user?.id || !isTrack(track)) return false;

  const p = await one(conn,
    `SELECT id FROM learning_progress WHERE user_id = ? AND track = ?`, [user.id, track]);
  if (p) return false;

  const e = await one(conn,
    `SELECT id FROM course_entitlements WHERE user_id = ? AND track = ?`, [user.id, track]);
  if (!e) return false;

  await ensureProgress(conn, user.id, track);
  return true;
}

/* ---- 「1 日目からやり直す」------------------------------------------
   買い直した人が選べる（handlers/checkout.mjs の resume）。

   ★ days_used には触らない。ここが計画書 §3.2 そのもので、
   触ると残りが復活する:

     30 日購入 → 10 日目まで受け取る → やり直し → current_day = 0
       days_used も 0 にすると  残り = 30 - 0  = 30   ← 10 日ぶん無料
       days_used を残せば      残り = 30 - 10 = 20   ← 正しい

   やり直しても日数は使う。そのほうが正直で、説明もできる。

   運営者が特定の人だけ戻すときにも同じ関数を使う（計画書 5-3 / P9）。 */
export async function resetProgress(conn, userId, track, day = 0) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  const d = Number(day);
  if (!Number.isInteger(d) || d < 0 || d > TOTAL_DAYS) {
    throw new Error(`current_day の範囲外: ${day}（0〜${TOTAL_DAYS}）`);
  }
  const r = await run(conn,
    `UPDATE learning_progress
        SET current_day = ?, current_semester = ?
      WHERE user_id = ? AND track = ?`,
    [d, semesterForDay(d || 1), userId, track]);
  return r.affectedRows > 0;
}

/* クイズの合否。JSON 列を丸ごと書き換えるのではなく、DB 側で
   該当の学期だけ差し替える ── 読んで直して書き戻す形だと、
   同時に 2 学期ぶん採点が走ったときに後から書いた方が前の結果を消す。

   JSON_SET に真偽値を ? で渡す形にしていたが、本物の DB に当てると
   {"semester1": 1} になった。ドライバが JS の true を整数 1 として
   送るので、JSON の boolean ではなく number が入る。
   JSON_SET(…, TRUE) と書けば boolean になるが、それだと値を SQL に
   埋め込むことになる。

   JSON_MERGE_PATCH なら差し替える中身ごと ? で渡せて、両方立つ。
   MySQL 8 でも MariaDB 10.11 でも同じ結果になることを確かめてある
   （CAST(? AS JSON) は MariaDB に無いので使えない）。 */
export async function setQuizResult(conn, userId, track, semester, passed) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  const s = Number(semester);
  if (!Number.isInteger(s) || s < 1 || s > SEMESTERS.length) {
    throw new Error(`未知の semester: ${semester}（1〜${SEMESTERS.length}）`);
  }
  const r = await run(conn,
    `UPDATE learning_progress
        SET quiz_pass_log = JSON_MERGE_PATCH(COALESCE(quiz_pass_log, '{}'), ?)
      WHERE user_id = ? AND track = ?`,
    [JSON.stringify({ [`semester${s}`]: !!passed }), userId, track]);
  return r.affectedRows > 0;
}


/* ---- 配信する原稿 ------------------------------------------------- */

function shapeTemplate(row) {
  if (!row) return null;
  return {
    ...row,
    dialogue_template: fromJson(row.dialogue_template),
    vocab_3: fromJson(row.vocab_3),
    /* MySQL の BOOLEAN は TINYINT(1) なので 0/1 で返る。
       そのまま渡すと呼び出し側の if で 0 が falsy として効いてしまう
       ── 効いてはいるが、意図して真偽値を扱っているのか
       たまたま通っているのか読めなくなるので、ここで直す。 */
    requires_name_slot: !!row.requires_name_slot,
    fortune_bridge: fromJson(row.fortune_bridge),
    /* 003。節目の採点（handlers/postback.mjs の tpl.quiz）と
       復習クイズの両方がここを読む。 */
    quiz: fromJson(row.quiz)
  };
}

const TPL_COLS = `day_number, track, semester, grammar_point, grammar_tip_kr,
                  dialogue_template, vocab_3, fortune_bridge, requires_name_slot, quiz`;

/* track を第 2 引数ではなく第 2 引数「として必須」にしてある。
   既定を 'beginner' にすると、渡し忘れた呼び出しが初級の原稿を
   引いて動いてしまう ── 中級の人に初級が届くが、どちらも
   「それらしい 1 日ぶん」なので、読むまで分からない。 */
export async function getTemplate(conn, track, dayNumber) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}`);
  return shapeTemplate(await one(conn,
    `SELECT ${TPL_COLS} FROM content_templates
      WHERE track = ? AND day_number = ?`, [track, dayNumber]));
}

export async function listTemplates(conn, { track = null, semester = null } = {}) {
  const where = [], args = [];
  if (track !== null) {
    if (!isTrack(track)) throw new Error(`未知の track: ${track}`);
    where.push("track = ?"); args.push(track);
  }
  if (semester !== null) { where.push("semester = ?"); args.push(semester); }

  const rows = await all(conn,
    `SELECT day_number, track, semester, grammar_point, requires_name_slot
       FROM content_templates
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY track, day_number`, args);
  return rows.map(shapeTemplate);
}

/* 運営者の入力画面（P9）から呼ぶ。semester は渡さない ──
   day_number から一意に決まるものを人が入れられるようにすると、
   30 日目なのに 2 学期、のような組み合わせが入りうる。 */
export async function upsertTemplate(conn, {
  track, dayNumber, grammarPoint, grammarTipKr = null,
  dialogueTemplate = null, vocab3 = null, fortuneBridge = null,
  requiresNameSlot = false, quiz = null
}) {
  if (!isTrack(track)) {
    throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")} のどれか）`);
  }
  const d = Number(dayNumber);
  if (!Number.isInteger(d) || d < 1 || d > TOTAL_DAYS) {
    throw new Error(`day_number の範囲外: ${dayNumber}（1〜${TOTAL_DAYS}）`);
  }
  if (!grammarPoint) throw new Error("grammar_point は必須です");

  await run(conn,
    `INSERT INTO content_templates
       (track, day_number, semester, grammar_point, grammar_tip_kr,
        dialogue_template, vocab_3, fortune_bridge, requires_name_slot, quiz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       semester           = VALUES(semester),
       grammar_point      = VALUES(grammar_point),
       grammar_tip_kr     = VALUES(grammar_tip_kr),
       dialogue_template  = VALUES(dialogue_template),
       vocab_3            = VALUES(vocab_3),
       fortune_bridge     = VALUES(fortune_bridge),
       requires_name_slot = VALUES(requires_name_slot),
       quiz               = VALUES(quiz)`,
    [track, d, semesterForDay(d), grammarPoint, nn(grammarTipKr),
     toJson(dialogueTemplate), toJson(vocab3), toJson(fortuneBridge),
     requiresNameSlot ? 1 : 0, toJson(quiz)]);
  return getTemplate(conn, track, d);
}

/* quiz 列の形。壊れていれば null ── 送らないだけで、本編は届く。
   復習（pickReviewQuiz）と節目（db/push-daily.mjs）の両方がここを
   通る。別々に見ると、片方だけ「answer が範囲外」を通してしまう。 */
export function usableQuiz(q) {
  if (!q || typeof q.question !== "string" || !q.question
      || !Array.isArray(q.choices) || q.choices.length < 2
      || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
    return null;
  }
  return q;
}

/* ---- 復習クイズ（3 日周期、docs/plan-quiz.md）----------------------
   maxDay 以下から 1 問を無作為に。上限を切るのは未習の文法を
   出さないため ── 範囲を外すと、3 日目の人に 40 日目の敬語が届く。
   表はコース当たり最大 101 行なので RAND() の費用は無い。

   原稿が壊れていれば null ── ここで throw すると、
   原稿 1 件の不備が配信バッチごと落とす。 */
export async function pickReviewQuiz(conn, track, maxDay) {
  if (!isTrack(track)) throw new Error(`未知の track: ${track}（${TRACKS.join(" / ")}）`);
  const d = Number(maxDay);
  if (!Number.isInteger(d) || d < 1) return null;

  const rows = await all(conn,
    `SELECT day_number, quiz FROM content_templates
      WHERE track = ? AND day_number <= ? AND quiz IS NOT NULL
      ORDER BY RAND() LIMIT 1`, [track, d]);
  if (!rows.length) return null;

  const q = usableQuiz(fromJson(rows[0].quiz));
  if (!q) return null;
  return { dayNumber: Number(rows[0].day_number),
           question: q.question, choices: q.choices, answer: q.answer };
}

/* 何日目が埋まっていないか。101 日を売る以上、
   「買ったのに 87 日目が来ない」は起きてはいけない。
   P4 の入稿作業と P10 の監視の両方から呼ぶ。

   コース別に見る。合計で数えると、初級 101 日だけ入った状態が
   「303 日中 101 日」に見えて、中級を選んだ人には 1 日目すら
   無いことが読み取れない。 */
export async function findMissingTemplateDays(conn, track = null) {
  if (track !== null && !isTrack(track)) throw new Error(`未知の track: ${track}`);

  const rows = track === null
    ? await all(conn, `SELECT track, day_number FROM content_templates`)
    : await all(conn, `SELECT track, day_number FROM content_templates WHERE track = ?`, [track]);

  const have = new Set(rows.map((r) => `${r.track}:${Number(r.day_number)}`));
  const wanted = track === null ? TRACKS : [track];

  const missing = {};
  for (const t of wanted) {
    const days = [];
    for (let d = 1; d <= TOTAL_DAYS; d++) if (!have.has(`${t}:${d}`)) days.push(d);
    missing[t] = days;
  }
  /* 1 コースだけ訊かれたときは、そのコースの配列をそのまま返す。
     呼ぶ側が track を指定しているのに {beginner:[…]} が返ると、
     ほぼ確実に .length を取り違える。 */
  return track === null ? missing : missing[track];
}


/* ---- 節目 ---------------------------------------------------------
   30 / 50 / 75 日目。ここに載っている日は、朝の学習配信の「あとに」
   クイズを足す日であって、学習配信を置き換える日ではない。 */

export async function listCheckpoints(conn) {
  return all(conn, `SELECT day_number, semester FROM quiz_checkpoints ORDER BY day_number`);
}

export async function isCheckpoint(conn, dayNumber) {
  const row = await one(conn,
    `SELECT day_number FROM quiz_checkpoints WHERE day_number = ?`, [dayNumber]);
  return row !== null;
}
