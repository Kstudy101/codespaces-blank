/* ==================================================================
   line.mjs — LINE Messaging API を叩く

     import { pushMessage, replyMessage, getProfile } from './lib/line.mjs';
     await pushMessage(lineUserId, [{ type: 'text', text: 'おはよう' }]);

   SDK（@line/bot-sdk）を入れないのは、使うのが 3 つの REST 呼び出し
   だけで、Node に fetch が入っているため。依存を足すと、検証に
   npm install が要る範囲が広がる（README の「検証は設置なしで走る」）。

   ここは repo/ と違って外へ出ていくので、失敗の扱いが要る:

     429 / 5xx  … 相手の都合。待って掛け直す
     4xx        … こちらの間違い。掛け直しても同じなので即あきらめる

   この区別が無いと、文面の作り間違い（400）で 3 回ずつ叩き直して
   レート制限まで使い切り、その日の配信が全員止まる。
   ================================================================== */
import { loadEnv } from "./env.mjs";

/* 宛先の差し替えは linelogin.mjs と同じ理由（手元で流れを通すため）。
   既定は本物で、本番では設定しない。 */
const API = () => `${process.env.LINE_API_BASE || "https://api.line.me"}/v2/bot`;

/* 掛け直してよい応答。408 は稀だが同じ扱いでよい。 */
const RETRIABLE = new Set([408, 429, 500, 502, 503, 504]);

function token() {
  loadEnv();
  const t = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!t) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
  return t;
}

export class LineApiError extends Error {
  constructor(status, body, endpoint) {
    super(`LINE API ${status} (${endpoint}): ${body}`);
    this.name = "LineApiError";
    this.status = status;
    this.body = body;
    this.retriable = RETRIABLE.has(status);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 待ち時間。1 → 2 → 4 秒。429 で Retry-After が来ていればそれに従う
   ── こちらの決め打ちより相手の言い値の方が正しい。 */
function backoffMs(attempt, res) {
  const after = res && res.headers && res.headers.get("retry-after");
  if (after) {
    const sec = Number(after);
    if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 60_000);
  }
  return 1000 * Math.pow(2, attempt);
}

async function call(endpoint, { method = "POST", body = null, headers = {}, retries = 2 } = {}) {
  const url = `${API()}${endpoint}`;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000)
      });
    } catch (e) {
      /* 通信そのものが失敗（切断・タイムアウト）。相手の都合と同じ扱い。 */
      if (attempt >= retries) throw e;
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }

    const text = await res.text().catch(() => "");
    const err = new LineApiError(res.status, text.slice(0, 500), endpoint);
    if (!err.retriable || attempt >= retries) throw err;
    await sleep(backoffMs(attempt, res));
  }
}

/* ---- 送る ---------------------------------------------------------
   retryKey は LINE 側の重複防止。同じ鍵で二度送っても 1 回しか
   届かないので、こちらの再送が二重配信にならない。UUID を渡す。
   （こちらが受け取る側の重複は webhook.mjs 側の話で、別物） */
export async function pushMessage(to, messages, { retryKey = null } = {}) {
  return call("/message/push", {
    body: { to, messages: Array.isArray(messages) ? messages : [messages] },
    headers: retryKey ? { "X-Line-Retry-Key": retryKey } : {}
  });
}

/* 返信。replyToken は 1 回きり・数十秒で切れる。
   使い回すと 400 が返るが、それは異常ではなく「もう返した」なので、
   呼ぶ側で潰さないよう戻り値は素直に返す。 */
export async function replyMessage(replyToken, messages) {
  return call("/message/reply", {
    body: { replyToken, messages: Array.isArray(messages) ? messages : [messages] },
    /* 返信は時間切れがあるので粘らない。掛け直している間に
       replyToken が切れるだけで、遅れて届くこともない。 */
    retries: 0
  });
}

export async function getProfile(lineUserId) {
  return call(`/profile/${encodeURIComponent(lineUserId)}`, { method: "GET", body: null });
}

/* ブロックされた人・退会した人への push は 403 / 404 になる。
   これは障害ではないので、呼ぶ側が分けて扱えるようにしておく。 */
export function isUnreachable(e) {
  return e instanceof LineApiError && (e.status === 403 || e.status === 404);
}
