/* ==================================================================
   handlers/checkout.mjs — 受講料を見せる・買う・受け取る

   リッチメニューの［受講料］から、決済が終わって 1 日目が届くまで。

     ① action=plans                 コースを選ぶ
     ② action=plan&track=…          価格表（＝最終確認画面）
     ③ action=buy&track=…&pkg=…     Stripe の決済ページへ
     ④ action=trial&track=…         体験 3 日（1 アカウント 1 回）
     ⑤ POST /stripe/webhook         入金 → 日数を積む → 即 1 日目
     ⑥ action=resume&track=…&mode=… 買い直した人の「続き / 最初から」

   【★ 表示が足りないまま売らないための門】
   有料で売るには、特定商取引法に基づく表記のページと、決済直前に
   読める価格・提供時期・返金の記載が要る（docs/plan-billing.md §7）。
   これはコードでは埋められない ── 事業者名・住所・電話番号は
   こちらが知らないし、返金規定も決めごとだから。

   なので **設定が揃うまで決済の口を開けない**。index.html の
   LINE_LINK_API が空のあいだカードを出さなかったのと同じやり方で、
   ここは環境変数が欠けていれば価格表そのものを出さない。

     TOKUSHOHO_URL   特定商取引法に基づく表記の URL
     REFUND_POLICY   返金の 1 行（価格表に出す）

   埋まっていなければ、押した人には「準備中」と返し、こちらの
   ログには何が足りないかを名前で出す。黙って売れてしまうより、
   売れないほうがよい。
   ================================================================== */
import { users, billing, learning, pushlogs, entitlements, lapses } from "../repo/index.mjs";
import { PACKAGES, TRIAL_DAYS, TRIAL_UPSELL_DAY } from "../repo/billing.mjs";
import { TRACKS, TRACK_LABELS, TOTAL_DAYS, isTrack } from "../repo/learning.mjs";
import { createCheckoutSession } from "../stripe.mjs";
import { pushMessage, replyMessage, isUnreachable } from "../line.mjs";
import { jstDateTime } from "../jst.mjs";

/* 決済のあとの戻り先はどちらも LINE のトーク（지시서⑧ §1）。
   以前は success が `${SITE_URL}/thanks` ── **存在しないページ**で、
   払った直後に 404。「お金は出たのにエラー画面」に見える、いちばん
   不安な瞬間の画面だった。cancel も사이트 홈이 아니라 토크로 ──
   그 자리에서 [受講料]를 다시 누를 수 있다. 값은 pages.mjs 의
   ADD_FRIEND_URL 한 곳에서 읽는다（既定値つき）。 */
import { ADD_FRIEND_URL } from "../pages.mjs";

/* ---- 門 ------------------------------------------------------------
   足りないものを名前で返す。1 つ目で止めないのは env.mjs と同じ理由 ──
   直して走らせて次で止まる、を繰り返すことになる。 */
