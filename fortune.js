/* ==================================================================
   fortune.js — 今日の運勢の点数（6 項目）と、前回との比較

   ブラウザでも Node でも同じものが動く。検証は tools/verify-fortune.mjs が
   このファイルをそのまま読み込んで走らせる。

     <script src="/saju.js"></script>
     <script src="/fortune.js"></script>
     var mine  = Saju.pillars({ y:1990, m:5, d:17, hour:14, city:'seoul' });
     var today = Saju.pillars({ y:2026, m:8, d:1, hour:12, city:'seoul' });
     Fortune.of(mine, today);

   決めごと:

     ・乱数を使わない。同じ生年月日＋同じ日付なら必ず同じ点数になる。
       更新のたびに数字が変わると「前回と比べて」が意味を失う
     ・保存するのは日付と 6 個の整数だけ。生年月日は保存しない
       （docs/plan-fortune-content.md §4）
     ・1 日 1 回の制限は要らない。決定論なので引き直しても同じ数字が出る

   点数の作り方は 3 つの足し算で、それぞれ役割が違う（§6-1）:

     ① 十神   今日の五行と「自分の日干」の関係。人によって違い、日で変わる
     ② 日辰   今日の五行と「項目の五行」の関係。人によらず、日で変わる
     ③ 過不足 自分の四柱にその五行がどれだけあるか。人によって違い、日で変わらない

   ① だけだと同じ日は全員同じ形になり、③ だけだと毎日同じ数字になる。
   両方入れて初めて「自分の」「今日の」運勢になる。
   ================================================================== */
