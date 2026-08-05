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

const ADD_FRIEND_URL = () =>
  process.env.LINE_ADD_FRIEND_URL || "https://line.me/R/ti/p/@kstudy101";

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
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export function resultPage(r) {
  if (r && r.ok) {
    /* 名前が未確定なら、この行ごと出さない ── 空欄や「あなた」を
       名前の場所に置くと、名前の行そのものが誤りに見える
       （2026-08-05 指示書 §1-C：「null」を画面に出さない）。 */
    const nameLine = r.nameKr
      ? `<p>韓国語でのお名前は <span class="name">${escapeHtml(r.nameKr)}</span> です。</p>`
      : "";

    /* 文面は 2026-08-06 指示書 C2。売り状態と無関係に真である文だけを
       置く ── コース選択は販売ゲートの外（§2）なので、SALES_MODE=closed
       でも「コースをお選びいただけます」は事実。

       「はじめての方は」の条件句は削らない。この画面は再連携でも
       出るので、条件なしに「無料でお試し」と書くと、体験を使い
       終えた人への嘘になる。

       名前・生年月日の確認質問には触れない ── 訊くことが無い人にも
       出る画面なので、書けば 7-6 の嘘の警告を作り直すことになる。 */
    const promise = `
          <p>お選びいただくと、その場で 1 日目がとどきます。</p>
          <p>はじめての方は ${TRIAL_DAYS} 日間、無料でお試しいただけます。</p>`;

    if (r.friend === false) {
      /* 引き継ぎは終わっているが、まだ友だちではない。
         もう一歩あることを隠さない ── 「完了しました」とだけ出して
         何も届かないと、こちらの不具合に見える。 */
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

  /* 期限切れ・使用済み・形が違う state。どれも同じ言い方にする。
     どこで弾かれたかを伝えると、state を総当たりする側の手がかりになる。 */
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
