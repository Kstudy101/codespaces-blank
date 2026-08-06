/* ==================================================================
   handlers/postback.mjs — ボタンが押された

   受けるのは 8 つ。

     始める前の確認
       action=name&use=web|line        どちらの名前で呼ぶか
       action=birth&ok=1|0             生年月日が本人のものか
       action=trackpick&track=…        コースを選ぶ ＝ 体験開始（販売ゲート外）

     リッチメニューと受講料（migrations/002）
       action=about                    講座の案内
       action=status                   いまの進み具合
       action=plans                    コースを選ぶ
       action=plan&track=…             価格表（＝最終確認画面）
       action=buy&track=…&pkg=…        決済ページへ
       action=trial&track=…            体験 3 日
       action=resume&track=…&mode=…    買い直した人の「続き / 最初から」

     節目
       action=quiz&day=30&choice=2     クイズ（docs/plan-quiz-checkpoint.md）

   data は利用者の端末を経由して戻ってくる文字列で、こちらが
   送ったものがそのまま返る保証は無い（作り替えられる）。
   正解番号を data に入れてはいけない ── 入れると、押す前に
   書き換えれば必ず正解になる。正答は必ずサーバー側で引く。

   同じ理由で、track も pkg も値をそのまま使わない。isTrack と
   PACKAGES の鍵で突き合わせる ── ENUM に無い値を MySQL へ渡すと、
   設定によっては例外ではなく空文字が入り、その人だけ配信対象から
   静かに外れる。金額も同じで、pkg を信じると値段を書き換えられる。

   【押したあと、次を続けて訊く】
   1 つ答えたら、その場で次の段を返す。返さないと、答えたのに
   何も起きていないように見えて、次のボタンは翌朝まで来ない。
   段そのものは lib/onboarding.mjs が中身から導く（列で持たない）。
   ================================================================== */
import { users, learning, billing, entitlements } from "../repo/index.mjs";
import { replyMessage, pushMessage } from "../line.mjs";
import { nextStep, messageForStep, askReading, confirmName, nameFixed,
         onboardingDone, birthRedo, serviceGuide, fixPicker,
         askBirthCity, trackStarted } from "../onboarding.mjs";
import { cities } from "../fortune.mjs";
import { kanaNameToHangul } from "../kana2hangul.mjs";
import {
  salesAllowedFor, salesMode, notReady, coursePreparing, askCourse, priceList,
  sellablePackages, startCheckout, checkoutLink, startTrialFor, applyResume,
  resumeDone, statusMessage, missingLegalConfig
} from "./checkout.mjs";
import { PACKAGES, TRIAL_DAYS } from "../repo/billing.mjs";
import { deliverNow } from "../../db/push-daily.mjs";
import { isTrack } from "../repo/learning.mjs";

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
  const [user, saju] = await Promise.all([
    users.findById(conn, userId),
    users.getSajuProfile(conn, userId)
  ]);
  if (!user) return null;
  /* ONBOARD_COLUMNS（lib/onboarding.mjs）を全部運ぶ。1 つ欠けると
     undefined で判定が静かに逸れる ── verify-onboarding が見張る。 */
  return {
    ...user,
    birth_date: saju ? saju.birth_date : null,
    birth_time: saju ? saju.birth_time : null,
    birth_confirmed: saju ? saju.birth_confirmed : false,
    gender: saju ? saju.gender : "U",
    ohaeng_main: saju ? saju.ohaeng_main : null,
    raw_result_json: saju ? saju.raw_result_json : null,
    /* 段にコースはもう無い（買うときに選ぶ）。それでも track を
       入れておくのは、listDeliverable の 1 行と同じ形にするため ──
       形が違うと、片方でだけ段が進む。 */
    track: user.active_track || null
  };
}

/* 答えたあとに続けて出す 1 通。次の段が無ければ**締めの 1 通** ──
   null で黙ると、最後の答えにだけ無応答になる（欠損A、
   docs/research-onboarding-gap.md）。 */
