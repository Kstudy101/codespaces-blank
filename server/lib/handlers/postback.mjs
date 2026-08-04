/* ==================================================================
   handlers/postback.mjs — ボタンが押された

   受けるのは 4 つ。

     action=quiz&day=30&choice=2     節目のクイズ（計画書 5-4）
     action=name&use=web|line        どちらの名前で呼ぶか
     action=birth&ok=1|0             生年月日が本人のものか
     action=track&pick=beginner…     コース

   data は利用者の端末を経由して戻ってくる文字列で、こちらが
   送ったものがそのまま返る保証は無い（作り替えられる）。
   正解番号を data に入れてはいけない ── 入れると、押す前に
   書き換えれば必ず正解になる。正答は必ずサーバー側で引く。

   同じ理由で、track も pick の値をそのまま DB へ入れない。
   repo/learning.mjs の setTrack が ENUM の 3 つと突き合わせる ──
   ENUM に無い値を MySQL へ渡すと、設定によっては例外ではなく
   空文字が入り、その人だけ配信対象から静かに外れる。

   【押したあと、次を続けて訊く】
   1 つ答えたら、その場で次の段を返す。返さないと、答えたのに
   何も起きていないように見えて、次のボタンは翌朝まで来ない。
   段そのものは lib/onboarding.mjs が中身から導く（列で持たない）。
   ================================================================== */
import { users, learning } from "../repo/index.mjs";
import { replyMessage } from "../line.mjs";
import {
  nextStep, messageForStep,
  nameRedo, birthRedo, trackChosen, trackAlready
} from "../onboarding.mjs";

/* "a=1&b=2" を読む。URLSearchParams を使うのは、
   自前で split すると値に & や = が入ったときに崩れるため。 */
export function parsePostbackData(data) {
  if (typeof data !== "string" || !data) return { action: null, params: {} };
  const q = new URLSearchParams(data);
  const params = Object.fromEntries(q.entries());
  /* 先頭が "action" か、キー無しの 1 語目を action と見なす。
     "quiz&day=30" のような書き方も受けたいので両対応。 */
  const action = params.action || data.split("&")[0].split("=")[0] || null;
  return { action, params };
}

const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/* オンボーディングの判定に要る 3 つの表を 1 つの形にまとめる。
   listDeliverable が返す行と同じ形にしてあるので、nextStep は
   バッチから呼んでも、ここから呼んでも同じものを見る ──
   別の形にすると、片方でだけ段が進む。

   【users も引き直す。渡された行を使わない】
   受け取るのは id だけにしてある。呼ぶ側が持っている user は
   ボタンを処理する**前**に引いたもので、name_source はまだ空。
   それを ...user で広げると、setNameSource が書いたばかりの値が
   古い値で上書きされ、nextStep が「まだ名前を訊いていない」と
   判定する ── 答えた直後に、答えたのと同じ質問がもう一度届く。

   saju と progress を引き直しているのに users だけ渡していたので、
   生年月日とコースは進むのに名前だけ進まない、という形で出ていた。
   handlers/link.mjs の completeLink は同じ理由で findById を
   挟み直している（あちらの注記）。 */
async function stateOf(conn, userId) {
  const [user, saju, prog] = await Promise.all([
    users.findById(conn, userId),
    users.getSajuProfile(conn, userId),
    learning.getProgress(conn, userId)
  ]);
  if (!user) return null;
  return {
    ...user,
    birth_date: saju ? saju.birth_date : null,
    birth_time: saju ? saju.birth_time : null,
    birth_confirmed: saju ? saju.birth_confirmed : false,
    track: prog ? prog.track : null
  };
}

/* 答えたあとに続けて出す 1 通。もう訊くことが無ければ null。 */
async function followUp(conn, userId) {
  const st = await stateOf(conn, userId);
  if (!st) return null;
  const step = nextStep(st);
  return step ? messageForStep(step, st) : null;
}

/* 返信は失敗しても処理そのものは成立させる。ここで throw すると
   LINE が webhook を失敗とみなして掛け直し、同じボタンの処理が
   何度も走る（handlers/follow.mjs と同じ理由）。 */
async function reply(replyToken, messages, send) {
  const list = messages.filter(Boolean);
  if (!replyToken || !list.length) return false;
  try {
    await send(replyToken, list);
    return true;
  } catch {
    return false;
  }
}


