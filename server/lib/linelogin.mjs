/* ==================================================================
   linelogin.mjs — LINE Login (OAuth 2.0)

     import { authorizeUrl, exchangeCode, loginProfile } from './lib/linelogin.mjs';

   Messaging API（lib/line.mjs）とは別のチャネル・別のシークレット。
   env も分けてある:

     LINE_CHANNEL_SECRET          … Messaging API（webhook の署名）
     LINE_LOGIN_CHANNEL_SECRET    … Login（ここ）

   ★★★ いちばん大事な前提 ★★★

   Login チャネルと Messaging API チャネルが LINE Developers の
   「同じプロバイダー」に属していないと、返ってくる userId が別物になる。
   別プロバイダーの userId で push を送っても届かない ── しかも
   登録は成功し、DB にも行が入り、エラーも出ない。配信が始まる朝まで
   誰も気づけない。

   起きていないことをこちらから確かめる手立てが 1 つある。Login で
   得た userId を Messaging API 側の getProfile に渡してみること。
   同じプロバイダーなら（かつ友だちなら）通り、別物なら 404 になる。
   handlers/link.mjs がリンク完了時にそれをやっている。
   ================================================================== */
import { loadEnv, requireEnv } from "./env.mjs";

/* 宛先を環境変数で差し替えられるようにしてある。既定は本物。
   差し替えるのは手元で流れを通すときだけで、本番では設定しない
   ── 設定されていたら、それは事故なので起動時に落とす（app.mjs）。 */
const authBase = () => process.env.LINE_AUTH_BASE || "https://access.line.me";
const apiBase  = () => process.env.LINE_API_BASE  || "https://api.line.me";

const AUTHORIZE = () => `${authBase()}/oauth2/v2.1/authorize`;
const TOKEN     = () => `${apiBase()}/oauth2/v2.1/token`;
const PROFILE   = () => `${apiBase()}/v2/profile`;

function loginConfig() {
  loadEnv();
  return requireEnv([
    "LINE_LOGIN_CHANNEL_ID",
    "LINE_LOGIN_CHANNEL_SECRET",
    "LINE_LOGIN_REDIRECT_URI"
  ]);
}

/* 認証画面へ送る URL。
   scope は profile だけ。openid を足すと id_token が付いてくるが、
   userId は profile で取れるので要らない ── 使わない情報を
   要求すると、同意画面の項目が増えて離脱が増える。 */
/* botPrompt（友だち追加オプション・LINE Login v2.1）

   LINE Login は「誰か」を教えるだけで、**友だちにはしない**。この 2 つは
   別物で、友だちでなければこちらからは 1 通も送れない ── 連携は済んで
   いるのに何も届かない人が、こちらの台帳にだけ残る。

   これまでは連携完了ページの「LINE で友だち追加する」ボタン 1 つに
   頼っていた（lib/pages.mjs）。押さずに閉じればそこで終わりで、
   しかもそのボタンの URL は 2026-08-09 まで 404 だった。

   aggressive は同意画面の**あと**に専用の追加画面を出す。normal は
   同意画面の中の項目になる。前者を使う ── 項目は読み飛ばされる。

   ★ Login チャネルに Official Account が紐づいていないと無視される
     （LINE Developers → Login チャネル → Linked LINE Official Account）。 */
export function authorizeUrl(state, { prompt = null, botPrompt = null } = {}) {
  const cfg = loginConfig();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.LINE_LOGIN_CHANNEL_ID,
    redirect_uri: cfg.LINE_LOGIN_REDIRECT_URI,
    state,
    scope: "profile"
  });
  if (prompt) q.set("prompt", prompt);
  if (botPrompt) q.set("bot_prompt", botPrompt);
  return `${AUTHORIZE()}?${q.toString()}`;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE Login ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/* 認可コードをアクセストークンに替える。
   ここはサーバー側でしか呼べない（シークレットが要る）。
   redirect_uri は認証画面へ渡したものと 1 文字でも違うと
   invalid_grant になる ── 末尾のスラッシュでよく食い違う。 */
export async function exchangeCode(code) {
  const cfg = loginConfig();
  return postForm(TOKEN(), {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.LINE_LOGIN_REDIRECT_URI,
    client_id: cfg.LINE_LOGIN_CHANNEL_ID,
    client_secret: cfg.LINE_LOGIN_CHANNEL_SECRET
  });
}

/* userId を得る。id_token（JWT）からも取れるが、そちらは署名検証が
   要る。こちらは自分で張った TLS 接続で、自分のアクセストークンを
   添えて聞くので、検証すべき第三者が居ない ── 部品が少ない方を採る。 */
export async function loginProfile(accessToken) {
  const res = await fetch(PROFILE(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE profile ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/* 使い終わったアクセストークンは捨てる。こちらは userId が
   分かればよく、以降このトークンで何かする予定が無い。
   失敗しても実害が無いので投げない。 */
export async function revoke(accessToken) {
  try {
    const cfg = loginConfig();
    await postForm(`${apiBase()}/oauth2/v2.1/revoke`, {
      access_token: accessToken,
      client_id: cfg.LINE_LOGIN_CHANNEL_ID,
      client_secret: cfg.LINE_LOGIN_CHANNEL_SECRET
    });
    return true;
  } catch {
    return false;
  }
}
