/* ==================================================================
   handlers/link.mjs — ウェブの四柱を LINE アカウントに繋ぐ（計画書 5-1）

   流れは 2 回に分かれる。間にブラウザが LINE の認証画面へ出ていくので、
   こちらは 1 度手を離すことになる。

     1  POST /line/link/start
        ウェブ（占い結果ページ）が四柱を送ってくる。
        まだ LINE の誰かは分からないので pending_links に預かり、
        合言葉（state）と認証画面の URL を返す。

     2  GET /line/callback?code=…&state=…
        LINE から戻ってくる。state で預かりものを引き当て、
        code を userId に替えて、users / saju_profiles に移す。

   【なぜ預ける必要があるのか】
   占いが終わった時点で分かっているのは名前と生年月日だけ。
   LINE の userId が分かるのは認証から戻った後。両方が揃わないと
   どの行に書けばよいか決まらないので、先に来た方を置いておく。

   【順番はどちらでもよい】
   友だち追加が先の人（webhook の follow が先に来ている）も、
   リンクが先の人も居る。users への書き込みは upsertOnFollow を
   通すので、どちらが先でも 2 人にならない。
   ================================================================== */
import { users, links, billing, learning } from "../repo/index.mjs";
import { newState, hashState, looksLikeState } from "../token.mjs";
import { authorizeUrl, exchangeCode, loginProfile, revoke } from "../linelogin.mjs";
import { getProfile, isUnreachable } from "../line.mjs";
import { jstDateTime } from "../jst.mjs";

/* ---- 入力の検査 ----------------------------------------------------
   ここはウェブから来る唯一の入口で、中身は利用者が作れる。
   長さと形だけ見て、収まらないものは切るか捨てる。
   DB の列幅を超えると MySQL 側で落ちるので、そこまで届かせない。 */

const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

/* 生年月日の範囲は、サイト側（birth.js）と同じ 1930〜2030 に合わせる。
   ここを広く取ると、保存はできたのに四柱が立たない状態を作れる。

   切り詰めてから形を見てはいけない。10 文字に切ってから調べると
   "1995-04-12T23:00:00Z" が "1995-04-12" として通る ── UTC の
   23 時は JST では翌日なので、日柱が 1 日ずれた四柱を出したまま
   保存される。占いの中身が変わるのに、値は「それらしい日付」の
   ままなので、見比べても分からない。長さごと弾く。 */
function birthDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s)) return null;             // 切らずにそのまま見る
  const y = Number(s.slice(0, 4));
  if (y < 1930 || y > 2030) return null;
  /* 2 月 30 日のような「形は合っているが存在しない日」を落とす。
     Date に通すと 3 月 2 日へ繰り上がるので、戻して同じか確かめる。 */
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

/* 時刻も同じ理由で切らずに見る。"09:30:15+09:00" を切り詰めると
   時差を落としたまま通ってしまい、時柱がずれる。 */
function birthTime(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!TIME_RE.test(s)) return null;
  return s.length === 5 ? `${s}:00` : s;
}

export function normalizeProfile(input) {
  const b = input || {};
  return {
    nameKanji:   str(b.nameKanji ?? b.name_kanji, 50),
    nameReading: str(b.nameReading ?? b.name_reading, 50),
    nameKr:      str(b.nameKr ?? b.name_kr, 50),
    birthDate:   birthDate(b.birthDate ?? b.birth_date),
    birthTime:   birthTime(b.birthTime ?? b.birth_time),
    gender:      ["M", "F", "U"].includes(b.gender) ? b.gender : "U",
    ohaengMain:  str(b.ohaengMain ?? b.ohaeng_main, 10),
    /* 元の診断結果は丸ごと預かるが、大きさは抑える。
       ここが無制限だと、この口が保管庫として使える。 */
    rawResult:   b.rawResult ?? b.raw_result ?? null
  };
}

const MAX_RAW_JSON = 8 * 1024;


/* ---- 1. 預ける ---------------------------------------------------- */

