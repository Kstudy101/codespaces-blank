/* ==================================================================
   content-check.mjs — 原稿が入稿できる形かどうか

   原稿そのもの（server/content/）は公開リポジトリに置いていない。
   置くと有料で配るものが誰でも取れる状態になり、1 度 push すれば
   履歴から消せない。ただし「何を満たしていなければならないか」は
   コードなので、こちらは残す ── 原稿を持っていない人でも、
   受け入れ条件は読める。

   ここで止めたいのは、入ってしまうと直しにくい類い:

     ・{NAME}{NAME_EUN} → 아이아이는。助詞スロットは名前ごと
       置き換わるので、{NAME} と並べると名前が二重になる
     ・日本語の行に {NAME}（ハングル）が混ざる。日本語の文の中に
       いきなり 다나카 が出る
     ・requires_name_slot と中身の食い違い。true なのに名前を使って
       いない日は、名前の無い人へ無用な登録のお願いが飛ぶ
     ・単語が 3 語でない。2 通目の見た目がその日だけ崩れる
     ・四柱（{OHAENG}/{ZODIAC}）を本文に使う。LINE から直接来た人には
       値が無く、その日で講座が**永久に止まる**（PROBES の 3 人目）
     ・説明（grammar_tip_kr）・単語（vocab_3）・運勢の一言（fortune_bridge）・
       クイズ（quiz）に差し込み口。この 4 つは fillSlots を一度も通らず、
       文字どおり画面に出る ── {NAME_EUN} も {OHAENG_GA} も同じ扱い
       （2026-08-07 대표 승인。SQL3(A) の指摘で fortune_bridge/quiz の
       OHAENG/ZODIAC が漏れていたことに気づいた）

   どれも 1 日ぶんを見ている限りは気づける。101 日を通しで
   見るのが難しいだけなので、機械に数えさせる。
   ================================================================== */
import { SLOTS, findMisplacedSlot, renderDay, renderReview,
         isNewFormat, parseTip, POS } from "./render.mjs";

const TOTAL_DAYS = 101;

/* ---- 신양식（지시서㉑ §2）--------------------------------------------
   판정은 render.mjs 의 isNewFormat 1곳: vocab_3 에 pos 가 하나라도
   있으면 신양식으로 간주하고 7규칙을 전부 강제한다. 없으면 구양식
   （기존 규칙만）으로 통과 ── 이행기 동안 서버의 기존 파일이 재시드
   가능해야 하기 때문이다.

   섹션 헤더 이모지는 코드（render.mjs）소유 ── 원고에 있으면 거부.
   303일 × 헤더 복제를 원천 차단한다（§1-1）. */
const HEADER_EMOJI = /[📘🔗💡💬📚❓🍀📌🎯🎬☕📱]/u;

/* bridge 의 운세 단정（§0-7）. 지시서의 3문자열（運がよ·운이 좋·
   運勢がよ）에 한자 「良」 표기와 「운세가 좋」을 더했다 ── 같은
   단정의 표기 변형이라 놓치면 규칙이 반쪽이 된다. */
const FORTUNE_ASSERT = /運がよ|運が良|運勢がよ|運勢が良|운이 좋|운세가 좋/;

const ANY_SLOT = /\{(NAME(?:_[A-Z]+)?)\}/g;

/* 名前だけでなく五行・干支も含めた「差し込み口らしきもの」全部。
   g を付けない ── test() を続けて呼ぶので lastIndex を持たせない。 */
const ANY_BRACE = /\{[A-Z_]+\}/;

/* パッチムのある名前と無い名前。両方で組み立ててみる ──
   片方でしか試さないと、助詞の分岐の片側が一度も動かない。 */
