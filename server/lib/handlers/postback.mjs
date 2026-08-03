/* ==================================================================
   handlers/postback.mjs — ボタンが押された

   計画書 5-4 のクイズ採点。Flex Message のボタンに data を持たせ、
   押されるとその data が postback として返ってくる。

     data: "quiz&day=30&choice=2"

   data は利用者の端末を経由して戻ってくる文字列で、こちらが
   送ったものがそのまま返る保証は無い（作り替えられる）。
   正解番号を data に入れてはいけない ── 入れると、押す前に
   書き換えれば必ず正解になる。正答は必ずサーバー側で引く。

   採点そのもの（どの選択肢が正解か）は原稿と一緒に持つべきもので、
   P4 の入稿と P8 で決まる。ここでは data の読み取りと、
   採点結果を進捗に書くところまでを用意する。
   ================================================================== */
import { users, learning } from "../repo/index.mjs";

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

export async function handlePostback(conn, event) {
  const lineUserId = event?.source?.userId;
  if (!lineUserId) return { skipped: "userId がありません" };

  const { action, params } = parsePostbackData(event?.postback?.data);
  const user = await users.findByLineUserId(conn, lineUserId);
  if (!user) return { skipped: "未登録の利用者です", lineUserId };

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

  /* 正答はサーバー側にしか無い。P4 の入稿でクイズの正答を
     content_templates に持たせるまで、ここは採点できない。
     採点できないことを skipped として返し、黙って
     「不正解」にはしない ── 押した人には理由が分からないので。 */
  const answer = await lookupAnswer(conn, day);
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
async function lookupAnswer(conn, day) {
  const tpl = await learning.getTemplate(conn, day);
  if (!tpl) return null;
  const q = tpl.quiz || null;
  if (!q || typeof q.answer !== "number") return null;
  return q.answer;
}