export async function startLink(conn, input) {
  const profile = normalizeProfile(input);

  if (!profile.birthDate) {
    return { ok: false, reason: "birthDate が 1930〜2030 の YYYY-MM-DD ではありません" };
  }
  if (profile.rawResult !== null) {
    const size = JSON.stringify(profile.rawResult).length;
    if (size > MAX_RAW_JSON) {
      return { ok: false, reason: `rawResult が大きすぎます（${size} > ${MAX_RAW_JSON}）` };
    }
  }

  const state = newState();
  const now = jstDateTime();
  const expiresAt = jstDateTime(new Date(Date.now() + links.TTL_MINUTES * 60_000));

  await links.create(conn, hashState(state), profile, { now, expiresAt });

  return {
    ok: true,
    state,
    authorizeUrl: authorizeUrl(state),
    expiresInSeconds: links.TTL_MINUTES * 60
  };
}


/* ---- 2. 戻ってくる ------------------------------------------------ */

export async function completeLink(conn, { code, state, error, errorDescription }) {
  /* 利用者が同意画面で「キャンセル」を押すと、code ではなく
     error が付いて戻る。異常ではないので、そう伝える。 */
  if (error) {
    return { ok: false, kind: "declined", reason: errorDescription || error };
  }
  if (!looksLikeState(state)) {
    return { ok: false, kind: "bad_state", reason: "state の形が違います" };
  }
  if (!code || typeof code !== "string") {
    return { ok: false, kind: "bad_code", reason: "code がありません" };
  }

  /* 預かりものを取り出す。取れなければ、期限切れか、二度目か、
     こちらが出したものではない。どれも「もう一度やり直し」なので
     利用者への言い方は同じにする（どれだったかは教えない ──
     教えると、state を総当たりする側に手がかりを渡すことになる）。 */
  const now = jstDateTime();
  const pending = await links.consume(conn, hashState(state), { now });
  if (!pending) {
    return { ok: false, kind: "expired", reason: "期限切れか、すでに使われた state です" };
  }

  /* ここで初めて LINE の誰かが分かる。 */
  let lineUserId, displayName = null, accessToken = null;
  try {
    const token = await exchangeCode(code);
    accessToken = token.access_token;
    const me = await loginProfile(accessToken);
    lineUserId = me.userId;
    displayName = me.displayName ? String(me.displayName).slice(0, 100) : null;
  } catch (e) {
    return { ok: false, kind: "exchange_failed", reason: e.message };
  } finally {
    if (accessToken) revoke(accessToken);   // 待たない。失敗しても実害が無い
  }

  if (!lineUserId) {
    return { ok: false, kind: "no_user_id", reason: "userId を取得できませんでした" };
  }

  /* 友だち追加が先の人も居るので upsert。既にある人の status は
     触らない（repo/users.mjs の注釈）。 */
  const { user } = await users.upsertOnFollow(conn, { lineUserId, displayName });

  await users.updateName(conn, user.id, {
    nameKanji: pending.name_kanji,
    nameReading: pending.name_reading,
    nameKr: pending.name_kr
  });
  await users.upsertSajuProfile(conn, user.id, {
    birthDate: pending.birth_date,
    birthTime: pending.birth_time,
    gender: pending.gender,
    ohaengMain: pending.ohaeng_main,
    rawResult: pending.raw_result_json
  });

  /* 器も用意しておく。友だち追加が後になる人は、この時点では
     follow イベントが来ていないため。どちらも既にあれば何もしない。 */
  await billing.startTrial(conn, user.id);
  await learning.ensureProgress(conn, user.id);

  /* ---- チャネルの取り違えを、ここで見つける --------------------
     Login で得た userId を Messaging API 側に問い合わせる。

       通る   … 同じプロバイダー。かつ、もう友だちになっている
       404    … 友だちでないか、プロバイダーが別
       403    … 送れない状態（ブロック等）

     プロバイダーが別だと、登録も保存も成功したのに配信だけが
     永久に届かない。しかもエラーはどこにも出ない。ここで一度
     叩いておけば、設置の時点で気づける。 */
  let friend = null;
  try {
    await getProfile(lineUserId);
    friend = true;
  } catch (e) {
    friend = isUnreachable(e) ? false : null;   // null は判定できなかった
  }

  return {
    ok: true,
    userId: user.id,
    lineUserId,
    displayName,
    nameKr: pending.name_kr,
    /* false = まだ友だちでない（追加を促す）。
       ただしプロバイダー違いでも false になるので、
       設置直後にこれが必ず false なら、まずそちらを疑う。 */
    friend
  };
}