export function missingLegalConfig() {
  const missing = [];
  if (!process.env.TOKUSHOHO_URL) missing.push("TOKUSHOHO_URL（特定商取引法に基づく表記の URL）");
  if (!process.env.REFUND_POLICY) missing.push("REFUND_POLICY（返金規定の 1 行）");
  if (!process.env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  return missing;
}

export function salesOpen() {
  return missingLegalConfig().length === 0;
}

/* ---- 販売の露出モード（2026-08-05 指示書 §1-1）----------------------
   法定表示 4 つ（salesOpen）は**必要条件のまま**で、その上にモードを
   重ねる。分ける理由: Stripe のテスト鍵を入れた瞬間に salesOpen が
   開き、実利用者に価格表と決済リンクが出てしまう ── テストモードは
   実カードを拒むので、利用者は決済失敗を経験する。「準備中」より悪い。

     closed … 全員に「準備中」（既定。値が無い・読めない時もこちら）
     test   … SALES_TEST_USERS（コンマ区切り）に載る人だけ通す。
              users.id でも line_user_id でもよい ── 画面で見える方を
              そのまま貼れるように両方で引き当てる
     open   … 全員

   既定を closed にするのは、書き忘れ・綴り間違いが「売れてしまう」
   側に倒れないため。 */
export function salesMode() {
  const m = String(process.env.SALES_MODE || "closed").trim().toLowerCase();
  return ["closed", "test", "open"].includes(m) ? m : "closed";
}

export function salesAllowedFor(user) {
  if (!salesOpen()) return false;          /* 法定表示は常に必要条件 */
  const mode = salesMode();
  if (mode === "open") return true;
  if (mode !== "test") return false;
  const list = String(process.env.SALES_TEST_USERS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(String(user?.id)) || list.includes(String(user?.line_user_id));
}

const notReady = () => ({
  type: "text",
  text: [
    "ただいま準備中です。",
    "受講のお申し込みは、もうしばらくお待ちください。"
  ].join("\n")
});

/* コースはあるが、売れるパッケージが 1 つも無い（原稿が最小の
   パッケージ日数に満たない）。全体の「準備中」と分けるのは、
   他のコースは買える状態がありうるため。 */
export const coursePreparing = (track) => ({
  type: "text",
  text: `${TRACK_LABELS[track].ja}（${TRACK_LABELS[track].kr}）は、ただいま準備中です。\nもうしばらくお待ちください。`
});

/* 露出できるパッケージ（原稿の保有日数が上限）。priceList と
   体験 2 日目の夕方の勧誘（db/push-evening.mjs）が**同じ判定**を見る ──
   別々に書くと、片方だけ直した日に「買えないのに『追加できます』」が
   出る（押した先は coursePreparing）。 */
export const sellablePackages = (availableDays) =>
  Object.entries(PACKAGES).filter(([, p]) => p.days <= availableDays);

/* 価格表を出せるコース（지시서⑯ §4）。絞らないと、原稿 3 日ぶんの
   中級を選ばせてから価格表で「準備中」になる ── 押した人には理由が
   無く、尋ねる方法も無い。

   入口は 2 つある（リッチメニューの postback と、「受講料」と打つ道）。
   両方がこの 1 つを通る ── 同じ問いに式を 2 本持つと、売れる日数を
   変えた日に片方だけ古くなる。物差しは上の sellablePackages のまま。

   受講中でも外さない（§4-2）── 追加購入が起きるのは、まさに受講中の
   コースで残りが減ったときだから。除く理由は「原稿不足」だけにする。 */
export async function sellableTracks(conn) {
  const out = [];
  for (const t of TRACKS) {
    if (sellablePackages(await learning.countTemplates(conn, t)).length) out.push(t);
  }
  return out;
}

/* ---- 体験の終わり前日（TRIAL_UPSELL_DAY）の夕方の勧誘（2026-08-06 指示書 C4）--
   体験中・current_day = TRIAL_UPSELL_DAY の人へ、復習の後ろに 1 通。
   販売が閉じていても送る ── ただし文面を分ける。「買える」は

     salesAllowedFor(user) かつ sellablePackages ≥ 1

   の**両方**。後者を落とすと、販売が開いていても原稿 3 日ぶんの
   コースで「下から追加できます」が出て、押した先で「準備中」になる。

   買えない側の文面は「どこを見ればよいか」だけを言い、
   「整いましたらお知らせします」とは**書かない** ── 販売が開いた日に
   待っている人へ知らせる機能はコードに無い。約束した瞬間、文書が
   コードより先へ出る（この置き場が 4 回踏んだ形）。 */
export function trialUpsellNotice(track, {
  canBuy = false,
  currentDay = TRIAL_UPSELL_DAY
} = {}) {
  const l = TRACK_LABELS[track];
  const head = [
    `無料でお試しいただける ${TRIAL_DAYS} 日分のうち、明日が最後の 1 日です。`,
    "",
    `${l.ja}（${l.kr}）は ${currentDay} 日目まで進みました。`,
    ""
  ];
  if (!canBuy) {
    /* quickReply は付けない。押す所が無ければ空振りも無い。 */
    return {
      type: "text",
      text: [...head,
        "続きの受講料のご案内は、ただいま準備中です。",
        "準備が整いましたら、下のメニューの［受講料］からご確認いただけます。"
      ].join("\n")
    };
  }
  return {
    type: "text",
    text: [...head,
      "続けてお受け取りになる場合は、下から日数を追加できます。",
      "追加された日数は、いまの続きに足されます。"
    ].join("\n"),
    quickReply: { items: [{
      type: "action",
      action: { type: "postback", label: "受講料を見る",
                data: `action=plan&track=${track}`, displayText: "受講料を見る" }
    }] }
  };
}

/* ---- 残り 0 になった朝の、再購入のご案内（指示書 §3）----------------
   離脱のエピソードにつき 1 回だけ ── 毎朝の判定で残り 0 には毎日
   出会うので、条件なしに送ると毎日スパムになる。1 回だけの判定は
   lapse_log が新しく開いたかどうか（repo/lapses.mjs openIfAbsent の
   created）に載せる。呼ぶのは db/push-daily.mjs。 */
export function upsellNotice(track, { lastDay = 0 } = {}) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}）は ${lastDay} 日目まで進みました。`,
      "お持ちの日数を使い切ったため、お届けをいったんお休みしています。",
      "",
      "日数を追加されると、続きからそのままお届けします。",
      "進んだところが消えることはありません。"
    ].join("\n"),
    quickReply: { items: [{
      type: "action",
      action: { type: "postback", label: "受講料を見る",
                data: "action=plans", displayText: "受講料を見る" }
    }] }
  };
}


/* ---- ① コースを選ぶ ------------------------------------------------- */

/* pick を渡すとオンボーディングのコース選択になる（plan-course-onboarding
   §2）── 文面（コースの説明）は共有し、**ボタンの data だけ**を
   trackpick に替える。写しを持つと、説明を直した日に選択画面だけ
   古くなる。pick.tracks は原稿が体験日数ぶんあるコースだけ（§4-나）。

   「あとから変更できません」の 1 行は両方に出す（문면 §7-나 확정）──
   買うときも選ぶときも、コースを替える唯一の道は追加購入で同じ。 */
/* 【only】価格表の入口（plans）が「売れるコースだけ」に絞るための口。
   pick とは別にする ── pick は文面もボタンの data も trackpick 用に
   替えてしまうので、絞り込みに借りると「受講料を見る」が
   「このコースで始める」に化ける（지시서⑯ §4）。 */
export function askCourse({ owned = [], pick = null, only = null } = {}) {
  /* 既に持っているコースには印を付ける。付けないと、買ったことを
     忘れて同じコースをもう一度買う ── 返金の手間になる。 */
  const mark = (t) => (owned.includes(t) ? "（受講中）" : "");
  const DESC = {
    beginner:     "ハングルの読み書きから。韓国語がはじめての方（TOPIK 0~2級レベル）",
    intermediate: "文と文をつなぐ・敬語。あいさつができる方（TOPIK 3~4級レベル）",
    advanced:     "書き言葉・ニュースの韓国語。日常会話に困らない方（TOPIK 5~6級レベル）"
  };
  /* 3 つを目で分ける印。文字だけだと、どこで 1 つのコースが終わって
     次が始まるのか読まないと分からない（대표 지적 2026-08-09）。 */
  const BULLET = { beginner: "🟢", intermediate: "🟡", advanced: "🔴" };
  const list = pick ? pick.tracks : (only || TRACKS);
  return {
    type: "text",
    text: [
      /* 選ぶときと、受講料を見るときで頭が違う。「明日の朝 7 時から届く」は
         選んだ人にしか起きないので、価格表の入口では言わない（대표 확정
         2026-08-09）。 */
      pick
        ? [
            "📚 最後の 1 ステップ！ご希望のコースをお選びください。",
            "（마지막 1단계! 희망하는 코스를 선택 해 주세요.）",
            "",
            /* 1 日目は選んだその場で届く（trackStarted と postback の
               体験開始）。「明日の朝から」と書くと、いま届いた 1 日目を
               読み飛ばす ── 2 つの文面が食い違わないようにする。 */
            "このあとすぐ「1日目」、明日からは毎朝7時にお届けします 💌",
            "お楽しみください。화이팅^^ 간바레~!"
          ].join("\n")
        : "どのコースの受講料をご覧になりますか？",
      ...list.flatMap((t) => [
        "",
        `${BULLET[t]} ${TRACK_LABELS[t].ja}（${TRACK_LABELS[t].kr}）${mark(t)}`,
        DESC[t]
      ])
      /* 【2026-08-09 대표 확정】選ぶ前の断り 3 行（無料体験は 1 回まで /
         取り替え不可 / ［내 진도］で行き来）はここから外した。
         いま同じことがどこに残るか（消えたものを見失わないため）:

           無料体験 1 回 … handlers/postback.mjs（2 度目を試した**あと**）
           行き来        … checkout.mjs の受講中案内
           取り替え不可  … **どこにも無い**

         戻すときは verify-onboarding の同じ検査も一緒に戻すこと。 */
    ].join("\n"),
    quickReply: {
      items: list.map((t) => ({
        type: "action",
        action: {
          type: "postback",
          label: `${TRACK_LABELS[t].ja}（${TRACK_LABELS[t].kr}）`.slice(0, 20),
          data: pick ? `action=trackpick&track=${t}` : `action=plan&track=${t}`,
          displayText: pick
            ? `${TRACK_LABELS[t].ja} で始めます`
            : `${TRACK_LABELS[t].ja} の受講料を見ます`
        }
      }))
    }
  };
}


/* ---- ② 価格表 ＝ 最終確認画面 ---------------------------------------
   決済の直前に読める所へ、法が求める項目を置く。前払いの回数券なので
   「更新周期」「解約方法」は無い（自動更新しないため）。要るのは:

     分量・総額（税込）・支払時期・提供時期・返金・事業者の表記

   これを別のウェブページに置く案もあったが、LINE の中で完結する
   ほうが取りこぼしが無い ── 押す直前の画面がこれになる。

   体験を使っていない人には、価格表と一緒に体験の入口も出す。
   出さないと、試さずに払うか、払わずに去るかの二択になる。 */
/* 【1 タップで決済へ（지시서⑦）】
   購入ボタンは postback ではなく **uri** ── 決済ページの URL を
   ボタンに直接乗せ、タップひとつで Stripe の画面が開く。以前は
   postback → 長い生 URL を返信 → もう 1 タップ、で、お金を出す直前に
   チャットで届く見知らぬ長文 URL はフィッシングと見分けがつかなかった。

   URL は**呼ぶ側**（postback.mjs の plan 分岐）が Stripe で先に作って
   checkoutUrls で渡す。この関数の中で Stripe を呼ばない ── ここが
   同期・純粋のままなので、関門 19 種がネットワーク無しで回る。

   uri アクションに displayText は無い（LINE の仕様）。「〜を申し込み
   ます」の吹き出しが消えるのは意図どおり ── あの吹き出し自体が
   「もう 1 段ある」の合図だった。 */
export function priceList(track,
  { trialAvailable = false, availableDays = TOTAL_DAYS, checkoutUrls = {} } = {}) {
  const l = TRACK_LABELS[track];

  /* 原稿の保有日数を超えるパッケージは出さない（指示書 §1-2）。
     中級 30 日ぶんの原稿で 101 日を売ると、31 日目から「原稿なし」で
     **黙って**止まる ── 売った側は気づかず、買った側だけが知る。
     原稿を増やせば、この絞り込みが自動で上のパッケージを開く。 */
  const sellable = sellablePackages(availableDays);
  if (!sellable.length) return null;   /* 呼ぶ側が「準備中」を出す */

  const rows = sellable
    .map(([key, p]) => `・${String(p.days).padStart(3)} 日分　${p.price.toLocaleString()} 円（税込）`);

  const items = sellable.map(([key, p]) => ({
    type: "action",
    action: {
      type: "uri",
      label: `${p.days}日 ${p.price.toLocaleString()}円`.slice(0, 20),
      uri: checkoutUrls[key]
    }
  }));

  /* quickReply は 13 個まで。パッケージ 5 + 体験 1 で収まる。 */
  if (trialAvailable) {
    items.unshift({
      type: "action",
      action: {
        type: "postback",
        label: `まず${TRIAL_DAYS}日ためす（無料）`.slice(0, 20),
        data: `action=trial&track=${track}`,
        displayText: `${TRACK_LABELS[track].ja} を無料でためします`
      }
    });
  }

  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}） 受講料`,
      "",
      ...rows,
      "",
      `全 ${TOTAL_DAYS} 日で1つの講座です。`,
      "",
      "──────────",
      "お支払い:　クレジットカード（申込時に1回）",
      "　　　　　自動更新はありません",
      "サービス開始　:　ご入金後すぐ",
      "　　　　　翌日から毎朝7時＋毎夕6時",
      `返金　　:　${process.env.REFUND_POLICY || ""}`,
      "",
      `販売者の表記:　${process.env.TOKUSHOHO_URL || ""}`,
      "",
      /* 有効期限の案内は checkoutLink() からここへ移した（지시서⑦
         §2-6）── ボタンの先が Stripe の期限切れ画面だったとき、
         何をすればよいかが無いと詰む。文面은 대표 확정 대상（후보 1）。 */
      "※ お支払いのご案内は一定時間で期限切れになります。",
      "　 期限切れの画面が出たときは、もう一度［受講料］からお試しください。"
    ].join("\n"),
    quickReply: { items: items.slice(0, 13) }
  };
}