(function (root) {
  "use strict";

  // 相生（生む）と相剋（剋す）。saju.js と同じ五行表記を使う。
  var GEN = { 목:"화", 화:"토", 토:"금", 금:"수", 수:"목" };
  var CON = { 목:"토", 토:"수", 수:"화", 화:"금", 금:"목" };

  /* ---- 6 項目 --------------------------------------------------------
     学習運があるのは、ここが韓国語の学習サイトだから。運勢が悪い日を
     「今日は駄目」で終わらせず、一語だけでも触る口実にするために置く。 */
  var CATS = [
    { id:"total",  el:null, ko:"총운",   ja:"総合運" },
    { id:"money",  el:"금", ko:"재물운", ja:"金運"   },
    { id:"love",   el:"수", ko:"연애운", ja:"恋愛運" },
    { id:"work",   el:"목", ko:"사업운", ja:"仕事運" },
    { id:"health", el:"토", ko:"건강운", ja:"健康運" },
    { id:"study",  el:"화", ko:"학업운", ja:"学習運" }
  ];

  /* ---- ① 十神 --------------------------------------------------------
     自分の日干（日柱の天干＝命式の主体）から見て、今日の干支が何にあたるか。
     命理でいちばん基本の見方で、これがあるので同じ日でも人により違う形になる。

     陰陽まで見て 10 種類に分ける。五行だけの 5 種類でも通りはするが、
     それだと甲と乙が同じ扱いになり、60 日ある日辰が 25 通りに潰れる。
     実際そうなっていて、同じ点数の日が 60 日のうち何度も出ていた。
     連続した 2 日が同点になると「前回と比べて」が 0 ばかりになる。      */
  function god(dmEl, dmYang, el, yang) {
    var same = dmYang === yang;
    if (el === dmEl)      return same ? "비견" : "겁재";   // 同類 — 体力・競争
    if (GEN[dmEl] === el) return same ? "식신" : "상관";   // 自分が生む — 表現
    if (CON[dmEl] === el) return same ? "편재" : "정재";   // 自分が剋す — 財
    if (CON[el] === dmEl) return same ? "편관" : "정관";   // 自分を剋す — 役目
    return same ? "편인" : "정인";                          // 自分を生む — 学び
  }

  // 十神が各項目にどう効くか。財は金運、官は仕事、印は学習…という
  // 対応そのものは命理の通説どおりで、ここで発明したものではない。
  //
  // 列（項目ごと）の合計を 0 に揃えてある。揃えないと項目ごとに平均が
  // ずれ、健康運だけ毎日低い、学習運だけ毎日高い、という表が出てくる。
  // 実際そうなったので直した。行（十神ごと）の合計は 0 でなくてよい ──
  // 財の日は金運に効いて学習には効かない、というのはそのまま意味になる。
  //
  // 正（陰陽が異なる）と偏（同じ）で少しずらしてある。正財はこつこつ、
  // 偏財は出入りが大きい、という通説どおりの向き。2 つの平均は
  // 五行だけで見たときの値に一致するので、列の合計は 0 のまま。
  var BY_GOD = {
    정재: { money: 3.5, love: 1.5, work:  1,   health:-1,   study:-2   },
    편재: { money: 2.5, love: 0.5, work:  1,   health:-1,   study:-2   },
    정관: { money: 0,   love:-1,   work:  2.5, health:-1.5, study: 1.5 },
    편관: { money: 0,   love:-1,   work:  3.5, health:-2.5, study: 0.5 },
    정인: { money:-1,   love:-1,   work: -2,   health: 0.5, study: 3.5 },
    편인: { money:-1,   love:-1,   work: -2,   health: 1.5, study: 2.5 },
    식신: { money: 0,   love: 2.5, work: -2,   health:-1,   study: 1.5 },
    상관: { money: 0,   love: 3.5, work: -2,   health:-1,   study: 0.5 },
    비견: { money:-2,   love:-2.5, work:  0,   health: 3.5, study:-3   },
    겁재: { money:-2,   love:-1.5, work:  0,   health: 2.5, study:-3   }
  };

  /* ---- ② 日辰と項目の五行 ---------------------------------------------
     5 つの値の平均 0.8 を引いて中心を 0 にしてある。引かないと全項目に
     同じ下駄が乗るだけで、基準の 50 が「真ん中」でなくなる。           */
  function elementEffect(src, dst) {
    if (src === dst)      return  3 - 0.8;   // 比和 — 勢いが同じ
    if (GEN[src] === dst) return  4 - 0.8;   // 生を受ける
    if (CON[src] === dst) return -3 - 0.8;   // 剋を受ける
    if (GEN[dst] === src) return -1 - 0.8;   // 洩らす — 力が抜ける
    return 1 - 0.8;                          // dst が src を剋す — 取りにいける
  }

  /* ---- ③ 自分の五行の過不足 -------------------------------------------
     足りない五行の項目は、今日それが巡ってくると効きが大きくなる。

     基準を「5 等分」にしてはいけない。十二支のうち土は辰戌丑未の 4 つで、
     他の五行の 2 つに対して倍ある。つまり四柱は土が多くなるのが普通で、
     5 等分を基準にすると誰の命式も土「過多」と判定され、土の項目
     （健康運）だけが毎日低く出る。実際そうなったので、天干（各五行 2/10）
     と地支（土だけ 4/12）から出た自然な割合を基準にする。            */
  var SHARE = { 목:0.18333, 화:0.18333, 토:0.26667, 금:0.18333, 수:0.18333 };

  function lack(el, target, total) {
    var expect = SHARE[target] * total;
    var d = (expect - (el[target] || 0)) / expect;
    return d > 1 ? 1 : d < -1 ? -1 : d;
  }

  function clamp(n) { return n < 0 ? 0 : n > 100 ? 100 : n; }

  /* ---- 暦の偏りを引く -------------------------------------------------
     ①② をそのまま足すと、項目ごとに平均がずれる。土が地支 12 のうち
     4 つを占めるせいで、日辰の五行が一様ではないからで、たとえば
     「土 → 金」の生を受ける金運は放っておくと平均が高く出る。

     そこで各項目について「日辰が一巡したときの平均」を出して引く。
     こうすると 50 は万人共通の 50 ではなく、その人にとっての平年並みに
     なり、6 項目を横に並べて比べられるようになる。

     平均は 60 日を数え上げて出す。天干と地支を別々に平均してはいけない
     ── 六十干支では甲（陽）に組むのは陽の地支だけで、陰陽が連動して
     いるから。五行だけ見ていた頃は連動しても内訳が変わらず問題に
     ならなかったが、十神を陰陽まで見るようにした時点で効いてくる。     */
  var STEM_FREQ   = { 목:0.2, 화:0.2, 토:0.2, 금:0.2, 수:0.2 };
  var BRANCH_FREQ = { 목:1/6, 화:1/6, 토:1/3, 금:1/6, 수:1/6 };

  /** ①② の合計。flow は [{el,yang,w}...]。 */
  function daily(dm, flow, c) {
    var s = 0;
    for (var i = 0; i < flow.length; i++) {
      s += 4 * flow[i].w * BY_GOD[god(dm.el, dm.yang, flow[i].el, flow[i].yang)][c.id] / 3;
      s += 2 * flow[i].w * elementEffect(flow[i].el, c.el) / 3;
    }
    return s;
  }

  /** 六十干支のうち k 番目の日の五行。 */
  function dayFlow(k) {
    var S = root.Saju;
    if (!S) throw new Error("saju.js を先に読み込んでください");
    var si = k % 10, bi = k % 12;
    return [
      { el: S.STEM_ELEMENT[si],   yang: si % 2 === 0, w: 2 },
      { el: S.BRANCH_ELEMENT[bi], yang: bi % 2 === 0, w: 1 }
    ];
  }

  /** daily() を日辰一巡（60 日）で平均したもの。日干ごとに 1 度だけ計算する。 */
  var expCache = {};
  function expected(dm, c) {
    var key = dm.el + (dm.yang ? "+" : "-") + c.id;
    if (key in expCache) return expCache[key];
    var s = 0;
    for (var k = 0; k < 60; k++) s += daily(dm, dayFlow(k), c);
    return (expCache[key] = s / 60);
  }

  /* ---- 等級 ----------------------------------------------------------
     5 段階。境目は 4 で割った位置ではなく、点数の出方に合わせてある
     （tools/verify-fortune.mjs が分布を見ている）。                    */
  var GRADES = [
    { min: 80, ko:"대길", ja:"大吉" },
    { min: 65, ko:"길",   ja:"吉"   },
    { min: 50, ko:"중길", ja:"中吉" },
    { min: 35, ko:"소길", ja:"小吉" },
    { min:  0, ko:"말길", ja:"末吉" }
  ];

  function grade(n) {
    for (var i = 0; i < GRADES.length; i++) if (n >= GRADES[i].min) return GRADES[i];
    return GRADES[GRADES.length - 1];
  }

  /**
   * @param {object} mine  Saju.pillars() の結果（本人）
   * @param {object} today Saju.pillars() の結果（今日の日付・正午で引いたもの）
   */
  function of(mine, today) {
    if (!mine || !today) throw new Error("四柱が要ります");

    // 日干＝命式の主体。天干は偶数が陽（甲丙戊庚壬）。
    var dm = { el: mine.day.element, yang: mine.day.stemIdx % 2 === 0 };
    // 今日の干支。天干を 2、地支を 1 で見る（天干の方が表に出る）。
    var flow = [
      { el: today.day.element,       yang: today.day.stemIdx % 2 === 0,   w: 2 },
      { el: today.day.branchElement, yang: today.day.branchIdx % 2 === 0, w: 1 }
    ];
    var total = 0, id;
    for (id in mine.elements) total += mine.elements[id];

    var out = { scores: {}, grades: {}, god: {}, el: {} };

    // 今日の十神（表示にも使うので残す）
    out.god.stem   = god(dm.el, dm.yang, flow[0].el, flow[0].yang);
    out.god.branch = god(dm.el, dm.yang, flow[1].el, flow[1].yang);

    var sum = 0, n = 0;
    for (var i = 0; i < CATS.length; i++) {
      var c = CATS[i];
      if (!c.el) continue;                            // 総合運は最後にまとめる

      var s = 50 + daily(dm, flow, c) - expected(dm, c) // ①②から暦の偏りを引く
                 + 12 * lack(mine.elements, c.el, total);           // ③

      out.scores[c.id] = clamp(Math.round(s));
      out.grades[c.id] = grade(out.scores[c.id]);
      out.el[c.id] = c.el;
      sum += out.scores[c.id]; n++;
    }

    // 総合運は 5 項目の平均「ではない」。平均にすると項目どうしが打ち消し
    // 合い、誰のどの日を見ても中吉しか出ない表になる（実際そうなった）。
    // 代わりに「今日巡ってきた五行が、自分に足りないものを埋めるか」を
    // 直接見る。命式に足りない五行が回ってくる日を良しとするのは、
    // 用神を採る考え方そのもの。
    var fit = 0, e, m;
    for (e in mine.elements) {
      var need = lack(mine.elements, e, total), got = 0, base = 0;
      for (m = 0; m < flow.length; m++) got += flow[m].w * elementEffect(flow[m].el, e);
      // 項目と同じ理由で、ここも日辰一巡ぶんの平均を引く
      for (m in STEM_FREQ)   base += 2 * STEM_FREQ[m]   * elementEffect(m, e);
      for (m in BRANCH_FREQ) base += 1 * BRANCH_FREQ[m] * elementEffect(m, e);
      fit += need * (got - base);
    }

    out.fit = Math.round(fit * 10) / 10;
    out.scores.total = clamp(Math.round(50 + 1.9 * fit + 0.7 * (sum / n - 50)));
    out.grades.total = grade(out.scores.total);

    return out;
  }

  /* ---- 保存と比較 -----------------------------------------------------
     入れるのは日付と 6 個の整数だけ。生年月日は入れない。この 6 個から
     本人にたどり着く方法は無いが、生年月日そのものは 5,200 万通りしか
     なく、保存すれば（ハッシュにしても）復元できてしまう（§4）。

     同一人物かどうかは確かめない。確かめる手段を持たないという選択なので、
     表示は「あなたの昨日」ではなく「前回の結果と比べて」にし、実際の
     日付を必ず出す。4 日空いたものを「昨日」と呼べば嘘になる。         */

  var KEY = "k101.fortune";

  function store() {
    try {
      var s = root.localStorage;
      s.setItem(KEY + ".t", "1"); s.removeItem(KEY + ".t");   // 私用モード対策
      return s;
    } catch (e) { return null; }
  }

  /** 保存されている { prev, cur } を返す。無ければ両方 null。 */
  function load() {
    var s = store(), empty = { prev: null, cur: null };
    if (!s) return empty;
    try {
      var o = JSON.parse(s.getItem(KEY) || "null");
      if (!o || o.v !== 1) return empty;
      return { prev: o.prev || null, cur: o.cur || null };
    } catch (e) { return empty; }
  }

  /**
   * 今日ぶんを書き、比較に使う「前回」を返す。
   * 同じ日に何度呼ばれても前回は上書きされない（決定論なので値も変わらない）。
   */
  function save(dateStr, scores) {
    var cur = load(), prev = cur.prev;
    if (cur.cur && cur.cur.d === dateStr) {
      prev = cur.prev;                       // 今日ぶんは既にある。前回は動かさない
    } else if (cur.cur) {
      prev = cur.cur;                        // 日が変わった。今までの「今日」が前回になる
    }
    var s = store();
    if (s) {
      try {
        s.setItem(KEY, JSON.stringify({
          v: 1, prev: prev, cur: { d: dateStr, s: pack(scores) }
        }));
      } catch (e) { /* 容量超過などは黙って諦める。運勢は表示できる */ }
    }
    return prev;
  }

  // 保存は配列にする。キー名まで持つと嵩むうえ、順序は CATS で決まっている。
  function pack(scores) {
    var a = [];
    for (var i = 0; i < CATS.length; i++) a.push(scores[CATS[i].id]);
    return a;
  }

  function unpack(a) {
    var o = {};
    for (var i = 0; i < CATS.length; i++) o[CATS[i].id] = a[i];
    return o;
  }

  /** 前回との差。prev が無ければ null（初回は比較欄を出さない）。 */
  function diff(scores, prev) {
    if (!prev || !prev.s) return null;
    var was = unpack(prev.s), out = { date: prev.d, by: {} };
    for (var i = 0; i < CATS.length; i++) {
      var id = CATS[i].id;
      out.by[id] = scores[id] - was[id];
    }
    return out;
  }

  function clear() {
    var s = store();
    if (s) { try { s.removeItem(KEY); } catch (e) {} }
  }

  root.Fortune = {
    of: of, grade: grade, CATS: CATS, GRADES: GRADES,
    load: load, save: save, diff: diff, clear: clear,
    KEY: KEY, _god: god, _pack: pack, _unpack: unpack
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