const PROBES = [
  /* 名前も五行も干支も、받침のある側と無い側を 1 つずつ通す。
     片側でしか試さないと、助詞の分岐の半分が一度も動かない。 */
  { name_kr: "켄", name_reading: "けん",
    ohaeng_main: "목", raw_result_json: { zodiac: "닭" } },      /* 받침あり */
  { name_kr: "사쿠라", name_reading: "さくら",
    ohaeng_main: "화", raw_result_json: { zodiac: "돼지" } },     /* 받침なし */

  /* ---- LINE から直接友だち追加した人（2026-08-07 대표 승인）----------
     名前は在るが、四柱は**永久に**空。onboarding.mjs が ohaeng_main の
     不在を「サイト診断を通っていない人」の判別そのものに使っているので、
     この人に四柱が入る道はコードのどこにも無い。

     この人で組み立てられない日を入れると、その人の講座はそこで
     永久に止まる:

       renderDay が null を返す
         → push-daily はそれを「名前が無い人」と読む
         → 日を進めない（同じ日に留まる）
         → 「お名前を登録してください」を 2 回送って、あとは黙る

     名前はもう在るので、言われたとおりにしても何も変わらない。
     四柱はサイト診断からしか入らないが、案内はその話をしない ──
     本人には出口が無い。配信は止まっていない（正常に案内を送った状態）
     ので、問い合わせが来るまで誰も気づかない。

     だから「初級では四柱を使わない」という規則ではなく、
     **「四柱の無い人が読めない日は入稿できない」**として置く ──
     規則なら人が忘れるが、これは 3 コースすべてに自動でかかる。 */
  { name_kr: "유이", name_reading: "ゆい",
    ohaeng_main: null, raw_result_json: {} }
];

/* ハングル・ひらがな・カタカナ・漢字・記号のどれでもない文字を探す。
   原稿はコピー＆ペーストで作るので、全角の空白や別言語の
   引用符が紛れ込む。読めはするが、検索や置換のときにだけ効く。 */
const ODD_CHAR = /[^\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{ASCII}　-〿＀-￯\s]/u;

/* ---- バイト水準（指示書⑮ §7）--------------------------------------
   mojibake を捕らえたのは検証網ではなく人だった。当時の検査は
   問題・正答・添字を見ても誤答選択肢の文字化けを見ていなかった。
   機械に見えるもの（UTF-8 として壊れていないか・ハングルと日本語が
   実在するか・Latin-1 誤読の痕跡）は機械に渡す。

   返す配列は「ファイル名と理由」だけ。原稿本文をログに出さない
   （指示書⑮ §4-4）。 */
const HANGUL = /[\uAC00-\uD7A3]/;
const JAPANESE = /[\u3040-\u30FF\u4E00-\u9FFF]/;
/* UTF-8 を Latin-1/Windows-1252 で読み直したときに出やすい文字。
   指示書の例（Ã ì å）に加え、ハングル壊れで頻出する Â も見る。 */
const LATIN1_MOJIBAKE = /[ÃÂåìðñòôõùýþÿ]/;

export function checkManuscriptBytes(buf, label = "原稿", {
  /* 原稿日（days[]）だけ true。fortune-lines など形の違う JSON は
     UTF-8 / mojibake だけ見て、ハングル必須は課さない。 */
  requireScripts = true
} = {}) {
  const bad = [];
  const at = (m) => bad.push(`${label}: ${m}`);
  if (!Buffer.isBuffer(buf)) {
    at("バイト列ではありません");
    return bad;
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    at("UTF-8 BOM が付いています（付けないでください）");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    at("UTF-8 として無効です（途中で切れたマルチバイトの可能性）");
    return bad;
  }
  if (LATIN1_MOJIBAKE.test(text)) {
    at("Latin-1 誤読の痕跡があります（Ã / Â / å / ì など）");
  }
  if (requireScripts) {
    if (!HANGUL.test(text)) at("ハングル（AC00–D7A3）がありません");
    if (!JAPANESE.test(text)) at("日本語（ひらがな・カタカナ・漢字）がありません");
  }
  return bad;
}