/* ---- ③ 買う --------------------------------------------------------- */

export async function startCheckout(conn, user, { track, packageType }) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };
  const pkg = PACKAGES[packageType];
  if (!pkg) return { ok: false, reason: `未知の package: ${packageType}` };

  const session = await createCheckoutSession({
    userId: user.id,
    track, packageType,
    days: pkg.days, price: pkg.price,
    productName: `${TRACK_LABELS[track].ja}（${TRACK_LABELS[track].kr}） ${pkg.days}日分`,
    successUrl: ADD_FRIEND_URL(),
    cancelUrl: ADD_FRIEND_URL(),
    /* 参照用（ダッシュボードで誰の何かを並べて見る）。重複防止では
       ない ── それは purchases.payment_ref の UNIQUE の仕事。 */
    clientRef: `u${user.id}-${track}-${packageType}`
  });

  return { ok: true, url: session.url, sessionId: session.id };
}

/* ★ 지시서⑦（1 タップ化）以後、新しい価格表からは使われない経路。
   価格表のボタンが uri になり、buy postback もこの返信も新規には
   発生しない。残すのは、既に送った古い価格表のボタンが押されたとき
   無反応にしないため ── 除去予定日 = **2026-09-06**（古い quickReply
   ボタンは次のメッセージ到着で押せなくなるので、毎朝の配信がある限り
   実質数日で死ぬ。1 か月は余裕側）。予定日が来たら buy 分岐
   （postback.mjs）とこの関数を一緒に消すこと。 */
