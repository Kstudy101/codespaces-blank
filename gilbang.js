/* ==================================================================
   gilbang.js — 方位（恵方・손없는 날・五行の方位）

   ブラウザでも Node でも動く。検証は tools/verify-gilbang.mjs が
   このファイルをそのまま読み込んで走らせる。

     <script src="/saju.js"></script>
     <script src="/gilbang.js"></script>
     Gilbang.load(await (await fetch('/new-moons.json')).json());
     Gilbang.son('2026-08-01');            // 손없는 날 か、손のいる方角
     Gilbang.eho(today.year.stemIdx);      // その年の恵方
     Gilbang.mine(Saju.pillars({...}));    // 命式に足りない五行の方位

   3 つとも「方位」だが、決め方も変わる周期も違う。

     恵方          年の十干で決まる。1 年ごと・全員同じ
     손없는 날     旧暦の日付の一の位で決まる。日ごと・全員同じ
     五行の方位    その人の命式と今日の日辰で決まる。人ごと・日ごと

   恵方が 4 方向しかないのも、손이 5 日ごとに移るのも、こちらで
   決めたことではなく、それぞれの言い伝えがそう決めている。
   ================================================================== */
(function (root) {
  "use strict";

  /* ---- 方位 ------------------------------------------------------------
     deg は北を 0 として時計回り。中央だけ角度を持たない。            */
  var DIR = {
    n:   { ja:"北",     ko:"북",   deg:0   },
    e:   { ja:"東",     ko:"동",   deg:90  },
    s:   { ja:"南",     ko:"남",   deg:180 },
    w:   { ja:"西",     ko:"서",   deg:270 },
    c:   { ja:"中央",   ko:"중앙", deg:null },
    ene: { ja:"東北東", ko:"동북동", deg:75  },
    wsw: { ja:"西南西", ko:"서남서", deg:255 },
    sse: { ja:"南南東", ko:"남남동", deg:165 },
    nnw: { ja:"北北西", ko:"북북서", deg:345 }
  };

  /* ---- 恵方 ------------------------------------------------------------
     年の十干で決まり、4 方向しかない。十干は 10 あるので 2〜3 個ずつ
     同じ方向に割り当てられる（戊・癸は丙と同じ）。

     切り替わるのは立春。節分の豆まきが前日なのはそのため。
     Saju.pillars() の年柱は立春で切り替わるので、その stemIdx を
     そのまま渡せばよい。                                            */
  var EHO = ["ene", "wsw", "sse", "nnw", "sse",     // 甲 乙 丙 丁 戊
             "ene", "wsw", "sse", "nnw", "sse"];    // 己 庚 辛 壬 癸

  function eho(stemIdx) {
    var i = ((stemIdx % 10) + 10) % 10;
    return { key: EHO[i], dir: DIR[EHO[i]] };
  }

  /* ---- 五行の方位 ------------------------------------------------------
     木＝東、火＝南、土＝中央、金＝西、水＝北。四季と結びついた
     いちばん基本の対応で、これも決め事ではなく通説どおり。          */
  var BY_ELEMENT = { 목:"e", 화:"s", 토:"c", 금:"w", 수:"n" };

  function ofElement(el) {
    var k = BY_ELEMENT[el];
    return k ? { key: k, dir: DIR[k], element: el } : null;
  }

  /* 命式に足りない五行の方位。fortune.js と同じ「土は地支 12 のうち 4 つ
     あるので多くて当たり前」という比率を基準にする ── 5 等分で測ると
     誰でも土が過多に見え、全員の吉方が中央以外になる。             */
  var SHARE = { 목:0.18333, 화:0.18333, 토:0.26667, 금:0.18333, 수:0.18333 };

  function mine(saju) {
    if (!saju || !saju.elements) throw new Error("四柱が要ります");
    var total = 0, e;
    for (e in saju.elements) total += saju.elements[e];

    var worst = null, worstLack = -Infinity, all = [];
    for (e in SHARE) {
      var expect = SHARE[e] * total;
      var lack = (expect - (saju.elements[e] || 0)) / expect;
      all.push({ element: e, lack: Math.round(lack * 100) / 100,
                 count: saju.elements[e] || 0, key: BY_ELEMENT[e] });
      if (lack > worstLack) { worstLack = lack; worst = e; }
    }
    all.sort(function (a, b) { return b.lack - a.lack; });
    return { element: worst, key: BY_ELEMENT[worst], dir: DIR[BY_ELEMENT[worst]],
             lack: Math.round(worstLack * 100) / 100, all: all };
  }

  /** 今日の日辰（日干）の五行が向く方位。全員に共通で、日ごとに変わる。 */
  function flow(today) {
    if (!today || !today.day) throw new Error("今日の四柱が要ります");
    return ofElement(today.day.element);
  }

  /* ---- 손없는 날 -------------------------------------------------------
     旧暦の日付の一の位で、손（＝厄）のいる方角が決まる。

       1・2 일 → 동   3・4 일 → 남   5・6 일 → 서   7・8 일 → 북
       9・0 일 → 손이 없다（どの方角でもよい）

     つまり 10 日のうち 2 日は「どこへ動いてもよい日」で、引っ越しや
     開店の日取りに今も使われている。旧暦の「日」しか要らないので、
     朔の日付さえあれば出る ── 閏月をどこに置くかという旧暦のいちばん
     厄介な部分は月の番号にしか効かない。                            */
  var SON = { 1:"e", 2:"e", 3:"s", 4:"s", 5:"w", 6:"w", 7:"n", 8:"n", 9:null, 0:null };

  var moons = null;        // 朔の通日（昇順）

  function load(json) {
    if (!json || json.v !== 1 || !json.t) throw new Error("new-moons.json が読めません");
    var base = dayNum(json.base), acc = 0, out = [];
    for (var i = 0; i < json.t.length; i++) { acc += json.t[i]; out.push(base + acc); }
    moons = { list: out, range: json.range };
    return moons;
  }

  /** "YYYY-MM-DD" → 1970-01-01 からの日数。 */
  function dayNum(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
    if (!m) throw new Error("日付の形式が違います: " + dateStr);
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  }

  /**
   * その日の旧暦の日と、손のいる方角。
   * @returns {{lunarDay:number, key:?string, dir:?object, free:boolean}}
   */
  function son(dateStr) {
    if (!moons) throw new Error("Gilbang.load() を先に呼んでください");
    var n = dayNum(dateStr), a = moons.list;
    if (n < a[0] || n > a[a.length - 1] + 30)
      throw new RangeError("朔の表の範囲外です: " + dateStr);

    // その日以前で最も近い朔＝その旧暦月の 1 日
    var lo = 0, hi = a.length - 1, at = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (a[mid] <= n) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at < 0) throw new RangeError("朔の表の範囲外です: " + dateStr);

    var lunarDay = n - a[at] + 1;
    var key = SON[lunarDay % 10];
    return { lunarDay: lunarDay, key: key, dir: key ? DIR[key] : null, free: !key };
  }

  root.Gilbang = {
    DIR: DIR, EHO: EHO, BY_ELEMENT: BY_ELEMENT, SON: SON,
    load: load, eho: eho, mine: mine, flow: flow, son: son,
    ofElement: ofElement, _dayNum: dayNum,
    _moons: function () { return moons; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
