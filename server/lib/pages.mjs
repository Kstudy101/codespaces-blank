/* ==================================================================
   pages.mjs — LINE から戻ってきた人が最初に見る画面

   ここだけは JSON ではなく HTML を返す。ブラウザが直接開くため。

   【エスケープ】
   出すのは利用者が入れた名前。占いページで入れた文字がそのまま
   ここまで来るので、必ずエスケープする。しないと、自分の名前に
   <script> を入れた本人の画面で動く（self-XSS）── 直接の被害は
   小さいが、「名前を貼ってください」と言われて貼る手口が成り立つ。
   入口（handlers/link.mjs）で長さを切っているだけでは足りない。

   【自己完結】
   サイト本体（Xserver）とは別ホストなので、page.css は読めない。
   色は index.html のトークンから写した固定値をインラインで置く。
   写しなので、サイト側の色を変えてもここは変わらない ── 変える
   必要が出るほど長く出す画面ではない（数秒で LINE へ戻る）。
   ================================================================== */

import { TRIAL_DAYS } from "./repo/billing.mjs";

/* LINE のトークへ戻る先。決済の成功・キャンセル（handlers/checkout.mjs、
   지시서⑧ §1）もここを読む ── 同じ値を別の名前で二度持たない。
   既に友だちなら 1:1 トークが開く。既定値をコードに置き、設定が空でも
   404 へ落とさない ── ただし**その既定値自体が 404 だった**
   （2026-08-09）。line.me/R/ti/p/@kstudy101 を直打ちしていたが、実際の
   ID は @798oqmjl で、この URL はどこからも開けなかった。ID は変わる
   ので直打ちせず、公式の短縮（lin.ee）を置く。
   同じ値が index.html のバーにもあり、verify-pages が突き合わせる。 */
export const ADD_FRIEND_URL = () =>
  process.env.LINE_ADD_FRIEND_URL || "https://lin.ee/SKZtS5k";

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

