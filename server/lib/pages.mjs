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
    const name = r.nameKr ? `<span class="name">${escapeHtml(r.nameKr)}</span>` : "あなた";

    if (r.friend === false) {
      /* 引き継ぎは終わっているが、まだ友だちではない。
         もう一歩あることを隠さない ── 「完了しました」とだけ出して
         何も届かないと、こちらの不具合に見える。 */
      return SHELL("あと一歩", `
        <div class="card ok">
          <div class="mark">◎</div>
          <h1>診断結果を引き継ぎました</h1>
          <p>韓国語での名前は ${name} です。</p>
          <hr>
          <p><strong>あと一歩です。</strong>下のボタンから友だち追加すると、
             翌朝 7 時から 3 日間の無料体験がはじまります。</p>
          <a class="btn" href="${escapeHtml(ADD_FRIEND_URL())}">LINE で友だち追加する</a>
        </div>`);
    }

    return SHELL("連携が完了しました", `
      <div class="card ok">
        <div class="mark">◎</div>
        <h1>連携が完了しました</h1>
        <p>韓国語での名前は ${name} です。</p>
        <p>明日の朝 7 時から、${name} 専用の韓国語が LINE に届きます。
           まずは 3 日間の無料体験です。</p>
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