async function followUp(conn, userId) {
  const st = await stateOf(conn, userId);
  if (!st) return null;
  const step = nextStep(st);
  /* messageForStep は async（track 段が原稿の保有日数を引くため）。
     conn を渡さないと track 段が null になり、要約確認に答えた人が
     無応答で終わる。 */
  return step ? await messageForStep(step, st, conn) : onboardingDone(st);
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


/* deliver / push は試験で差し替えるための口。既定は本物 ──
   deliver は体験申込の即時 1 日目（指示書 §2、creditFromStripe と
   同じ考え方で外から注入できる形にしておく）。 */
export async function handlePostback(conn, event,
  { send = replyMessage, deliver = deliverNow, push = pushMessage,
    /* 本番は webhook 経由で withTransaction が入る。既定は同じ conn で
       そのまま ── 偽の conn の関門を壊さない（plan-outage-billing §2-2）。 */
    transact = (fn) => fn(conn) } = {}) {
  const lineUserId = event?.source?.userId;
  if (!lineUserId) return { skipped: "userId がありません" };

  const { action, params } = parsePostbackData(event?.postback?.data);
  const user = await users.findByLineUserId(conn, lineUserId);
  if (!user) return { skipped: "未登録の利用者です", lineUserId };

  /* 進みの器が欠けていれば、触ってきたこの機会に置き直す
     （repo/learning.mjs healProgress ── 欠けたままだと配信から
     静かに落ち続ける）。失敗してもボタンの処理は続ける。 */
  try { await learning.healProgress(conn, user); } catch { /* 本処理を止めない */ }

  const token = event?.replyToken;

  /* ---- 名前 ------------------------------------------------------ */
  if (action === "name") {
    const use = params.use;

    if (use === "web") {
      await users.setNameSource(conn, user.id, "web");
      const replied = await reply(token, [await followUp(conn, user.id)], send);
      return { userId: user.id, action, use, replied };
    }

    /* LINE の表示名で。かなならその場で変換して確認へ、かなで
       なければ（ローマ字・絵文字など）読み仮名を 1 行もらう ──
       **サイトへは戻さない**（以前ここで再診断へ送っていて離脱が
       起きていた。lib/onboarding.mjs の注記）。

       候補の読みは DB（name_reading）に置き、name_kr は確定まで
       空のまま。data に名前を載せないための置き場で、確定時は
       ここから作り直す。name_kr が空のあいだは配信の文面が
       名前案内側に倒れるので、未確定の名前で 101 日が始まる
       ことはない（lib/render.mjs）。 */
    if (use === "line") {
      await users.setNameSource(conn, user.id, "line");
      /* name_reading は VARCHAR(50)。表示名は 100 字まで来るので、
         切らずに入れると errno 1406 で throw し、本人には何も返らない。
         link.mjs の str(v, 50) と同じ切り方。 */
      const disp = String(user.display_name || "").trim().slice(0, 50);
      const kr = kanaNameToHangul(disp);
      if (kr) {
        await users.updateName(conn, user.id,
          { nameKanji: null, nameReading: disp, nameKr: null });
        const replied = await reply(token, [confirmName({ reading: disp, kr })], send);
        return { userId: user.id, action, use, pendingConfirm: true, replied };
      }
      await users.updateName(conn, user.id,
        { nameKanji: null, nameReading: null, nameKr: null });
      const replied = await reply(token, [askReading()], send);
      return { userId: user.id, action, use, askedReading: true, replied };
    }

    /* べつの名前で ── 読みをかなで入れてもらう（handlers/message.mjs が受ける）。 */
    if (use === "other") {
      await users.setNameSource(conn, user.id, "line");
      await users.updateName(conn, user.id,
        { nameKanji: null, nameReading: null, nameKr: null });
      const replied = await reply(token, [askReading()], send);
      return { userId: user.id, action, use, askedReading: true, replied };
    }

    /* 「〇〇 で OK?」の答え。名前は data からではなく、DB に置いた
       候補（name_reading）から**作り直す** ── data は利用者の端末を
       経由して戻るので、そこに載せた名前は信じられない（冒頭）。 */
    if (use === "confirm") {
      const ok = params.ok === "1";
      const fresh = await users.findById(conn, user.id);
      const reading = fresh?.name_reading ? String(fresh.name_reading).trim() : null;
      const kr = ok && reading ? kanaNameToHangul(reading) : null;

      if (!kr) {
        /* 入れ直したい・候補が無い・候補が壊れている。どれも
           「もう一度読みから」で同じ。 */
        await users.updateName(conn, user.id,
          { nameKanji: null, nameReading: null, nameKr: null });
        const replied = await reply(token, [askReading()], send);
        return { userId: user.id, action, use, ok, replied };
      }

      await users.updateName(conn, user.id,
        { nameKanji: null, nameReading: reading, nameKr: kr });
      /* サイトを通らない直接流入は name_source が空のまま来る。
         立てておかないと、確定した直後に PENDING.name が
         「どちらの名前で？」を出す ── もう選びようが無い人に。 */
      if (!fresh.name_source) await users.setNameSource(conn, user.id, "line");
      const replied = await reply(token,
        [nameFixed(kr), await followUp(conn, user.id)], send);
      return { userId: user.id, action, use, ok: true, nameKr: kr, replied };
    }

    return { skipped: `name の use が読めません: ${use}`, userId: user.id };
  }

  /* ---- LINE 直接流入の 4 問（plan-line-onboarding.md）--------------
     どの答えも「部分更新」で保存する ── upsertSajuProfile は全列を
     書くので、いまの行を読んで欠けを埋めてから渡す。渡し忘れた列が
     null で上書きされると、答えた値が静かに消える。

     ★ ohaengMain はここでは**決して渡さない**（리뷰 수정 5）。
     ohaeng_main の空白が「サイト診断を通っていない」の判別子で、
     ここで埋めると新 4 段が途中で止まる。verify-onboarding が
     この不在を静的に見張る。 */
  const saveSaju = async (patch) => {
    const cur = await users.getSajuProfile(conn, user.id) || {};
    const raw = cur.raw_result_json && typeof cur.raw_result_json === "object"
      ? cur.raw_result_json : {};
    await users.upsertSajuProfile(conn, user.id, {
      birthDate: patch.birthDate !== undefined ? patch.birthDate : (cur.birth_date || null),
      birthTime: patch.birthTime !== undefined ? patch.birthTime : (cur.birth_time || null),
      gender:    patch.gender    !== undefined ? patch.gender    : (cur.gender || "U"),
      rawResult: patch.city      !== undefined ? { ...raw, city: patch.city } : (cur.raw_result_json ?? null)
    });
  };

  if (action === "bdate") {
    /* datetimepicker の結果は postback.params.date に載って戻る。 */
    const date = event?.postback?.params?.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
      return { skipped: `date が読めません: ${date}`, userId: user.id };
    }
    const y = Number(String(date).slice(0, 4));
    if (y < 1930 || y > 2030) {   /* 節気表の範囲外は四柱が立たない */
      return { skipped: `範囲外の年: ${y}`, userId: user.id };
    }
    await saveSaju({ birthDate: date });
    const replied = await reply(token, [await followUp(conn, user.id)], send);
    return { userId: user.id, action, date, replied };
  }

  if (action === "btime") {
    const unknown = params.unknown === "1";
    const time = event?.postback?.params?.time;
    if (!unknown && !/^\d{2}:\d{2}$/.test(String(time || ""))) {
      return { skipped: `time が読めません: ${time}`, userId: user.id };
    }
    await saveSaju({ birthTime: unknown ? null : `${time}:00` });
    /* 「わからない」は birth_time=NULL のまま ── 次の質問（出生地）が
       済むと、その NULL は「訊いたが不明」と読める（2-1 の導出）。 */
    const replied = await reply(token, [await followUp(conn, user.id)], send);
    return { userId: user.id, action, unknown, replied };
  }

  if (action === "bplace") {
    const tzGroup = params.c === "seoul" ? "seoul" : params.c === "tokyo" ? "tokyo" : null;
    if (!tzGroup) return { skipped: `国が読めません: ${params.c}`, userId: user.id };
    const replied = await reply(token, [askBirthCity(tzGroup, cities())], send);
    return { userId: user.id, action, tzGroup, replied };
  }

  if (action === "bcity") {
    /* data は書き換えられる ── 都市 id は必ず一覧で引き当てる。
       知らない id を raw.city に入れると、fortune が黙って
       tokyo に落ちる（raw.city || "tokyo"）。 */
    const city = cities().find((c) => c.id === params.id);
    if (!city) return { skipped: `知らない都市: ${params.id}`, userId: user.id };
    await saveSaju({ city: city.id });
    const replied = await reply(token, [await followUp(conn, user.id)], send);
    return { userId: user.id, action, city: city.id, replied };
  }

  if (action === "bgender") {
    const v = ["M", "F", "U"].includes(params.v) ? params.v : null;
    if (!v) return { skipped: `性別が読めません: ${params.v}`, userId: user.id };
    await saveSaju({ gender: v });
    const replied = await reply(token, [await followUp(conn, user.id)], send);
    return { userId: user.id, action, gender: v, replied };
  }

  /* 「直したい」で選んだ項目の質問をもう一度。答えの保存は各段の
     ハンドラがやり、そのあとの followUp が要約確認へ自然に戻す。 */
  if (action === "fix") {
    const s = ["reading", "bdate", "btime", "bplace", "bgender"].includes(params.s)
      ? params.s : null;
    if (!s) return { skipped: `直す対象が読めません: ${params.s}`, userId: user.id };
    if (s === "reading") {
      /* 名前は候補を消して読みから ── confirm ok=0 と同じ道。 */
      await users.updateName(conn, user.id,
        { nameKanji: null, nameReading: null, nameKr: null });
      await users.setNameSource(conn, user.id, "line");
    }
    const st = await stateOf(conn, user.id);
    const replied = await reply(token, [await messageForStep(s, st, conn)], send);
    return { userId: user.id, action, fix: s, replied };
  }

  /* ---- 生年月日 --------------------------------------------------- */
  if (action === "birth") {
    /* "ok=1" 以外はすべて「入れ直す」。ok が欠けている・読めない
       ときに確認済みを立てないのは、確認は立てる側に寄せると
       間違いが「本人が確かめた」として残るため。 */
    const ok = params.ok === "1";

    if (!ok) {
      /* 直し方は経路で違う ── サイト経由は診断へ戻す（日付の読みを
         2 通りにしない、の決めごと）。直接流入はトークの中で
         項目を選んで直す（fixPicker）。判別は ohaeng_main。 */
      const st = await stateOf(conn, user.id);
      const replied = await reply(token,
        [st?.ohaeng_main ? birthRedo() : fixPicker()], send);
      return { userId: user.id, action, ok, replied };
    }

    await users.setBirthConfirmed(conn, user.id, true);
    const replied = await reply(token, [await followUp(conn, user.id)], send);
    return { userId: user.id, action, ok, replied };
  }

  /* ---- リッチメニュー：講座の案内 ----------------------------------- */
  if (action === "about") {
    const replied = await reply(token,
      [serviceGuide({ nameJa: user.name_reading || user.name_kanji })], send);
    return { userId: user.id, action, replied };
  }

  /* ---- リッチメニュー：いまの進み具合 ------------------------------- */
  if (action === "status") {
    const replied = await reply(token, [await statusMessage(conn, user)], send);
    return { userId: user.id, action, replied };
  }

  /* ---- 受講料：① コースを選ぶ --------------------------------------
     売る用意が整っていなければ、ここで止める。表示の義務を満たす前に
     決済へ進める道を作らない（handlers/checkout.mjs の門）。

     salesAllowedFor は法定表示に SALES_MODE を重ねたもの（§1-1）──
     plans / plan / buy の 3 か所とも同じ判定を通す。1 か所でも素通り
     すると、テスト鍵を入れた日に実利用者へ決済リンクが出る。 */
  if (action === "plans") {
    if (!salesAllowedFor(user)) {
      console.error("[checkout] 販売停止中:", `mode=${salesMode()}`,
        missingLegalConfig().join(" / ") || "(法定表示は充足)");
      return { userId: user.id, action, blocked: "販売停止",
               replied: await reply(token, [notReady()], send) };
    }
    const owned = (await entitlements.listByUser(conn, user.id)).map((e) => e.track);
    const replied = await reply(token, [askCourse({ owned })], send);
    return { userId: user.id, action, replied };
  }

  /* ---- 受講料：② 価格表（＝最終確認画面）--------------------------- */
  if (action === "plan") {
    if (!salesAllowedFor(user)) {
      console.error("[checkout] 販売停止中:", `mode=${salesMode()}`);
      return { userId: user.id, action, blocked: "販売停止",
               replied: await reply(token, [notReady()], send) };
    }
    const track = params.track;
    if (!isTrack(track)) return { skipped: `未知の track: ${track}`, userId: user.id };

    /* 原稿の保有日数が売れる上限（§1-2）。体験もこの中に収まるときだけ。 */
    const availableDays = await learning.countTemplates(conn, track);
    const trialAvailable = !(await billing.trialUsed(conn, user.id))
      && TRIAL_DAYS <= availableDays;

    const sellable = sellablePackages(availableDays);
    if (!sellable.length) {
      /* 売れるパッケージが 1 つも無い ── 原稿が最小パッケージに満たない */
      return { userId: user.id, action, track, blocked: "原稿不足",
               replied: await reply(token, [coursePreparing(track)], send) };
    }

    /* ---- 決済ページを**先に**作る（지시서⑦ §2）------------------------
       価格表のボタンは uri ── タップひとつで Stripe が開く。URL は
       押されてからでは渡せない（postback は画面を動かせない）ので、
       売れるパッケージぶんをここで作ってから価格表を組む。
       priceList は URL を受け取るだけの純粋関数のまま ── 関門 19 種が
       ネットワーク無しで回る性質を壊さない。

       並列で作る。reply token は数十秒で死ぬ ── 直列 3〜5 往復は
       間に合わない日が出る。1 つでも失敗したら**全部**失敗にして
       notReady を返す ── 失敗したものだけ抜くと、利用者には
       「30 日券が売っていない」に見え、原因を尋ねる方法が無い。

       開くたびに未使用セッションが 3〜5 個できるのは織り込み済み
       （24 時間で期限切れ。売上の正本は purchases 表）。 */
    let checkoutUrls;
    try {
      const sessions = await Promise.all(sellable.map(([key]) =>
        startCheckout(conn, user, { track, packageType: key })));
      checkoutUrls = {};
      sessions.forEach((r, i) => {
        if (!r.ok || !r.url) throw new Error(r.reason || "URL がありません");
        checkoutUrls[sellable[i][0]] = r.url;
      });
    } catch (e) {
      console.error("[checkout] 決済ページの事前作成に失敗:", e.message);
      return { userId: user.id, action, track, error: e.message,
               replied: await reply(token, [notReady()], send) };
    }

    const list = priceList(track, { trialAvailable, availableDays, checkoutUrls });
    const replied = await reply(token, [list], send);
    return { userId: user.id, action, track, replied };
  }

  /* ---- 受講料：③ 決済ページへ --------------------------------------
     ★ 지시서⑦（1 タップ化）以後、新しい価格表からは来ない経路 ──
     ボタンが uri になり、buy postback は新規に発生しない。残すのは
     既に送った古い価格表のボタンが押されたとき無反応にしないため。
     除去予定日 = **2026-09-06**（checkoutLink の注記と一緒に消すこと）。

     pkg をそのまま金額にしない。PACKAGES の鍵で引き当てて、値段は
     こちらの表から取る ── data は書き換えられるので、金額を載せると
     100 円で 101 日ぶんを買える。 */
  if (action === "buy") {
    if (!salesAllowedFor(user)) {
      console.error("[checkout] 販売停止中:", `mode=${salesMode()}`);
      return { userId: user.id, action, blocked: "販売停止",
               replied: await reply(token, [notReady()], send) };
    }
    const track = params.track, pkg = params.pkg;
    if (!isTrack(track)) return { skipped: `未知の track: ${track}`, userId: user.id };
    if (!PACKAGES[pkg])  return { skipped: `未知の package: ${pkg}`, userId: user.id };

    /* data は書き換えられる ── 価格表に出していないパッケージを
       名乗られても、原稿の上限（§1-2）でここでも止める。 */
    if (PACKAGES[pkg].days > await learning.countTemplates(conn, track)) {
      return { userId: user.id, action, track, pkg, blocked: "原稿不足",
               replied: await reply(token, [coursePreparing(track)], send) };
    }

    let r;
    try {
      r = await startCheckout(conn, user, { track, packageType: pkg });
    } catch (e) {
      /* 決済会社が落ちていても、こちらの webhook 処理は壊れない。
         押した人には「もう一度」とだけ伝える。 */
      console.error("[checkout] セッションを作れません:", e.message);
      return { userId: user.id, action, error: e.message,
               replied: await reply(token, [notReady()], send) };
    }
    if (!r.ok) return { skipped: r.reason, userId: user.id };

    const replied = await reply(token, [checkoutLink(track, pkg, r.url)], send);
    return { userId: user.id, action, track, pkg, sessionId: r.sessionId, replied };
  }

  /* ---- オンボーディング：コース選択（plan-course-onboarding §3）------
     無料の入口なので販売ゲート（salesAllowedFor）を**通さない** ──
     掛けると、Stripe が閉じているあいだ誰も始められない（この変更の
     最大の得。verify-onboarding が不在を静的に見張る ── plans/plan/buy は
     ゲート必須、trackpick はゲート禁止という反対方向の関門）。 */
  if (action === "trackpick") {
    const track = params.track;
    if (!isTrack(track)) return { skipped: `未知の track: ${track}`, userId: user.id };

    /* 原稿が体験日数ぶんも無いコースでは始めない ── 体験（action=trial）と
       同じ上限・同じ関数。選択肢からは除いてあるが、data は書き換えて
       戻せるのでここでも止める。 */
    if (TRIAL_DAYS > await learning.countTemplates(conn, track)) {
      return { userId: user.id, action, track, blocked: "原稿不足",
               replied: await reply(token, [coursePreparing(track)], send) };
    }

    const r = await startTrialFor(conn, user, track, { transact });
    if (!r.ok) {
      /* 体験は使い切っている。コースだけ立てて有料の入口を案内 ──
         active_track が立つので、同じコースに残りがあれば明朝から続き、
         残り 0 なら既存の再購入案内（upsell）が引き継ぐ。別コースで
         保有 0 のときは、この案内の [受講料] が唯一の入口。 */
      await users.setActiveTrack(conn, user.id, track);
      const replied = await reply(token, [{ type: "text",
        text: "無料でお試しいただけるのは 1 回までです。\n［受講料］から日数をお選びください。" }], send);
      return { userId: user.id, action, track, kind: r.kind, replied };
    }

    /* 開始の案内（문면 §7-가）→ その場で 1 日目。体験（action=trial）と
       同じ deliver 注入・同じ後始末。 */
    const replied = await reply(token, [trackStarted(track)], send);
    let delivered = null;
    try {
      delivered = await deliver(conn, user.id);
    } catch (e) {
      delivered = `失敗: ${e.message}`;
      console.error("[trackpick] 1 日目を送れません:", e.message);
    }
    if (delivered === "対象外" || delivered === "原稿なし") {
      try {
        await push(user.line_user_id, [{ type: "text",
          text: "1 日目の準備ができしだい、お届けします。" }]);
      } catch { /* 案内の失敗で体験開始は壊さない */ }
    }
    return { userId: user.id, action, track, started: true, delivered, replied };
  }

  /* ---- 受講料：④ 体験 ----------------------------------------------
     申し込み（＝内容への同意）の時点を 1 日目と見る（指示書 §2）。
     有料の入金経路（creditFromStripe が deliverNow を呼ぶ）と同じ
     やり方で、体験もその場で 1 日目を届ける ── これで案内文の
     「このあとすぐ 1 日目が届きます」が事実になる。 */
  if (action === "trial") {
    const track = params.track;
    if (!isTrack(track)) return { skipped: `未知の track: ${track}`, userId: user.id };

    /* 原稿が体験日数ぶんも無いコースでは始めない（§1-2 と同じ上限）。 */
    if (TRIAL_DAYS > await learning.countTemplates(conn, track)) {
      return { userId: user.id, action, track, blocked: "原稿不足",
               replied: await reply(token, [coursePreparing(track)], send) };
    }

    const r = await startTrialFor(conn, user, track, { transact });
    if (!r.ok) {
      const replied = await reply(token, [{ type: "text",
        text: "無料でお試しいただけるのは 1 回までです。\n［受講料］から日数をお選びください。" }], send);
      return { userId: user.id, action, track, kind: r.kind, replied };
    }
    const replied = await reply(token, [{ type: "text",
      text: `無料体験を始めます。まず ${r.days} 日分をお届けします。\nこのあとすぐ 1 日目が届きます。` }], send);

    /* 1 日目をその場で。sentToday が立つので、けさの配信バッチが
       まだ来ていなくても二重には届かない（deliverNow の頭書き）。
       名前待ち等で送れないときは deliverOne 側が案内を出すか黙るので、
       黙る種類（対象外・原稿なし）にだけ一言添える ── 「すぐ届きます」と
       言った直後に何も来ない、を残さない。 */
    let delivered = null;
    try {
      delivered = await deliver(conn, user.id);
    } catch (e) {
      delivered = `失敗: ${e.message}`;
      console.error("[trial] 1 日目を送れません:", e.message);
    }
    if (delivered === "対象外" || delivered === "原稿なし") {
      try {
        await push(user.line_user_id, [{ type: "text",
          text: "1 日目の準備ができしだい、お届けします。" }]);
      } catch { /* 案内の失敗で体験開始は壊さない */ }
    }
    return { userId: user.id, action, track, started: true, delivered, replied };
  }

  /* ---- ⑥ 続きから / 最初から ---------------------------------------- */
  if (action === "resume") {
    const r = await applyResume(conn, user, { track: params.track, mode: params.mode });
    if (!r.ok) return { skipped: r.reason, userId: user.id };
    const replied = await reply(token,
      [resumeDone(r.track, r.mode, r.currentDay)], send);
    return { userId: user.id, action, track: r.track, mode: r.mode, replied };
  }

  /* ---- 復習クイズ（3 日周期、docs/plan-quiz.md）--------------------
     節目（action=quiz）とは別の部屋。あちらは学期の合否を記録し、
     こちらは**何も保存しない** ── その場で採点して返事するだけ。
     混ぜると、9 日目の復習の誤答が semester1 の合否
     （修了判定の材料）を上書きする（docs/research-quiz.md §2）。 */
  if (action === "review") {
    const day = int(params.day);
    const choice = int(params.choice);
    if (day === null || choice === null) {
      return { skipped: "day / choice が読めません", userId: user.id, data: event?.postback?.data };
    }

    const track = user.active_track;
    if (!track) return { skipped: "受講中のコースがありません", userId: user.id };

    /* data は利用者の端末を経由して戻るので、書き換えられる。
       未習の日を名乗れば答えを探れる ── 進み（current_day）と
       突き合わせる。送った朝には advanceDay 済みなので、正規の
       ボタンなら必ず day <= current_day になっている。 */
    const progress = await learning.getProgress(conn, user.id, track);
    if (!progress || day < 1 || day > Number(progress.current_day)) {
      return { skipped: `${day} 日目はまだ学習していません`, userId: user.id, day };
    }

    /* 正答はサーバーの原稿にしか無い。data に載せない
       （このファイルの冒頭 ── 載せると押す前に書き換えられる）。 */
    const tpl = await learning.getTemplate(conn, track, day);
    const q = tpl?.quiz;
    if (!q || !Array.isArray(q.choices) || !Number.isInteger(q.answer)) {
      return { skipped: "この日のクイズがありません", userId: user.id, day };
    }

    const passed = choice === q.answer;
    const mark = ["①", "②", "③", "④"][q.answer] || `${q.answer + 1}`;
    const replied = await reply(token, [{
      type: "text",
      text: passed
        ? "⭕ 正解です！🎉"
        : `❌ ざんねん…　正解は ${mark} ${q.choices[q.answer] ?? ""} でした`
    }], send);
    return { userId: user.id, action, day, choice, passed, replied };
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
     その人がいま受けているコースで引く ── 引かずに初級で採点すると、
     中級の人が自分の受け取った問題と違う答えで採点される。

     進みはコース別になったので（migrations/002）、どの行を見るかは
     active_track が決める。ここを取り違えると、初級を修了した人の
     中級のクイズが初級の合否欄に入る。 */
  const track = user.active_track;
  if (!track) {
    return { skipped: "受講中のコースがありません", userId: user.id, day };
  }

  const q = await lookupAnswer(conn, track, day);
  if (q === null) {
    return { pending: "正答が未入稿です（P4）", userId: user.id, day, semester, choice };
  }

  const passed = choice === q.answer;
  await learning.setQuizResult(conn, user.id, track, semester, passed);

  /* 答えた本人に、その場で返す（docs/plan-quiz-checkpoint.md §1-2）。
     記録だけして黙ると、答えたのに何も起きていないように見える ──
     このファイルの頭書き自身がそう約束している。返信の失敗は
     採点の結果を壊さない（reply は throw しない）。 */
  const mark = ["①", "②", "③", "④"][q.answer] || `${q.answer + 1}`;
  const replied = await reply(token, [{
    type: "text",
    text: passed
      ? `⭕ 正解です！🎉\n第${semester}学期の節目クイズ、合格です！`
      : `❌ ざんねん…　正解は ${mark} ${q.choices[q.answer] ?? ""} でした`
  }], send);
  return { userId: user.id, track, day, semester, choice, passed, replied };
}

/* 正答は 003 で content_templates.quiz に決まった。壊れた原稿は
   ここで null になり「採点できない」を呼ぶ側に伝える ──
   quiz を丸ごと返すのは、不正解の返信に正答の文字列も要るため。 */
async function lookupAnswer(conn, track, day) {
  const tpl = await learning.getTemplate(conn, track, day);
  if (!tpl) return null;
  return learning.usableQuiz(tpl.quiz);
}
