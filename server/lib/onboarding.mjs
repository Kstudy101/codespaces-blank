/* ==================================================================
   lib/onboarding.mjs — 始める前に名前とコースだけ確かめる

   この講座は「あなたの名前」で会話文が進む。四柱・運勢は付加物で、
   生年月日が無くてもレッスンは止めない（BLOCKING は名前だけ）。

     1  名前     ウェブで入れた名前で呼ぶか、別の名前にするか
     2  コース   どの講座で始めるか（選ぶとその場で体験が始まる）

   生年月日・出生地・性別は訊かない（登録情報フォームと同じ方針）。
   サイト診断で既に birth_date がある人には運勢だけ付ける。

   コースは一度［受講料］の中にあった（migrations/002）。
   その形だと、販売が閉じているあいだ無料の体験すら始められない ──
   オンボーディングを完走しても何も来ない袋小路になっていたので、
   段として戻した（plan-course-onboarding.md）。無料の入口なので
   販売ゲート（salesAllowedFor）は通らない。

   【状態の列を作らなかった理由】
   「今どの段まで進んだか」を列で持つと、実際の中身（name_source が
   入っているか）と二重に真実ができる。片方だけ進んだ状態は必ず
   起きるので、そのときどちらを信じるかを決められない。

   なので段は持たず、毎回そのつど中身から導く（nextStep）。
   導けるものを保存しない、が唯一ずれない書き方。
   ================================================================== */
const SITE_URL = process.env.SITE_URL || "https://www.kstudy101.jp";

/* 都市一覧。旧ボタン応答用。新規の質問では使わない。 */
import { cities } from "./fortune.mjs";

import { askCourse, notReady } from "./handlers/checkout.mjs";
import { TRACKS, TRACK_LABELS, countTemplates } from "./repo/learning.mjs";
import { TRIAL_DAYS } from "./repo/billing.mjs";
import { listByUser } from "./repo/entitlements.mjs";

/* 名前 → コース。生年月日チェーン（bdate〜birth）は廃止。 */
export const STEPS = Object.freeze(["name", "reading", "track"]);

export function cityOf(u) {
  const raw = u?.raw_result_json;
  return raw && typeof raw === "object" && raw.city ? String(raw.city) : null;
}

export function timeUnknown(u) {
  const raw = u?.raw_result_json;
  return !!(raw && typeof raw === "object" && raw.birth_time_unknown === true);
}

export const ONBOARD_COLUMNS = Object.freeze([
  "name_kr", "name_source", "display_name",
  "birth_date", "birth_time", "birth_confirmed",
  "gender", "ohaeng_main", "raw_result_json",
  "track"
]);

const PENDING = Object.freeze({
  name:  (u) => !u.name_source && !!u.name_kr && !!u.display_name,
  reading: (u) => (u.name_source === "line"
    || (!u.name_source && !u.name_kanji)) && !u.name_kr,
  /* 名前が決まればコース。生年月日は要らない。 */
  track: (u) => !!u.name_kr && !u.track
});

export function nextStep(u = {}) {
  return STEPS.find((s) => PENDING[s](u)) || null;
}

export const BLOCKING_STEPS = Object.freeze(["name", "reading"]);

export function blockingStep(u = {}) {
  return STEPS.find((s) => BLOCKING_STEPS.includes(s) && PENDING[s](u)) || null;
}


/* ---- ボタン --------------------------------------------------------
   quickReply を使う。Flex Message でも作れるが、こちらは本文が
   ただのテキストのままなので、通知のプレビューに用件が出る ──
   Flex だと「メッセージが届きました」としか出ない。

   label は 20 字まで。超えると LINE が 400 を返し、その人だけ
   案内が届かないまま止まる。ここで切っておく。 */
function quick(items) {
  return {
    items: items.slice(0, 13).map(({ label, data, displayText }) => ({
      type: "action",
      action: {
        type: "postback",
        label: String(label).slice(0, 20),
        data,
        /* 押した本人のトークに、選んだものが残るようにする。
           残らないと、あとから見返したときに何を選んだのか分からない。 */
        displayText: displayText || String(label).slice(0, 20)
      }
    }))
  };
}


