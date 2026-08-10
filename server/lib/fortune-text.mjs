/* ==================================================================
   lib/fortune-text.mjs — 数字と十神を、読める文にする

   lib/fortune.mjs が返すのは点数と十神まで。

     { scores: { total:37, money:48, … },
       grades: { total: { ko:"소길", ja:"小吉" }, … },
       god:    { stem:"정인", branch:"정관" }, … }

   「오늘은 정인의 날이라 배움에 좋습니다」のような**言葉**は
   人が書く（plan-fortune-daily.md §4）。書いたものが
   server/content/fortune-lines.json で、ここはそれを当てはめる。

   【なぜ文面をリポジトリに置かないか】
   101 日の原稿と同じ理由。このリポジトリは public で、有料で配る
   ものを置けば誰でも取れる。1 度 push すれば履歴に残り、あとから
   消しても戻らない（.gitignore の server/content/ の注記）。

   受け入れる条件（checkLines）はコードなのでコミットする ──
   文面を持っていない人でも「何を満たすべきか」は読める。
   lib/content-check.mjs と同じ立て付け。

   【文面が無いときは運勢を送らない】
   既定の文を埋め込まない。埋め込むと、入稿し忘れた日に全員へ
   同じ当たり障りのない一言が届き、しかもそれが「今日の運勢」として
   読まれる。無ければ黙って落とす方が正しい ── レッスン本体は
   それとは別に届く。
   ================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 出どころは 1 つ。lib/fortune.mjs（サイトの fortune.js）と
   同じ並びで、ずれると当てはめ先が無くなる。verify がつき合わせる。 */
export const CAT_IDS = Object.freeze(
  ["total", "money", "love", "work", "health", "study"]);

export const GRADES_KO = Object.freeze(
  ["대길", "길", "중길", "소길", "말길"]);

export const SIPSIN = Object.freeze(
  ["비견", "겁재", "식신", "상관", "편재", "정재", "편관", "정관", "편인", "정인"]);

/* 画面に出す項目名。fortune.js の CATS と同じものを持つ ──
   持たずに CATS から取ると、運勢エンジンが読めない環境
   （文面だけ検査したいとき）でこのファイルが動かなくなる。 */
const CAT_LABELS = Object.freeze({
  total:  { ko: "총운",   ja: "総合運" },
  money:  { ko: "재물운", ja: "金運"   },
  love:   { ko: "연애운", ja: "恋愛運" },
  work:   { ko: "사업운", ja: "仕事運" },
  health: { ko: "건강운", ja: "健康運" },
  study:  { ko: "학업운", ja: "学習運" }
});


/* ---- 受け入れる条件 ------------------------------------------------
   欠番を数える。30 マスのうち 1 つでも空いていると、その等級に
   当たった日だけ運勢が落ちる ── 落ちた日は「今日は運勢が無い日」に
   見えるので、入稿漏れだと気づけない。

   問題の一覧を返す（throw しない）。入稿の場面では全部まとめて
   見たいので、1 つ目で止まると直すのに何往復もすることになる。 */
export function checkLines(lines) {
  const bad = [];
  if (!lines || typeof lines !== "object") return ["fortune-lines.json が読めません"];

  const cats = lines.cats;
  if (!cats || typeof cats !== "object") {
    bad.push("cats がありません");
  } else {
    for (const id of CAT_IDS) {
      const g = cats[id];
      if (!g || typeof g !== "object") { bad.push(`cats.${id} がありません`); continue; }
      for (const grade of GRADES_KO) {
        const line = g[grade];
        if (!line || !line.kr || !line.ja) bad.push(`cats.${id}.${grade} が空です`);
      }
      for (const k of Object.keys(g)) {
        if (!GRADES_KO.includes(k)) bad.push(`cats.${id}.${k} は等級にありません`);
      }
    }
    for (const k of Object.keys(cats)) {
      if (!CAT_IDS.includes(k)) bad.push(`cats.${k} は項目にありません`);
    }
  }

  const s = lines.sipsin;
  if (!s || typeof s !== "object") {
    bad.push("sipsin がありません");
  } else {
    for (const name of SIPSIN) {
      const line = s[name];
      if (!line || !line.kr || !line.ja) bad.push(`sipsin.${name} が空です`);
    }
    for (const k of Object.keys(s)) {
      if (!SIPSIN.includes(k)) bad.push(`sipsin.${k} は十神にありません`);
    }
  }

  return bad;
}


/* ---- 読み込み ------------------------------------------------------
   1 度だけ読んで持つ。配信バッチは全員ぶんを回すので、
   人数ぶん読み直すと同じ内容を何百回も開くことになる。

   無ければ null。例外にしないのは、文面が未入稿でも
   レッスンは配れるようにするため（呼ぶ側が運勢だけ落とす）。 */