export function checkoutLink(track, packageType, url) {
  const l = TRACK_LABELS[track], p = PACKAGES[packageType];
  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}） ${p.days}日分　${p.price.toLocaleString()} 円（税込）`,
      "",
      "下のリンクからお支払いください。",
      "カード番号は決済会社の画面で入力され、当方には届きません。",
      "",
      url,
      "",
      "※ このリンクは一定時間で使えなくなります。",
      " 切れていたら、もう一度［受講料］からお試しください。"
    ].join("\n")
  };
}


/* ---- ④ 体験 ---------------------------------------------------------
   1 アカウント 1 回だけ。コース別にすると、コースを変えるだけで
   3 コース ×3 日 = 9 日を無料で受け取れる（repo/billing.mjs）。 */
export async function startTrialFor(conn, user, track,
  { transact = (fn) => fn(conn) } = {}) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };

  /* subscriptions と grant を 1 つに（creditFromStripe と同じ理由）。
     半分だけ成功すると subscriptions.user_id UNIQUE のせいで
     体験を**永遠に再試行できない**状態が残る。 */
  const r = await transact((tx) => billing.startTrial(tx, user.id, track));
  if (!r.created) {
    return { ok: false, kind: "used", reason: "体験は 1 回だけです" };
  }
  await learning.ensureProgress(conn, user.id, track);
  await users.setActiveTrack(conn, user.id, track);
  return { ok: true, track, days: TRIAL_DAYS };
}


/* ---- ⑤ 入金した ------------------------------------------------------
   Stripe の webhook から呼ばれる。ここが日数を積む唯一の場所。

   【metadata を信じ切らない】
   user_id はこちらが入れた値だが、その行がまだ在るとは限らない
   （退会・削除）。引いて確かめる ── 無い相手に積むと、
   誰のものでもない日数が残る。

   【順番】
     1 台帳に記録して日数を積む（creditPurchase。再送はここで無効）
     2 進みの器を用意する
     3 受けているコースをこれにする
     4 離脱の台帳を閉じる
     5 「続き / 最初から」を訊く、または即 1 日目

   1 を先にするのは、送信で落ちても入金が消えないため。逆にすると
   「払ったのに日数が無い」が残る。 */
/* transact は注入で受ける（plan-outage-billing §2-2 B）。本番は app.mjs が
   withTransaction を渡し、関門は既定値（同じ conn でそのまま実行）で
   SQL の順序を検証する ── handlers が db.mjs(=mysql2) を直接 import
   すると、偽の conn で回る関門が壊れるため。

   くくる単位は「台帳＋日数」だけ。守る不変式は
   **「台帳があれば日数もある」** の 1 つで、ensureProgress /
   setActiveTrack は接点の自己回復（healProgress）が拾う種類なので
   トランザクションに含めない。 */
export async function creditFromStripe(conn, ev,
  { deliver = null, send = pushMessage, transact = (fn) => fn(conn) } = {}) {
  if (!ev) return { ok: false, reason: "対象外のイベント" };
  if (!Number.isInteger(ev.userId) || ev.userId <= 0) {
    return { ok: false, reason: `metadata の user_id が読めません: ${ev.userId}` };
  }
  if (!isTrack(ev.track)) return { ok: false, reason: `metadata の track が読めません: ${ev.track}` };
  if (!PACKAGES[ev.packageType]) return { ok: false, reason: `metadata の package が読めません: ${ev.packageType}` };

  const user = await users.findById(conn, ev.userId);
  if (!user) return { ok: false, reason: `利用者が見つかりません: ${ev.userId}` };

  /* 1. 台帳と日数。payment_ref に Checkout Session の id を入れる。
        同じセッションが二度届いても 1062 で弾かれ、日数は増えない。 */
  /* 台帳（purchases）と日数（grant）と subscriptions を 1 つの
     トランザクションで。INSERT の後・grant の前に死ぬと「決済の記録は
     あるのに日数が無い」が残り、再送は payment_ref UNIQUE の 1062 で
     **静かに無視**される ── 回復の道が無い half-done を作らない。 */
  const credited = await transact((tx) =>
    billing.creditPurchase(tx, user.id, ev.track, ev.packageType,
      { paymentRef: ev.sessionId, pricePaid: ev.amount || null }));

  if (!credited.created) {
    return { ok: true, duplicate: true, userId: user.id, track: ev.track };
  }

  /* 2〜4 */
  const { progress } = await learning.ensureProgress(conn, user.id, ev.track);
  /* 別コースを買うと届け先が移る（지시서⑯ §5-5-나）。移ったことは
     boughtNotice が本人に言う ── 黙って移すと、前のコースが止まったのが
     事故に見える。判定は setActiveTrack より**前**に取る。 */
  const switched = !!user.active_track && user.active_track !== ev.track;
  await users.setActiveTrack(conn, user.id, ev.track);
  /* ブロックで unfollowed になっていた人が買い直すこともある。
     配信対象（trial / active）に戻す ── 戻さないと、払ったのに
     listDeliverable から外れたままになる。 */
  if (user.status === "unfollowed" || user.status === "expired") {
    await users.setStatus(conn, user.id, "active");
  }
  await lapses.markResumed(conn, user.id, ev.track, { now: jstDateTime() });

  /* 5. 進みがあれば訊く。無ければ（初めて買うコース）そのまま 1 日目。 */
  const resumeNeeded = progress && Number(progress.current_day) > 0;

  try {
    if (resumeNeeded) {
      await send(user.line_user_id, [
        boughtNotice(ev.track, credited.daysGranted, { switched }),
        askResume(ev.track, Number(progress.current_day))
      ]);
      await pushlogs.logSent(conn, user.id, { pushType: "resume" });
      return { ok: true, userId: user.id, track: ev.track,
               daysGranted: credited.daysGranted, asked: "resume" };
    }

    await send(user.line_user_id, [boughtNotice(ev.track, credited.daysGranted, { switched })]);
  } catch (e) {
    /* 送信の失敗で入金を無かったことにしない。日数はもう積んである。 */
    await pushlogs.logFailed(conn, user.id,
      { pushType: "upsell", error: String(e.message || e).slice(0, 500) });
    if (isUnreachable(e)) await users.markUnfollowed(conn, user.line_user_id);
    return { ok: true, userId: user.id, track: ev.track,
             daysGranted: credited.daysGranted, delivered: false, error: e.message };
  }

  /* 時刻に関係なく、その場で 1 日目を送る。翌朝まで何も来ないと、
     払ったのに何も起きていないように見える。
     二重送信は deliverOne 側の sentToday が見ている。 */
  let delivered = null;
  if (deliver) {
    try { delivered = await deliver(conn, user.id); }
    catch (e) { delivered = `失敗: ${e.message}`; }
  }

  return { ok: true, userId: user.id, track: ev.track,
           daysGranted: credited.daysGranted, delivered };
}


/* ---- ⑥ 続きから / 最初から ------------------------------------------- */

/* switched = 買ったことで届け先のコースが移ったか（creditFromStripe が
   setActiveTrack を通るため、別コースを買うと必ず移る）。

   【지시서⑯ §5-5-나 초안 — 대표 확정 대기】移ったことを言わないと、
   前のコースが止まったのが事故に見える。そして「前のぶんは消えて
   いない」までを一緒に言う ── そこまで言って初めて、選択画面の
   「取り替えられません」と辻褄が合う。 */
export function boughtNotice(track, days, { switched = false } = {}) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      "お手続きが完了しました。ありがとうございます。",
      "",
      `${l.ja}（${l.kr}） ${days} 日分をお預かりしました。`,
      ...(switched ? [
        "",
        `きょうから、お届けは ${l.ja} に切り替わります。`,
        "前のコースの残り日数と進みは、そのまま残っています。",
        "［내 진도］からいつでもお戻りいただけます。"
      ] : [])
    ].join("\n")
  };
}

function askResume(track, lastDay) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      `前回は ${l.ja} の ${lastDay} 日目まで進んでいます。`,
      "",
      "どちらにされますか？",
      "",
      `※ 1 日目からやり直す場合も、お預かりした日数は同じように使います。`
    ].join("\n"),
    quickReply: {
      items: [
        { type: "action", action: { type: "postback",
          label: `${lastDay + 1}日目から続ける`.slice(0, 20),
          data: `action=resume&track=${track}&mode=continue`,
          displayText: `${lastDay + 1} 日目から続けます` } },
        { type: "action", action: { type: "postback",
          label: "1日目からやり直す",
          data: `action=resume&track=${track}&mode=restart`,
          displayText: "1 日目からやり直します" } }
      ]
    }
  };
}

/* 答えた瞬間に反映する。restart でも days_used は動かさない ──
   動かすと、受け取った日数が無かったことになる（repo/learning.mjs）。 */
export async function applyResume(conn, user, { track, mode }) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };
  if (mode !== "continue" && mode !== "restart") {
    return { ok: false, reason: `mode が読めません: ${mode}` };
  }
  await users.setActiveTrack(conn, user.id, track);
  if (mode === "restart") await learning.resetProgress(conn, user.id, track, 0);
  const prog = await learning.getProgress(conn, user.id, track);
  return { ok: true, track, mode, currentDay: prog ? Number(prog.current_day) : 0 };
}

/* 문면은 2026-08-06 대표 확정(지시서⑧ §2-3)。1 行だけだと「で、何が
   どうなるのか」が読めない ── いつから・どのリズムで、まで言う。
   「あしたの朝 7 時から」を真に保つのは push-cron.sh の --not-after=9
   （관문이 문자열을 감시）。この文面を最初の購入経路（boughtNotice）へ
   複写しない ── あちらは**その場で** 1 日目が届くので正面から矛盾する
   （§2-3-1。관문이 boughtNotice 의 「あしたの朝」 부재를 감시）。 */
export function resumeDone(track, mode, currentDay) {
  const l = TRACK_LABELS[track];
  const head = mode === "restart"
    ? `${l.ja}（${l.kr}）を 1 日目からおとどけします。`
    : `${l.ja}（${l.kr}）の ${currentDay + 1} 日目から続けます。`;
  return {
    type: "text",
    text: [
      head,
      "",
      "毎朝7時と毎夕6時にお送りします。",
      "K:study101と楽しくハングルを勉強!",
      "お楽しみください^^ 화이팅! 응원합니다^^"
    ].join("\n")
  };
}


/* ---- 期限の予告 ------------------------------------------------------
   残り 2 日で 1 度だけ。毎日出すと通知が増えるだけで読まれなくなる。 */
export const EXPIRING_AT = 2;

export function expiringNotice(track, { remaining, currentDay }) {
  const l = TRACK_LABELS[track];
  const done = currentDay >= TOTAL_DAYS;
  return {
    type: "text",
    text: [
      `お預かりしている日数が、あと ${remaining} 日です。`,
      "",
      done
        ? `${l.ja}（${l.kr}）は ${TOTAL_DAYS} 日すべて終わります。`
        : `${l.ja}（${l.kr}）は ${currentDay} 日目まで進んでいます。`,
      "",
      "続けてお受け取りになる場合は、下から追加できます。",
      "追加された日数は、いまの続きに足されます。"
    ].join("\n"),
    quickReply: {
      items: [{ type: "action", action: { type: "postback",
        label: "受講料を見る", data: `action=plan&track=${track}`,
        displayText: "受講料を見ます" } }]
    }
  };
}


/* ---- 修了 ------------------------------------------------------------
   101 日目まで届いた人へ。ここが最後の接点で、次のコースを勧める
   唯一の場所でもある（今まで何も送っていなかった）。 */
export function completionNotice(track, { owned = [] } = {}) {
  const l = TRACK_LABELS[track];
  const next = TRACKS.find((t) => t !== track && !owned.includes(t))
            || TRACKS.find((t) => t !== track);

  const items = [];
  if (next) {
    items.push({ type: "action", action: { type: "postback",
      label: `${TRACK_LABELS[next].ja}を見る`.slice(0, 20),
      data: `action=plan&track=${next}`,
      displayText: `${TRACK_LABELS[next].ja} の受講料を見ます` } });
  }
  items.push({ type: "action", action: { type: "postback",
    label: `${l.ja}をもう一度`.slice(0, 20),
    data: `action=plan&track=${track}`,
    displayText: `${l.ja} をもう一度受けます` } });

  return {
    type: "text",
    text: [
      `${TOTAL_DAYS} 日間、おつかれさまでした。`,
      "",
      `${l.ja}（${l.kr}）はこれで修了です。`,
      "",
      next
        ? `続けて ${TRACK_LABELS[next].ja}（${TRACK_LABELS[next].kr}）に進めます。`
          + `\n${TRACK_LABELS[next].ja}も 1 日目からの ${TOTAL_DAYS} 日間です。`
        : "同じコースをもう一度受けることもできます。",
      "",
      "もう一度受ける場合は1日目からお届けします。"
    ].join("\n"),
    quickReply: { items }
  };
}


/* ---- 進み具合（リッチメニューの［内 진도］） -------------------------- */

export async function statusMessage(conn, user) {
  const owned = await entitlements.listByUser(conn, user.id);
  if (!owned.length) {
    return {
      type: "text",
      text: ["まだ受講が始まっていません。",
             "［受講料］からコースをお選びください。"].join("\n"),
      quickReply: { items: [{ type: "action", action: { type: "postback",
        label: "受講料を見る", data: "action=plans", displayText: "受講料を見ます" } }] }
    };
  }

  /* いまお届け中のコースの current_day / TOTAL_DAYS（101）。
     「今日まで N/101」の N は確保済みの日。分母は講座の長さで、
     残日数や購入日数ではない（2026-08-09 代表）。
     続けて韓国語の応援 ── name_kr があれば「○○님 응원합니다^^」
     （plan-status-cheer.md）。 */
  const active = owned.find((e) => e.track === user.active_track) || owned[0];
  const dayLine = `今日まで${active.currentDay}/${TOTAL_DAYS}です。🇰🇷💕`;
  const cheerName = String(user.name_kr || "").trim();
  const cheerLines = [
    "화이팅! 오늘도 한 걸음 💪✨",
    cheerName ? `${cheerName}님 응원합니다^^` : "응원합니다^^"
  ];

  /* 【切り替え】いま届いていないコースに残りがあるなら、そこへ戻す
     ボタンを出す（指示書⑯ §5）。

     出さないと、初級 20 日を残したまま中級を買った人は、中級を
     使い切った時点で初級が宙に浮く ── 戻る道が「初級をもう一度買う」か
     「ブロックして再追加」しか無かった（follow.mjs の firstWithRemaining が
     唯一の自動復帰）。払ったものが返らない状態を、案内できる形にする。

     残り 0 のコースは出さない（§5-4-5）── 押しても何も起きない
     ボタンになる。買ったコースが 1 つだけの人にも出ない。 */
  const switchable = owned.filter((e) => e.track !== user.active_track && e.remaining > 0);

  return {
    type: "text",
    text: [dayLine, "", ...cheerLines,
           ...(switchable.length ? ["", "残っているコースへ切り替えられます（進みはそのままです）。"] : [])
          ].join("\n"),
    ...(switchable.length ? { quickReply: { items: switchable.map((e) => ({
      type: "action",
      action: {
        type: "postback",
        label: `${TRACK_LABELS[e.track].ja}に切り替え`.slice(0, 20),
        data: `action=switch&track=${e.track}`,
        displayText: `${TRACK_LABELS[e.track].ja} に切り替えます`
      }
    })) } } : {})
  };
}

/* 届け先のコースを、既に持っているコースの中で移す（지시서⑯ §5）。

   日数は 1 日も動かさない ── advanceDay も days_used も触らない。
   切り替えただけで 1 日減ったら、それは買ったぶんが消えたのと同じ
   （残り = days_entitled - days_used。STATUS §8-1・§8-2）。

   track を data のまま信じない。data は書き換えて送れるので、
   持っていないコースへ移されると listDeliverable の JOIN から
   静かに落ちて、翌朝から何も届かなくなる（§5-4-1）。 */
export async function applySwitch(conn, user, { track }) {
  if (!isTrack(track)) return { ok: false, reason: `未知の track: ${track}` };
  if (track === user.active_track) return { ok: false, reason: "同じコースです" };

  const owned = await entitlements.listByUser(conn, user.id);
  const e = owned.find((x) => x.track === track);
  if (!e) return { ok: false, reason: "持っていないコースです" };
  if (e.remaining <= 0) return { ok: false, reason: "残りがありません" };

  /* 進みの器が無ければ作る（買ったのに無い、は healProgress と同じ受け皿）。
     current_day は渡さない ── ensureProgress は既にあれば触らない。 */
  await learning.ensureProgress(conn, user.id, track);
  await users.setActiveTrack(conn, user.id, track);
  return { ok: true, track, currentDay: e.currentDay, remaining: e.remaining };
}

/* 切り替えの返事。「いまから」とは言わない ── その日の朝ぶんを
   もう受け取っている人には嘘になる（sentToday は user 単位で、
   同じ日に二度は送らない。§5-4-3）。 */
export function switchDone(track, currentDay, remaining) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}）に切り替えました。`,
      "",
      `${currentDay} 日目まで進んでいます。残り ${remaining} 日です。`,
      "あすの朝のぶんから、こちらをお届けします。",
      "",
      "前のコースの進みは、そのまま残っています。"
    ].join("\n")
  };
}

export { notReady };