/* ---- 1. サービスの案内 ---------------------------------------------
   連携した直後に 1 度だけ送る。

   これまで、サイトを通ってきた人には**何も送っていなかった**
   （handlers/follow.mjs は名前が無い人にしか返さない）。連携が
   成功しても LINE 側は無言で、最初のメッセージが翌朝の「1 日目」
   だった ── 何に登録したのか分からないまま本文が始まる。

   長いが 1 通に収める。分けると、読み飛ばした人が「コースを選ぶ」に
   たどり着けない。 */
export function serviceGuide({ nameJa = null } = {}) {
  const you = nameJa ? `${nameJa}さん` : "あなた";
  return {
    type: "text",
    text: [
      "連携できました。ここから毎日おとどけします。",
      "",
      "──────────",
      "📖 この講座について",
      "──────────",
      `韓国語を、${you}の**名前**と**四柱**で学びます。`,
      "教科書の「ミンスさん」ではなく、例文の主語があなたです。",
      "",
      "・会話文はあなたが「私」として登場します",
      "　場面（買い物・道をたずねる・自己紹介…）ごとに、",
      "　あなたの名前で言えるようになります",
      "・韓国式の占い（사주・운세・기운）が毎朝つきます",
      "　その日の運勢を韓国語で読むので、言葉と一緒に身につきます",
      "",
      "──────────",
      "🕖 1日のながれ",
      "──────────",
      "朝 7時　今日の運勢 ＋ 文法 ＋ 会話 ＋ 単語3語",
      "夕 6時　その文法をもう一度（復習）",
      "",
      "※ 進むのは朝の便だけです。夕方の復習と節目のクイズは",
      "　 おまけなので、お持ちの日数は減りません。",
      "",
      "──────────",
      "📚 コース",
      "──────────",
      "初級 / 中級 / 上級 の3つ。それぞれ101日ぶんの別の講座です。",
      "下のメニューの［受講料］からお選びいただけます。",
      "はじめての方は、無料でお試しいただけます。",
      "",
      "このあと、確認をいくつかお訊きします。"
    ].join("\n")
  };
}


/* ---- 2. 名前をどちらにするか ---------------------------------------
   ウェブで入れた名前と、LINE の表示名を並べて見せる。

   【LINE の名前を選んだらどうなるか】
   かな → ハングルの変換はサーバーにもある（lib/kana2hangul.mjs。
   index.html の移植で、乖離は tools/verify-kana.mjs が全表突き合わせで
   見張る）。表示名がかなならその場で変換して「〇〇 で OK?」と確認し、
   かなでなければ（ローマ字・絵文字など）読み仮名を 1 行だけ
   トークで入れてもらう ── **サイトへは戻さない**。以前はここで
   サイトの再診断へ送っていて、そこで離脱が起きていた。

   確定した名前は必ずサーバー側の値（DB の候補）から作り直す。
   postback の data は端末を経由して戻るので、そこに名前を載せて
   信じてはいけない（handlers/postback.mjs の冒頭）。 */
export function askName({ webName, webNameKr = null, lineName }) {
  /* ハングル表記も並べる。会話文に出るのはこちらなので、
     漢字だけ見せて選ばせると「そう読まれるとは思わなかった」が
     101 日たってから分かる。 */
  const web = webNameKr && webNameKr !== webName ? `${webName}（${webNameKr}）` : String(webName);

  return {
    type: "text",
    text: [
      "① お名前の確認",
      "",
      "この講座は、お名前がそのまま教材になります。",
      "毎日の会話文に、この名前で登場します。",
      "",
      `　サイトで入力　${web}`,
      `　LINEの表示名　${lineName}`,
      "",
      "どちらのお名前で進めますか？"
    ].join("\n"),
    quickReply: quick([
      { label: `${String(webName).slice(0, 12)}で`, data: "action=name&use=web",
        displayText: `${webName} で進めます` },
      { label: "LINEの名前にする", data: "action=name&use=line",
        displayText: "LINEの名前にします" },
      { label: "べつの名前にする", data: "action=name&use=other",
        displayText: "べつの名前にします" }
    ])
  };
}

/* 読み仮名を 1 行入れてもらう。ここでサイトへ送らない ──
   リンクは繰り返し失敗したときの最後の手段（readingRetry）だけ。 */