export async function handlePostback(conn, event, { send = replyMessage } = {}) {
  const lineUserId = event?.source?.userId;
  if (!lineUserId) return { skipped: "userId がありません" };

  const { action, params } = parsePostbackData(event?.postback?.data);
  const user = await users.findByLineUserId(conn, lineUserId);
  if (!user) return { skipped: "未登録の利用者です", lineUserId };

  const token = event?.replyToken;

  /* ---- 名前 ------------------------------------------------------ */
  if (action === "name") {
    const use = params.use;
    if (use !== "web" && use !== "line") {
      return { skipped: `name の use が読めません: ${use}`, userId: user.id };
    }

    await users.setNameSource(conn, user.id, use);

    if (use === "line") {
      /* ハングル表記はサイトでしか作れない（lib/onboarding.mjs の
         注記）。今ある名前は本人が選ばなかったものなので消す ──
         残すと、案内を無視した人にその名前で 101 日ぶんが届く。
         消すと render.mjs が名前案内へ切り替わるので、分岐は増えない。 */
      await users.updateName(conn, user.id,
        { nameKanji: null, nameReading: null, nameKr: null });
      const replied = await reply(token, [nameRedo()], send);
      return { userId: user.id, action, use, replied };
    }

    const replied = await reply(token, [await followUp(conn, user.id)], send);
    return { userId: user.id, action, use, replied };
  }

  /* ---- 生年月日 --------------------------------------------------- */
  if (action === "birth") {
    /* "ok=1" 以外はすべて「入れ直す」。ok が欠けている・読めない
       ときに確認済みを立てないのは、確認は立てる側に寄せると
       間違いが「本人が確かめた」として残るため。 */
    const ok = params.ok === "1";

    if (!ok) {
      const replied = await reply(token, [birthRedo()], send);
      return { userId: user.id, action, ok, replied };
    }

    await users.setBirthConfirmed(conn, user.id, true);
    const replied = await reply(token, [await followUp(conn, user.id)], send);
    return { userId: user.id, action, ok, replied };
  }

  /* ---- コース ----------------------------------------------------- */
  if (action === "track") {
    const pick = params.pick;
    if (!learning.isTrack(pick)) {
      return { skipped: `未知の track: ${pick}`, userId: user.id };
    }

    /* setTrack は track IS NULL のときだけ書き換える。
       二度目のボタン（連打・古い画面をさかのぼって押した）は
       claimed=false で戻るので、既にあるコースをそのまま伝える。 */
    const { claimed } = await learning.setTrack(conn, user.id, pick);
    if (!claimed) {
      const prog = await learning.getProgress(conn, user.id);
      const replied = await reply(token, [trackAlready(prog?.track || pick)], send);
      return { userId: user.id, action, pick, claimed, replied };
    }

    const replied = await reply(token, [trackChosen(pick)], send);
    return { userId: user.id, action, pick, claimed, replied };
  }

  /* ---- クイズ ----------------------------------------------------- */
  if (action !== "quiz") {
    /* 知らない action は捨てるが、握りつぶしたことは返す。
       ボタンを足したのにハンドラを足し忘れた、が静かに起きるため。 */
    return { skipped: `未対応の action: ${action}`, userId: user.id };
  }

  const day = int(params.day);
  const choice = int(params.choice);
  if (day === null || choice === null) {
    return { skipped: "day / choice が読めません", userId: user.id, data: event?.postback?.data };
  }

  /* 節目の日でなければ採点しない。data は書き換えられるので、
     「30 日目のクイズ」と名乗られてもこちらの表で確かめる。 */
  if (!(await learning.isCheckpoint(conn, day))) {
    return { skipped: `${day} 日目は節目ではありません`, userId: user.id };
  }

  const semester = learning.semesterForDay(day);

  /* 正答はサーバー側にしか無い。コースごとに原稿が違うので、
     その人のコースで引く ── 引かずに初級で採点すると、
     中級の人が自分の受け取った問題と違う答えで採点される。 */
  const prog = await learning.getProgress(conn, user.id);
  if (!prog || !prog.track) {
    return { skipped: "コース未選択です", userId: user.id, day };
  }

  const answer = await lookupAnswer(conn, prog.track, day);
  if (answer === null) {
    return { pending: "正答が未入稿です（P4）", userId: user.id, day, semester, choice };
  }

  const passed = choice === answer;
  await learning.setQuizResult(conn, user.id, semester, passed);
  return { userId: user.id, day, semester, choice, passed };
}

/* 正答の置き場所は P4 の入稿設計で決まる（content_templates の
   どこに持たせるか）。決まるまでは null を返し、
   「採点できない」を呼ぶ側に伝える。 */
async function lookupAnswer(conn, track, day) {
  const tpl = await learning.getTemplate(conn, track, day);
  if (!tpl) return null;
  const q = tpl.quiz || null;
  if (!q || typeof q.answer !== "number") return null;
  return q.answer;
}
