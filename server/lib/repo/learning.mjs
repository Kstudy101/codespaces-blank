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

/* ---- カリキュラム ------------------------------------------------
   計画書 1-2 の 4 学期。日数の切れ目はここだけに書く。
   配信側とクイズ側で別々に持つと、片方だけ直したときに
   「30 日目のクイズが 1 学期扱いで採点される」が起きる。 */
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

export async function getProgress(conn, userId) {
  const row = await one(conn,
    `SELECT id, user_id, current_day, current_semester, last_sent_at, quiz_pass_log
       FROM learning_progress WHERE user_id = ?`, [userId]);
  if (!row) return null;
  return { ...row, quiz_pass_log: fromJson(row.quiz_pass_log) };
}

/* 0 日目の行を用意する。既にあれば触らない ── 既存の行を
   上書きする形にすると、オンボーディングをやり直しただけで
   進みが 0 に戻る。 */
export async function ensureProgress(conn, userId) {
  /* 一意キーは user_id 1 本なので、1062 は「もう在る」だけを意味する。
     affectedRows で見分けないのは util.mjs の insertNew に書いた理由。 */
  const ins = await insertNew(conn,
    `INSERT INTO learning_progress (user_id, current_day, current_semester)
     VALUES (?, 0, 1)`, [userId]);
  return { created: ins.created, progress: await getProgress(conn, userId) };
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
export async function advanceDay(conn, userId, fromDay) {
  const next = Number(fromDay) + 1;
  const r = await run(conn,
    `UPDATE learning_progress
        SET current_day = ?, current_semester = ?, last_sent_at = ?
      WHERE user_id = ? AND current_day = ?`,
    [next, semesterForDay(next), jstDateTime(), userId, fromDay]);
  return { claimed: r.affectedRows > 0, day: next };
}

/* 運営者が特定の人だけやり直させるときに使う（計画書 5-3 / P9）。
   通常の流れからは呼ばない。 */
export async function resetProgress(conn, userId, day = 0) {
  const d = Number(day);
  if (!Number.isInteger(d) || d < 0 || d > TOTAL_DAYS) {
    throw new Error(`current_day の範囲外: ${day}（0〜${TOTAL_DAYS}）`);
  }
  const r = await run(conn,
    `UPDATE learning_progress SET current_day = ?, current_semester = ? WHERE user_id = ?`,
    [d, semesterForDay(d || 1), userId]);
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
export async function setQuizResult(conn, userId, semester, passed) {
  const s = Number(semester);
  if (!Number.isInteger(s) || s < 1 || s > SEMESTERS.length) {
    throw new Error(`未知の semester: ${semester}（1〜${SEMESTERS.length}）`);
  }
  const r = await run(conn,
    `UPDATE learning_progress
        SET quiz_pass_log = JSON_MERGE_PATCH(COALESCE(quiz_pass_log, '{}'), ?)
      WHERE user_id = ?`,
    [JSON.stringify({ [`semester${s}`]: !!passed }), userId]);
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
    requires_name_slot: !!row.requires_name_slot
  };
}

export async function getTemplate(conn, dayNumber) {
  return shapeTemplate(await one(conn,
    `SELECT day_number, semester, grammar_point, grammar_tip_kr,
            dialogue_template, vocab_3, requires_name_slot
       FROM content_templates WHERE day_number = ?`, [dayNumber]));
}

export async function listTemplates(conn, { semester = null } = {}) {
  const rows = semester === null
    ? await all(conn, `SELECT day_number, semester, grammar_point, requires_name_slot
                         FROM content_templates ORDER BY day_number`)
    : await all(conn, `SELECT day_number, semester, grammar_point, requires_name_slot
                         FROM content_templates WHERE semester = ? ORDER BY day_number`,
                [semester]);
  return rows.map(shapeTemplate);
}

/* 運営者の入力画面（P9）から呼ぶ。semester は渡さない ──
   day_number から一意に決まるものを人が入れられるようにすると、
   30 日目なのに 2 学期、のような組み合わせが入りうる。 */
export async function upsertTemplate(conn, {
  dayNumber, grammarPoint, grammarTipKr = null,
  dialogueTemplate = null, vocab3 = null, requiresNameSlot = false
}) {
  const d = Number(dayNumber);
  if (!Number.isInteger(d) || d < 1 || d > TOTAL_DAYS) {
    throw new Error(`day_number の範囲外: ${dayNumber}（1〜${TOTAL_DAYS}）`);
  }
  if (!grammarPoint) throw new Error("grammar_point は必須です");

  await run(conn,
    `INSERT INTO content_templates
       (day_number, semester, grammar_point, grammar_tip_kr,
        dialogue_template, vocab_3, requires_name_slot)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       semester           = VALUES(semester),
       grammar_point      = VALUES(grammar_point),
       grammar_tip_kr     = VALUES(grammar_tip_kr),
       dialogue_template  = VALUES(dialogue_template),
       vocab_3            = VALUES(vocab_3),
       requires_name_slot = VALUES(requires_name_slot)`,
    [d, semesterForDay(d), grammarPoint, nn(grammarTipKr),
     toJson(dialogueTemplate), toJson(vocab3), requiresNameSlot ? 1 : 0]);
  return getTemplate(conn, d);
}

/* 何日目が埋まっていないか。101 日を売る以上、
   「買ったのに 87 日目が来ない」は起きてはいけない。
   P4 の入稿作業と P10 の監視の両方から呼ぶ。 */
export async function findMissingTemplateDays(conn) {
  const rows = await all(conn, `SELECT day_number FROM content_templates`);
  const have = new Set(rows.map((r) => Number(r.day_number)));
  const missing = [];
  for (let d = 1; d <= TOTAL_DAYS; d++) if (!have.has(d)) missing.push(d);
  return missing;
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