export function askReading() {
  return {
    type: "text",
    text: [
      "お使いになるお名前の**読み方**を、ひらがな か カタカナで",
      "1行お送りください。",
      "",
      "　例）はなこ ／ ハナコ",
      "",
      "そのままハングルの表記をおつくりします！"
    ].join("\n")
  };
}

/* かなで読めなかったときの返し。案内はもう 1 度だけ挟み、
   サイトは**最後の手段**として添える（元の「必ずサイトへ戻す」が
   離脱のもとだったので、主役にはしない）。 */
export function readingRetry() {
  return {
    type: "text",
    text: [
      "読み取れませんでした。",
      "ひらがな か カタカナ**だけ**で、もう一度お送りください。",
      "",
      "　例）はなこ ／ ハナコ",
      "",
      "うまくいかない場合は、サイトの診断からも登録できます！",
      SITE_URL
    ].join("\n")
  };
}

/* 「〇〇 で OK?」。押された答えの処理は handlers/postback.mjs ──
   data に名前は載せない。確定はサーバーが DB の候補から作り直す。 */
export function confirmName({ reading, kr }) {
  return {
    type: "text",
    text: [
      "ハングル表記はこちらになります！",
      "",
      `　${reading} → ${kr}`,
      "",
      "このお名前でお届けしてよろしいですか？"
    ].join("\n"),
    quickReply: quick([
      { label: "はい、これで", data: "action=name&use=confirm&ok=1",
        displayText: "はい、この名前で" },
      { label: "入れ直す", data: "action=name&use=confirm&ok=0",
        displayText: "入れ直します" }
    ])
  };
}

/* ---- 締めの 1 通（診断: docs/research-onboarding-gap.md 欠損A）------
   最後の段に答えた人へ。ここが無かったので、答えたのに無応答 ──
   「そのまま終了」に見えていた。postback の頭書きが警告している
   「答えたのに何も起きていないように見える」が、最後の段でだけ
   開いていた穴。

   コースが決まっていない人（買う前）には次の行動を 1 つだけ示す。
   決まっている人には明日の朝を予告する ── どちらも「これで終わり
   ではない」ことが伝わればよく、長くしない。

   track 段が入ってからは、ふつうの流れでは track が nextStep に
   なるのでここまで来ない。track 無しでここへ来るのは変則の行
   （birth_date が無いサイト経由など）だけ ── その保険として
   [受講料] への案内を残す。 */
export function onboardingDone({ track = null } = {}) {
  return {
    type: "text",
    text: track
      ? [
          "確認ありがとうございました。これで準備が整いました！",
          "",
          "明日の朝7時から、毎日お届けします！"
        ].join("\n")
      : [
          "確認ありがとうございました。これで準備が整いました！",
          "",
          "下のメニューからコースをお選びいただくと、",
          "毎朝のお届けが始まります！はじめての方は無料でお試しいただけます！"
        ].join("\n")
  };
}

/* 確定の報せ。このあと followUp（次の段）が続く。 */
export function nameFixed(kr) {
  return {
    type: "text",
    text: `お名前は「${kr}」でお届けします。毎日の会話文に登場します。`
  };
}


/* ---- 3. 生年月日の確認 ---------------------------------------------
   時刻まで見せる。四柱は時柱で変わるので、日付だけ合っていても
   時刻が「とりあえず 0 時」だと別の四柱になる。 */
export function askBirth({ birthDate, birthTime = null }) {
  const t = birthTime
    ? `${String(birthTime).slice(0, 5)} ごろ`
    : "時刻は未入力（時柱なしで占います！）";

  return {
    type: "text",
    text: [
      "② 生年月日の確認",
      "",
      "毎朝の運勢は、この生年月日から四柱を立てて出します。",
      "サイトでお試しの値を入れていた場合は、ここで直せます！",
      "",
      `　${birthDate}`,
      `　${t}`,
      "",
      "こちらはご本人のものですか？"
    ].join("\n"),
    quickReply: quick([
      { label: "はい、これで", data: "action=birth&ok=1",
        displayText: "はい、この生年月日で" },
      { label: "入れ直したい", data: "action=birth&ok=0",
        displayText: "入れ直します" }
    ])
  };
}