export function checkDay(d, seen = new Set()) {
  const bad = [];
  const at = (m) => bad.push(m);
  const day = Number(d?.day_number);

  if (!Number.isInteger(day) || day < 1 || day > TOTAL_DAYS) {
    return [`day_number が 1〜${TOTAL_DAYS} ではありません: ${JSON.stringify(d?.day_number)}`];
  }

  /* 重複はコースの中で見る。コースは 3 本の別の 101 日なので、
     初級 1 日目と中級 1 日目が両方あるのは正しい ── 日番号だけで
     数えると、2 コースを一度に入稿したときに全日が「2 回出てきます」
     になって、1 件も入らなくなる。 */
  const track = d.__track || "beginner";
  const key = `${track}:${day}`;
  if (seen.has(key)) at(`${track} の ${day} 日目が 2 回出てきます`);
  seen.add(key);

  /* 신·구 판정（§2 ── render.mjs 와 같은 한 문장）. 신양식이면
     7규칙 전부, 구양식이면 기존 규칙만. 마이크로는 tip 形/使/落 완화. */
  const isNew = isNewFormat(d);
  const isMicro = !!(d.hook && d.formula && d.mission);

  if (!d.grammar_point) at("grammar_point がありません");
  if (!isMicro && !d.grammar_tip_kr) at("grammar_tip_kr がありません");

  /* --- 규칙 1: tip 은 形/使/落 3행 정형（신양식·비마이크로） ---
     마이크로는 hook/formula/mission 이 본문. tip 은 저녁용으로 임의. */
  if (isNew && !isMicro && d.grammar_tip_kr && !parseTip(String(d.grammar_tip_kr))) {
    at("신양식: grammar_tip_kr 은 形・使・落 3행 정형이어야 합니다");
  }

  if (isMicro) {
    if (typeof d.hook !== "string" || !d.hook.trim()) at("마이크로: hook がありません");
    if (typeof d.formula !== "string" || !d.formula.trim()) at("마이크로: formula がありません");
    if (typeof d.mission !== "string" || !d.mission.trim()) at("마이크로: mission がありません");
    for (const [name, s] of [["hook", d.hook], ["hook_body", d.hook_body],
      ["formula", d.formula], ["mission", d.mission]]) {
      if (s == null || s === "") continue;
      if (HEADER_EMOJI.test(String(s))) {
        at(`마이크로: ${name} 에 섹션 헤더 이모지가 들어 있습니다 ── 헤더는 코드 소유입니다`);
      }
    }
    /* formula 는 전원 동일 문면 — 差し込み口 금지 */
    if (ANY_BRACE.test(String(d.formula))) {
      at("마이크로: formula に差し込み口は使えません");
    }
  }

  /* --- 説明に差し込み口は使えない（2026-08-07 대표 승인）--------------
     renderDay() は grammar_tip_kr を fillSlots に通さず、そのまま
     積む。書くと {NAME_EUN} という文字列が利用者へそのまま届く。

     下の「実際に組み立ててみる」でも落ちてはいた ── ただし
     「差し込み口が残っています」としか言わないので、**どの欄か**が
     分からない。51 日ぶん書き終えてから気づくと 51 日ぶん直すことに
     なるので、欄の名前で止める。

     直す先は fillSlots ではない。説明は全員に同じ文面で届くもの
     （「同じ説明をもう一度読む」が成り立たなくなる）。 */
  if (d.grammar_tip_kr && ANY_BRACE.test(String(d.grammar_tip_kr))) {
    at("grammar_tip_kr に差し込み口は使えません（説明は全員に同じ文面で届きます）");
  }

  /* --- 会話 --- */
  const dia = d.dialogue_template;
  /* 규칙 2: 비마이크로 신양식은 4행. 마이크로는 2~4행（샘플 톡 2행）.
     쉼일（refresh）은 대화 생략 가능. */
  const kind = d.day_kind || (isMicro
    ? (((Number(d.day_number) - 1) % 7) + 1 <= 4 ? "grammar"
      : ((Number(d.day_number) - 1) % 7) + 1 === 5 ? "talk"
      : ((Number(d.day_number) - 1) % 7) + 1 === 6 ? "quiz" : "refresh")
    : "grammar");
  if (isNew && !isMicro && Array.isArray(dia) && dia.length !== 4) {
    at(`신양식: 대화는 정확히 4행입니다（지금 ${dia.length}행）`);
  }
  if (isMicro && kind !== "refresh" && kind !== "quiz") {
    if (!Array.isArray(dia) || dia.length < 2 || dia.length > 4) {
      at(`마이크로: 대화는 2〜4행입니다（지금 ${Array.isArray(dia) ? dia.length : "配列でない"}）`);
    }
  }
  if (kind !== "refresh" && kind !== "quiz" && (!Array.isArray(dia) || dia.length < 2)) {
    at("dialogue_template は 2 文以上の配列にしてください");
  } else if (Array.isArray(dia)) {
    dia.forEach((row, i) => {
      const where = `会話 ${i + 1} 行目`;
      if (!row?.kr) return at(`${where}: kr がありません`);
      if (!row.ja)  at(`${where}: ja（日本語）がありません`);

      const mis = findMisplacedSlot(row.kr);
      if (mis) at(`${where}: 名前が二重になります → ${mis}`);

      /* 日本語の行にハングルの名前を出さない。逆も同じ。 */
      if (row.ja && /\{NAME\}/.test(row.ja)) {
        at(`${where}: 日本語の行は {NAME_JP} を使ってください（{NAME} はハングル）`);
      }
      if (/\{NAME_JP\}/.test(row.kr)) {
        at(`${where}: 韓国語の行に {NAME_JP}（かな）が入っています`);
      }
      if (row.who && findMisplacedSlot(row.who)) at(`${where}: who の中で名前が二重になります`);

      for (const s of unknownSlots(row.kr)) at(`${where}: 知らない差し込み口 {${s}}`);
      for (const s of unknownSlots(row.ja || "")) at(`${where}(日本語): 知らない差し込み口 {${s}}`);
      if (ODD_CHAR.test(row.kr)) at(`${where}: 見慣れない文字が混ざっています`);
    });
  }

  /* --- 単語 ---
     규칙 3（§0-4）: 구양식은 3어 그대로, 신양식은 6어 + 각 pos +
     품사별 정확히 2개. 지시서의 「3~6 완화」는 이행기의 수용 집합을
     말한 것 ── 실물은 구=3·신=6 뿐이므로 {3,6} 만 받는다. 4·5개짜리
     반쪽 원고까지 열어 주면 완화가 아니라 구멍이 된다. */
  const voc = d.vocab_3;
  const vocWant = isNew ? 6 : 3;
  if (!Array.isArray(voc) || voc.length !== vocWant) {
    at(`vocab_3 は${isNew ? "（신양식）6" : "ちょうど 3"} 語にしてください（今 ${Array.isArray(voc) ? voc.length : "配列でない"}）`);
  } else {
    voc.forEach((w, i) => {
      if (!w?.kr) at(`単語 ${i + 1}: kr がありません`);
      if (!w?.meaning) at(`単語 ${i + 1}: meaning（日本語）がありません`);
      /* renderDay は vocab_3 を fillSlots に通さない（そのまま push）。
         {NAME} も {OHAENG_GA} も同じく文字のまま届く。 */
      if (w?.kr && ANY_BRACE.test(w.kr)) at(`単語 ${i + 1}: 単語に差し込み口は使えません`);
    });
    if (isNew) {
      /* pos 는 분류 키 ── 값·표기는 render.mjs 의 POS 한 곳（§2-3）.
         품사별 2개가 무너지면 화면의 【名詞】12/【形容詞】34/【動詞】56
         짜임이 그날만 비뚤어진다. */
      voc.forEach((w, i) => {
        if (!w?.pos || !POS.includes(w.pos)) {
          at(`単語 ${i + 1}: pos 는 ${POS.join("・")} 중 하나여야 합니다（지금 ${JSON.stringify(w?.pos)}）`);
        }
      });
      for (const p of POS) {
        const n = voc.filter((w) => w?.pos === p).length;
        if (n !== 2) at(`신양식: ${p} 는 정확히 2개여야 합니다（지금 ${n}개）`);
      }
    }
  }

  /* --- 名前を使うかどうかの申告と、中身が合っているか ---
     who（話者の札）は数えない。札は名前が無ければ「あなた」に
     なるので、その日を配れなくする理由にはならない。

     説明（grammar_tip_kr）も数えない ── 差し込み口を置けない欄に
     なったので（上）、そこに名前が入ることはありえない。数えたままだと
     tip に書いた日が「欄が違う」と「申告が違う」の 2 つで落ちて、
     直す所がぼやける。本文（kr / ja）だけを見る。 */
  const bodyOnly = Array.isArray(dia)
    ? dia.map((r) => [r?.kr, r?.ja, r?.who]) : [];
  const microText = [d.hook, d.hook_body, d.mission].filter((x) => x != null && x !== "");
  const usesName = JSON.stringify(bodyOnly).includes("{NAME")
    || JSON.stringify(microText).includes("{NAME");
  const declared = !!d.requires_name_slot;
  if (usesName && !declared) {
    at("名前を使っているのに requires_name_slot が false です");
  }
  if (!usesName && declared) {
    /* true のままだと、名前の無い人にこの日だけ登録のお願いが飛ぶ。
       名前を使っていないなら、その人にもふつうに届けられる。 */
    at("名前を使っていないのに requires_name_slot が true です");
  }

  /* --- 🍀 今日のひとこと（任意） ---
     無くてよい。あるなら kr が要る（ja は訳なので任意）。
     列名が fortune_bridge なのは出自（運勢に添える一言）だけで、
     中身は 2026-08-07 にレッスン最下段の🍀へ移った。運勢そのものは
     2026-08-16 に廃止（docs/plan-fortune-removal.md）── 改名は
     原稿 303 日・renderDay・関門を同時に揺らすので見送っている。

     ★ 差し込み口（{NAME} など）は 1 つも許さない。値に置き換わらず、
     その 9 文字が利用者の画面にそのまま出る
     （2026-08-07、SQL3(A) の指摘で発覚）。 */
  const fb = d.fortune_bridge;
  if (fb !== undefined && fb !== null) {
    if (typeof fb !== "object" || Array.isArray(fb)) {
      at("fortune_bridge は {kr, ja} の形にしてください");
    } else {
      if (!fb.kr) at("fortune_bridge に kr がありません");
      if (fb.kr && ANY_BRACE.test(fb.kr)) at("fortune_bridge に差し込み口は使えません");
      if (fb.kr && ODD_CHAR.test(fb.kr)) at("fortune_bridge に見慣れない文字が混ざっています");
      /* 규칙 6（§0-7）: bridge 는 이제 레슨（🍀）에 실려 운세를 못 받는
         사람에게도 간다 ── 운세 단정을 쓰면 그 사람에겐 근거 없는
         운세 문장이 된다. 화면에 나가는 ja 만이 아니라 kr 도 본다
         （kr 은 집필·검수의 원본이라, 남겨 두면 번역할 때 되살아난다）. */
      if (isNew && (FORTUNE_ASSERT.test(fb.kr || "") || FORTUNE_ASSERT.test(fb.ja || ""))) {
        at("신양식: fortune_bridge 에 운세 단정（運がよ／운이 좋 류）은 쓸 수 없습니다");
      }
    }
  }

  /* --- 復習クイズ（任意、docs/plan-quiz.md） ---
     無くてよい ── 無い日は配信側が黙って抜く。あるなら形を全部見る。
     answer の範囲外は「入ってしまうと直しにくい」の典型 ──
     配信側（pickReviewQuiz）は壊れた原稿を黙って抜くので、
     入稿時に止めないと「なぜかこの日だけクイズが出ない」になる。 */
  /* 규칙 4: 신양식 퀴즈 — 문법·퀴즈일은 필수. 톡·쉼은 생략 가능
     （마이크로 포맷. 저녁은 push-evening 이 별도）. */
  const qz = d.quiz;
  const quizRequired = isNew && kind !== "refresh" && kind !== "talk";
  if (quizRequired && (qz === undefined || qz === null)) {
    at("신양식: quiz 는 필수입니다（매일 1문）");
  }
  if (qz !== undefined && qz !== null) {
    if (typeof qz !== "object" || Array.isArray(qz)) {
      at("quiz は {question, choices, answer} の形にしてください");
    } else {
      if (typeof qz.question !== "string" || !qz.question.trim()) {
        at("quiz に question がありません");
      }
      if (!Array.isArray(qz.choices) || qz.choices.length < 2 || qz.choices.length > 4) {
        at(`quiz の choices は 2〜4 個にしてください（今 ${Array.isArray(qz.choices) ? qz.choices.length : "配列でない"}）`);
      } else {
        qz.choices.forEach((c, i) => {
          if (typeof c !== "string" || !c.trim()) at(`quiz の選択肢 ${i + 1} が空です`);
        });
        if (!Number.isInteger(qz.answer) || qz.answer < 0 || qz.answer >= qz.choices.length) {
          at(`quiz の answer が選択肢の範囲外です: ${JSON.stringify(qz.answer)}（0〜${qz.choices.length - 1}）`);
        }
      }
      /* 差し込み口は許さない（NAME だけでなく全部）。クイズは
         renderReviewQuiz/renderCheckpointQuiz のどちらも fillSlots を
         通さず、question/choices をそのまま送る ── {OHAENG_GA} を
         書いても文字のまま届く。名前入りは別の理由でも不可: 正解の
         文字列が人ごとに変わって採点できない。 */
      if (ANY_BRACE.test(JSON.stringify(qz))) at("quiz に差し込み口は使えません");
    }
  }

  /* --- 규칙 5（§2-5）: 섹션 헤더 이모지는 원고에 못 넣는다 ---
     헤더는 render.mjs 소유（§1-1）── 원고에도 넣으면 화면에 두 번
     붙고, 문구를 고치는 날 303일을 같이 고치게 된다. 欄 이름으로
     멈춘다（어느 欄인지 말하지 않으면 51일 쓰고 나서 찾게 된다）. */
  if (isNew) {
    const spots = [
      ["grammar_point", d.grammar_point],
      ["grammar_tip_kr", d.grammar_tip_kr],
      ["hook", d.hook],
      ["hook_body", d.hook_body],
      ["formula", d.formula],
      ["mission", d.mission],
      ["dialogue_template", Array.isArray(dia) ? JSON.stringify(dia) : null],
      ["vocab_3", Array.isArray(voc) ? JSON.stringify(voc) : null],
      ["quiz", qz ? JSON.stringify(qz) : null],
      ["fortune_bridge", fb ? JSON.stringify(fb) : null]
    ];
    for (const [name, s] of spots) {
      if (s && HEADER_EMOJI.test(String(s))) {
        at(`신양식: ${name} 에 섹션 헤더 이모지（📘🔗💡📌💬🎯🎬❓☕📚🍀📱）가 들어 있습니다 ── 헤더는 코드 소유입니다`);
      }
    }
  }

  /* --- 実際に組み立ててみる ---
     朝（renderDay）と夕方（renderReview）の両方を通す。夕方だけで
     落ちる原稿がありうる ── 復習は会話から 1 文だけ抜き出すので、
     その 1 文にだけ問題があると朝は通って夕方で崩れる。 */
  for (const probe of PROBES) {
    for (const [label, fn] of [["朝", renderDay], ["夕", renderReview]]) {
      let msgs;
      try {
        msgs = fn(d, probe);
      } catch (e) {
        at(`${probe.name_kr} の${label}で組み立てに失敗: ${e.message}`);
        continue;
      }
      if (!msgs) {
        /* 名前は在るのに組めない ＝ 名前以外の差し込み口を使っている。
           四柱の無い人（PROBES の 3 人目）には入る道が無いので、
           その日は永久に止まる。理由を名指しで言う ── 「組み立てられ
           ませんでした」だけだと、名前を入れ忘れたのかと読む。 */
        const hint = probe.ohaeng_main ? ""
          : "（{OHAENG}/{ZODIAC} を使っていませんか ── LINE から直接来た方には値がありません）";
        at(`${probe.name_kr} の${label}で組み立てられませんでした${hint}`);
        continue;
      }

      const kr = probe.name_kr;
      for (const m of msgs) {
        if (m.text.includes(kr + kr)) at(`${kr} の${label}で名前が二重に出ます`);
        if (/\{[A-Z_]+\}/.test(m.text)) {
          at(`${kr} の${label}で差し込み口が残っています: ${m.text.match(/\{[A-Z_]+\}/)[0]}`);
        }
      }
    }
  }

  return bad.map((m) => `${track} ${day}日目: ${m}`);
}