let cached;

export function loadLines(dir = path.join(SERVER_DIR, "content")) {
  if (cached !== undefined) return cached;

  const file = path.join(dir, "fortune-lines.json");
  if (!fs.existsSync(file)) { cached = null; return cached; }

  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const bad = checkLines(parsed);
  if (bad.length) {
    /* 欠けたまま配ると、当たった人にだけ運勢が消える。
       止めた方が気づける ── 止まれば cron の失敗通知に出る。 */
    throw new Error(`fortune-lines.json に ${bad.length} 件の問題があります:\n  ` + bad.join("\n  "));
  }
  cached = parsed;
  return cached;
}


/* ---- 文にする ------------------------------------------------------
   出す順:

     1  総合運の等級と一言
     2  なぜ今日がそうなのか（十神）
     3  その日いちばん高い項目と、いちばん低い項目
     4  残りの項目は等級だけ 1 行に畳む

   かつてここに 5 番目（fortune_bridge ── その日の文法で言い直した
   一言）が居たが、지시서㉑ §1-3 でレッスンの最下段（🍀 今日のひとこと、
   lib/render.mjs）へ移した。運勢メッセージは bridge を知らない ──
   両方に出すと同じ一言が朝の便に二度並ぶ（verify-push が見張る）。

   3 を「高い方と低い方」にしてあるのは、6 項目すべてに一言を
   付けると韓国語と訳で 12 行になり、レッスン本体より長くなるため。
   日によって当たる項目が変わるので、30 マスは満遍なく使われる。

   韓国語を先、日本語を後。運勢そのものが教材になる
   （plan-fortune-daily.md §4）ので、先に韓国語を読ませる。 */
/* ---- 高い項目・低い項目の判定 ── ここ 1 か所だけ --------------------
   運勢本文（fortuneMessage）と、その日いちばん弱い所を補う부적
   （지시서⑪ ── bottom がそのまま願い cat になる）が同じ答えを見る。
   二か所に持つと、直した日に本文の「いちばん低い」と부적の願いが
   割れて、読んだ人にはただの故障に見える。

   同点は CAT_IDS の並びを 2 次基準にして**決定的**に選ぶ ── sort の
   比較関数だけだと同点の順序は実装依存で、同じ人に 2 回計算して
   別の答えが出うる（지시서⑪ §2-2 が指摘した潜在欠陥）。total は
   全体なので候補から外す ── 부적の願いとしても具体でなくなる。 */
export function rankCats(scores) {
  const others = CAT_IDS.filter((id) => id !== "total" && scores?.[id] !== undefined);
  if (!others.length) return { top: null, bottom: null };
  const sorted = [...others].sort((a, b) =>
    (scores[b] - scores[a]) || (CAT_IDS.indexOf(a) - CAT_IDS.indexOf(b)));
  return { top: sorted[0], bottom: sorted[sorted.length - 1] };
}

export function fortuneMessage(fortune, lines) {
  if (!fortune || !lines) return null;

  const { scores, grades, god } = fortune;
  if (!scores || !grades) return null;

  const pick = (id) => {
    const g = grades[id];
    const cell = g && lines.cats[id] ? lines.cats[id][g.ko] : null;
    return cell || null;
  };

  const out = [];

  /* 1. 総合運 */
  const tg = grades.total;
  out.push(`🔮 오늘의 운세　총운 ${tg.ko}（${tg.ja}）`);

  const total = pick("total");
  if (total) out.push("", total.kr, total.ja);

  /* 2. 十神。日干から見た今日の天干を使う（fortune.js の god.stem）。
        地支（god.branch）も出せるが、2 つ並べると「どちらが今日か」が
        読めなくなるので、主体である天干だけにする。 */
  const sip = god && god.stem ? lines.sipsin[god.stem] : null;
  if (sip) out.push("", sip.kr, sip.ja);

  /* 3. 高い項目と低い項目。total は全体なので外す。
     判定は rankCats **1 か所**（下）── 부적（지시서⑪）と共有。 */
  const { top, bottom } = rankCats(scores);
  if (top) {

    for (const id of top === bottom ? [top] : [top, bottom]) {
      const cell = pick(id);
      if (!cell) continue;
      const l = CAT_LABELS[id];
      out.push("", `${l.ko}（${l.ja}）${grades[id].ja}`, cell.kr, cell.ja);
    }

    /* 4. 残りは等級だけ。 */
    const rest = CAT_IDS.filter((id) =>
      id !== "total" && scores[id] !== undefined && id !== top && id !== bottom);
    if (rest.length) {
      out.push("", rest.map((id) => `${CAT_LABELS[id].ko} ${grades[id].ko}`).join("　"));
    }
  }

  return { type: "text", text: out.join("\n") };
}