/* 入れ直す人への返し。名前と同じくサイトへ戻す ── 生年月日だけを
   LINE で受け取る道を作ると、日付の書き方（1995/4/12・H7.4.12・
   1995-04-12）を LINE 側でも解釈することになり、サイトと 2 通りの
   読み取りができる。ずれたときに四柱が変わる。 */
export function birthRedo() {
  return {
    type: "text",
    text: [
      "承知しました。",
      "",
      "▼ 本当の生年月日で、もう一度どうぞ",
      SITE_URL,
      "",
      "生まれた時刻が分かる場合は入れてください。",
      "四柱の「時柱」が決まるので、運勢が細かくなります！",
      "分からなければ空のままで大丈夫です。"
    ].join("\n")
  };
}


/* ---- 4. コース選択（plan-course-onboarding §2〜§4）------------------
   要約確認が済んだ人に、無料の入口として訊く。文面は checkout の
   askCourse をそのまま使い、ボタンの行き先だけ trackpick に替える
   （写しを持たない）。選択肢は原稿が体験日数ぶんあるコースだけ ──
   3 日未満のコースを出すと、選んだ直後に「原稿なし」で止まる。

   選べるコースが 0 なら notReady()（準備中の一言）を返して、段は
   pending のまま ── 原稿が入れば次の接点で自然にまた訊く。能動の
   発信は askOnboarding（push-daily）の ONBOARD_NOTICE_MAX が段に
   関係なく先に数えるので、無限には繰り返さない（승인 수정 3）。 */
async function askTrackStep(conn, u) {
  const owned = (await listByUser(conn, u.id)).map((e) => e.track);
  const selectable = [];
  for (const t of TRACKS) {
    if (TRIAL_DAYS <= await countTemplates(conn, t)) selectable.push(t);
  }
  if (!selectable.length) return notReady();
  return askCourse({ owned, pick: { tracks: selectable } });
}

/* 開始の案内（문면 §7-가・2026-08-06 확정）。押した直後の 1 通で、
   このすぐ後ろに deliverNow の 1 日目が続く（handlers/postback.mjs）。 */
export function trackStarted(track) {
  const l = TRACK_LABELS[track];
  return {
    type: "text",
    text: [
      `${l.ja}（${l.kr}）で始めます！`,
      "",
      "このあとすぐ「1日目」をお届けします！",
      "明日からは、毎日この時間にお届けします！",
      "　朝7時　文法 ＋ 会話＋単語 3 語（＋ 今日の運勢）",
      "　夕6時　その日の文法をもう一度（復習）",
      "",
      `まずは ${TRIAL_DAYS} 日間、無料でお試しいただけます。`,
      "",
      "お名前から始まる韓国語、どうぞ楽しんでいってください！"
    ].join("\n")
  };
}


/* ---- 次の 1 通を作る ------------------------------------------------
   nextStep が返した段の文面を作る。作れないとき（訊く必要が無い）は
   null を返すので、呼ぶ側は送らずに済む。 */
/* ---- LINE 直接流入の 4 問（plan-line-onboarding.md）------------------
   datetimepicker は LINE 専用の入れ物で、押した結果は postback の
   params.date / params.time に載って戻る。data には値を載せない ──
   値は LINE が運ぶ（改竄面も data より狭い）。 */
export function askBirthDate() {
  return {
    type: "text",
    text: [
      "生年月日を教えてください。",
      "毎朝の運勢は、ここから四柱を立てて出します。"
    ].join("\n"),
    quickReply: { items: [{
      type: "action",
      action: { type: "datetimepicker", label: "生年月日を選ぶ",
                data: "action=bdate", mode: "date",
                initial: "1990-01-01", min: "1930-01-01", max: "2030-12-31" }
    }] }
  };
}

export function askBirthTime() {
  return {
    type: "text",
    text: [
      "生まれた時刻はお分かりですか？",
      "（分からない場合は、時柱なしの三柱で占います）"
    ].join("\n"),
    quickReply: { items: [
      { type: "action",
        action: { type: "datetimepicker", label: "時刻を選ぶ",
                  data: "action=btime", mode: "time", initial: "12:00" } },
      { type: "action",
        action: { type: "postback", label: "わからない",
                  data: "action=btime&unknown=1", displayText: "わからない" } }
    ] }
  };
}