const SHELL = (title, body) => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} | 名前で学ぶ韓国語</title>
<style>
  :root { --ink:#2b2118; --sub:#6b5b4a; --bg:#fdfaf5; --line:#e6dccd;
          --accent:#b8342f; --gold:#c8a15a; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.25rem; background:var(--bg); color:var(--ink);
         font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
         line-height:1.8; display:flex; justify-content:center; }
  main { width:100%; max-width:26rem; }
  h1 { font-size:1.25rem; margin:0 0 1rem; letter-spacing:.02em; }
  p { margin:.6rem 0; color:var(--sub); font-size:.95rem; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px;
          padding:1.5rem 1.35rem; }
  .name { color:var(--ink); font-weight:700; }
  .mark { font-size:2rem; line-height:1; margin-bottom:.5rem; }
  .ok .mark { color:var(--gold); }
  .ng .mark { color:var(--accent); }
  a.btn { display:block; text-align:center; margin-top:1.25rem; padding:.85rem 1rem;
          background:#06c755; color:#fff; text-decoration:none; border-radius:10px;
          font-weight:700; }
  a.plain { color:var(--sub); font-size:.85rem; }
  hr { border:0; border-top:1px solid var(--line); margin:1.25rem 0; }
  label { display:block; margin:.75rem 0 .25rem; font-size:.85rem; color:var(--sub); }
  input, select { width:100%; padding:.55rem .65rem; border:1px solid var(--line);
                  border-radius:8px; font-size:1rem; }
  .err { color:var(--accent); font-size:.9rem; }
  .hint { font-size:.8rem; color:var(--sub); }
  button.btn { border:0; cursor:pointer; width:100%; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export function resultPage(r) {
  if (r && r.ok) {
    const nameLine = r.nameKr
      ? `<p>韓国語でのお名前は <span class="name">${escapeHtml(r.nameKr)}</span> です。</p>`
      : "";

    const promise = `
          <p>お選びいただくと、その場で 1 日目がとどきます。</p>
          <p>はじめての方は ${TRIAL_DAYS} 日間、無料でお試しいただけます。</p>`;

    if (r.friend === false) {
      return SHELL("あと一歩", `
        <div class="card ok">
          <div class="mark">◎</div>
          <h1>診断結果を引き継ぎました</h1>
          ${nameLine}
          <hr>
          <p>下のボタンからお友だち追加いただくと、LINE のトークで
             コースをお選びいただけます。</p>${promise}
          <a class="btn" href="${escapeHtml(ADD_FRIEND_URL())}">LINE で友だち追加する</a>
        </div>`);
    }

    return SHELL("連携できました", `
      <div class="card ok">
        <div class="mark">◎</div>
        <h1>連携できました</h1>
        ${nameLine}
        <p>このあと LINE のトークで、コースをお選びいただけます。</p>${promise}
        <a class="btn" href="${escapeHtml(ADD_FRIEND_URL())}">LINE を開く</a>
      </div>`);
  }

  const kind = r && r.kind;

  if (kind === "declined") {
    return SHELL("連携を中止しました", `
      <div class="card">
        <div class="mark">–</div>
        <h1>連携を中止しました</h1>
        <p>診断結果は引き継がれていません。もう一度試すときは、
           占いのページからやり直してください。</p>
      </div>`);
  }

  const expired = kind === "expired" || kind === "bad_state" || kind === "bad_code";

  return SHELL(expired ? "有効期限が切れました" : "うまくいきませんでした", `
    <div class="card ng">
      <div class="mark">×</div>
      <h1>${expired ? "有効期限が切れました" : "うまくいきませんでした"}</h1>
      <p>${expired
          ? "連携用のリンクは 30 分で切れます。お手数ですが、占いのページからもう一度お試しください。"
          : "しばらく時間をおいて、占いのページからもう一度お試しください。"}</p>
      <p>診断結果はまだ引き継がれていません。</p>
    </div>`);
}

/* ---- プロフィール編集（plan-profile）-------------------------------- */

export function profileFormPage({
  nameReading, nameKr, siteUrl, error = null
}) {
  /* 性別・生年月日・出生地は集めない（指示書⑱・登録情報は名前だけ）。
     四柱は既存値のまま。直す道は LINE オンボーディング側。 */
  const errLine = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  const krHint = nameKr
    ? `<p class="hint">現在の韓国語表記: ${escapeHtml(nameKr)}</p>` : "";

  return SHELL("登録情報の変更", `
    <div class="card">
      <h1>登録情報の変更</h1>
      <p>お名前だけ変更できます。変更は LINE のトークにもお知らせします。</p>
      ${errLine}
      <form method="post" action="/profile">
        <label for="name_reading">お名前（かな）</label>
        <input id="name_reading" name="name_reading" maxlength="50"
               value="${escapeHtml(nameReading)}" autocomplete="name" required>
        ${krHint}
        <button class="btn" type="submit">保存する</button>
      </form>
      <p class="hint" style="margin-top:1rem"><a class="plain" href="${escapeHtml(siteUrl)}">サイトへ戻る</a></p>
    </div>`);
}

export function profileDonePage({ addFriendUrl }) {
  const url = addFriendUrl || ADD_FRIEND_URL();
  return SHELL("保存しました", `
    <div class="card ok">
      <div class="mark">◎</div>
      <h1>保存しました</h1>
      <p>LINE のトークにもお知らせしました。</p>
      <a class="btn" href="${escapeHtml(url)}">LINE を開く</a>
    </div>`);
}

export function profileGatePage(kind) {
  const msg = kind === "onboarding_incomplete"
    ? "まだ登録が完了していません。LINE のトークで案内に従ってください。"
    : kind === "auth"
    ? "ログインの有効期限が切れました。もう一度お試しください。"
    : "入力内容を確認してください。";
  return SHELL("変更できません", `
    <div class="card ng">
      <div class="mark">×</div>
      <h1>変更できません</h1>
      <p>${escapeHtml(msg)}</p>
      <a class="btn" href="/profile/start">もう一度ログイン</a>
    </div>`);
}