function unknownSlots(text) {
  const out = [];
  for (const m of String(text).matchAll(ANY_SLOT)) {
    if (!SLOTS.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/* まとめて見る。日の抜けも数える ── 101 日を売る以上、
   「買ったのに 87 日目が来ない」は起きてはいけない。 */
export function checkAll(days, { expect = null, track = null } = {}) {
  const seen = new Set();
  const problems = [];
  for (const d of days) problems.push(...checkDay(d, seen));

  if (expect) {
    /* 抜けを見るのは 1 コースぶんのとき。track を渡さないと、
       どのコースの何日目を期待しているのかが決まらない。 */
    const t = track || "beginner";
    const missing = [];
    for (let n = expect.from; n <= expect.to; n++) if (!seen.has(`${t}:${n}`)) missing.push(n);
    if (missing.length) problems.push(`${t} で抜けている日: ${missing.join(", ")}`);
  }

  /* 同じ文法が二度出ていないか。気づかずに重ねると、
     101 日ぶんに見えて中身が減る。

     コースごとに見る。初級の「-입니다」と中級の「-입니다」は
     別の講座の別の日なので、重なっていても間違いではない。 */
  const points = new Map();
  for (const d of days) {
    const p = String(d.grammar_point || "").trim();
    if (!p) continue;
    const t = d.__track || "beginner";
    const k = `${t}:${p}`;
    if (points.has(k)) problems.push(`${t} ${d.day_number}日目: ${points.get(k)}日目と同じ文法「${p}」`);
    else points.set(k, d.day_number);
  }

  return { ok: problems.length === 0, problems, count: seen.size };
}

export { PROBES, TOTAL_DAYS };