/* 出生地。CITIES 17 個 > quickReply 13 個の制限なので 2 段
   （国 → 都市）。都市の一覧は fortune.mjs の cities() ── vm ロードの
   Saju.CITIES そのもので、写しは持たない（리뷰 수정 1）。
   国の見分けは tz（seoul / tokyo）── CITIES に国の列は無く、
   標準時がそのまま国割りになっている。 */
export function askBirthPlace() {
  return {
    type: "text",
    text: "お生まれの国はどちらですか？",
    quickReply: { items: [
      { type: "action", action: { type: "postback", label: "日本",
          data: "action=bplace&c=tokyo", displayText: "日本" } },
      { type: "action", action: { type: "postback", label: "韓国",
          data: "action=bplace&c=seoul", displayText: "韓国" } }
    ] }
  };
}

export function askBirthCity(tzGroup, cityList) {
  const list = cityList.filter((c) => c.tz === tzGroup);
  return {
    type: "text",
    text: "いちばん近い都市をお選びください。\n（経度で真太陽時を出すのに使います）",
    quickReply: { items: list.slice(0, 13).map((c) => ({
      type: "action",
      action: { type: "postback", label: String(c.ja).slice(0, 20),
                data: `action=bcity&id=${c.id}`, displayText: c.ja }
    })) }
  };
}

/* askGender は削除（지시서⑱）── 訊かないので、訊く文面も持たない。 */

/* 要約確認（決定 2-2）。直接流入の締め ── 全項目を 1 画面に並べ、
   「これで始めます」で birth_confirmed が立つ。項目ごとに再確認
   しない代わりの、唯一のまとめて見る場所。 */
export function summaryConfirm(u = {}, cityList = []) {
  const city = cityList.find((c) => c.id === cityOf(u));
  return {
    type: "text",
    text: [
      "ご入力の確認です。",
      "",
      `　お名前　　${u.name_kr || "（未登録）"}`,
      `　生年月日　${String(u.birth_date || "").slice(0, 10)}`,
      `　時刻　　　${u.birth_time ? String(u.birth_time).slice(0, 5) : "わからない（三柱で占います）"}`,
      `　出生地　　${city ? city.ja : "（未選択）"}`,
      "",
      "この内容で始めてよろしいですか？"
    ].join("\n"),
    quickReply: quick([
      { label: "これで始めます", data: "action=birth&ok=1",
        displayText: "この内容で始めます" },
      { label: "直したい", data: "action=birth&ok=0", displayText: "直します" }
    ])
  };
}

/* 直したい → どの項目か。答えると各段の質問がもう一度出て、
   answering 後の followUp が要約確認へ自然に戻す。 */
export function fixPicker() {
  return {
    type: "text",
    text: "どちらを直しますか？",
    quickReply: quick([
      { label: "名前", data: "action=fix&s=reading", displayText: "名前を直します" },
      { label: "生年月日", data: "action=fix&s=bdate", displayText: "生年月日を直します" },
      { label: "時刻", data: "action=fix&s=btime", displayText: "時刻を直します" },
      { label: "出生地", data: "action=fix&s=bplace", displayText: "出生地を直します" }
    ])
  };
}

/* track 段だけ DB が要る（原稿の保有日数で選択肢を絞る）ので、
   全体を async にして conn を受ける。呼ぶ側は**必ず await して conn を
   渡す** ── 渡さないと track 段が null になり、要約確認に答えた人が
   無応答で終わる（verify-onboarding が呼び出し形を静的に見張る）。 */
export async function messageForStep(step, u = {}, conn = null) {
  if (step === "track") {
    return conn ? askTrackStep(conn, u) : null;
  }
  if (step === "name") {
    return askName({
      webName: u.name_kanji || u.name_kr,
      webNameKr: u.name_kr,
      lineName: u.display_name
    });
  }
  /* 読み仮名待ち。選び直し（askName）を出してはいけない ── もう
     選んだ人なので、答えたはずの質問が戻ってくる形になる。 */
  if (step === "reading") {
    return askReading();
  }
  return null;
}
