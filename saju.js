/* ==================================================================
   saju.js — 四柱（年柱・月柱・日柱・時柱）の算出

   ブラウザでも Node でも同じものが動く。検証は tools/verify-saju.mjs が
   このファイルをそのまま読み込んで走らせるので、実装は 1 つしかない。

     <script src="/saju.js"></script>
     Saju.load(await (await fetch('/solar-terms.json')).json());
     Saju.pillars({ y:1990, m:5, d:17, hour:14, minute:30, city:'seoul' });

   決めごと（どれも流派で割れるので、1 つに固定して表に出さない）:

     ・年柱は立春で切り替える（元日でも旧正月でもない）
     ・月柱は 12 の「節」で切り替える（中気ではない）
     ・時刻は真太陽時に直してから時柱を出す。経度差と均時差の両方を入れる
     ・日柱は真太陽時 23:00 で翌日に送る（早子時。夜子時は採らない）

   計算に外部データが要るのは年柱と月柱だけで、必要なのは節気の時刻のみ。
   solar-terms.json がそれ。日柱は 60 日周期の算術で出る。
   ================================================================== */
(function (root) {
  "use strict";

  var STEM   = ["갑", "을", "병", "정", "무", "기", "경", "신", "임", "계"];
  var BRANCH = ["자", "축", "인", "묘", "진", "사", "오", "미", "신", "유", "술", "해"];
  var STEM_HANJA   = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
  var BRANCH_HANJA = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];

  // 五行。既存アプリの子音五行と同じ表記に揃える（木火土金水）。
  var STEM_ELEMENT   = ["목","목","화","화","토","토","금","금","수","수"];
  var BRANCH_ELEMENT = ["수","토","목","목","토","화","화","토","금","금","토","수"];

  var ZODIAC = ["쥐","소","호랑이","토끼","용","뱀","말","양","원숭이","닭","개","돼지"];

  /* ---- 標準時 -----------------------------------------------------
     韓国の標準時は UTC+9 で通してきたわけではない。1954-03-21 から
     1961-08-09 までは UTC+8:30 で、さらに両国とも戦後にサマータイムが
     あった。ここを無視すると、その期間の生まれだけ時柱が 1 時間ずれる。

     表は IANA タイムゾーンデータ（Asia/Seoul, Asia/Tokyo）から起こした。
     Intl を実行時に呼ばず値を焼き込んでいるのは、端末側の tz データが
     削られていても結果が変わらないようにするため。
     tools/verify-saju.mjs が Intl と突き合わせて一致を確かめている。

     [UTC のミリ秒, その時刻以降の UTC からの分] を古い順に並べたもの。   */
  var TZ = {
    seoul: {
      base: 540,
      at: [
        [Date.UTC(1948,4,31,15,0),600], [Date.UTC(1948,8,12,14,0),540],
        [Date.UTC(1949,3, 2,15,0),600], [Date.UTC(1949,8,10,14,0),540],
        [Date.UTC(1950,2,31,15,0),600], [Date.UTC(1950,8, 9,14,0),540],
        [Date.UTC(1951,4, 5,15,0),600], [Date.UTC(1951,8, 8,14,0),540],
        [Date.UTC(1954,2,20,15,0),510],
        [Date.UTC(1955,4, 4,15,30),570],[Date.UTC(1955,8, 8,14,30),510],
        [Date.UTC(1956,4,19,15,30),570],[Date.UTC(1956,8,29,14,30),510],
        [Date.UTC(1957,4, 4,15,30),570],[Date.UTC(1957,8,21,14,30),510],
        [Date.UTC(1958,4, 3,15,30),570],[Date.UTC(1958,8,20,14,30),510],
        [Date.UTC(1959,4, 2,15,30),570],[Date.UTC(1959,8,19,14,30),510],
        [Date.UTC(1960,3,30,15,30),570],[Date.UTC(1960,8,17,14,30),510],
        [Date.UTC(1961,7, 9,15,30),540],
        [Date.UTC(1987,4, 9,17,0),600], [Date.UTC(1987,9,10,17,0),540],
        [Date.UTC(1988,4, 7,17,0),600], [Date.UTC(1988,9, 8,17,0),540]
      ]
    },
    tokyo: {
      base: 540,
      at: [
        [Date.UTC(1948,4, 1,15,0),600], [Date.UTC(1948,8,11,15,0),540],
        [Date.UTC(1949,3, 2,15,0),600], [Date.UTC(1949,8,10,15,0),540],
        [Date.UTC(1950,4, 6,15,0),600], [Date.UTC(1950,8, 9,15,0),540],
        [Date.UTC(1951,4, 5,15,0),600], [Date.UTC(1951,8, 8,15,0),540]
      ]
    }
  };

  /* ---- 出生地 ------------------------------------------------------
     経度を直接入力させず一覧から選ばせる。日本在住の利用者が多いので
     日本の都市を落とさないこと。東京は +19 分で、ソウルの −32 分とは
     符号が逆になる。                                                  */
  var CITIES = [
    { id:"seoul",    ko:"서울",   ja:"ソウル",     lon:126.9780, tz:"seoul" },
    { id:"busan",    ko:"부산",   ja:"釜山",       lon:129.0756, tz:"seoul" },
    { id:"incheon",  ko:"인천",   ja:"仁川",       lon:126.7052, tz:"seoul" },
    { id:"daegu",    ko:"대구",   ja:"大邱",       lon:128.6014, tz:"seoul" },
    { id:"daejeon",  ko:"대전",   ja:"大田",       lon:127.3845, tz:"seoul" },
    { id:"gwangju",  ko:"광주",   ja:"光州",       lon:126.8526, tz:"seoul" },
    { id:"jeju",     ko:"제주",   ja:"済州",       lon:126.5312, tz:"seoul" },
    { id:"tokyo",    ko:"도쿄",   ja:"東京",       lon:139.6917, tz:"tokyo" },
    { id:"yokohama", ko:"요코하마", ja:"横浜",     lon:139.6380, tz:"tokyo" },
    { id:"osaka",    ko:"오사카", ja:"大阪",       lon:135.5023, tz:"tokyo" },
    { id:"kyoto",    ko:"교토",   ja:"京都",       lon:135.7681, tz:"tokyo" },
    { id:"nagoya",   ko:"나고야", ja:"名古屋",     lon:136.9066, tz:"tokyo" },
    { id:"sapporo",  ko:"삿포로", ja:"札幌",       lon:141.3545, tz:"tokyo" },
    { id:"sendai",   ko:"센다이", ja:"仙台",       lon:140.8694, tz:"tokyo" },
    { id:"hiroshima",ko:"히로시마",ja:"広島",      lon:132.4553, tz:"tokyo" },
    { id:"fukuoka",  ko:"후쿠오카",ja:"福岡",      lon:130.4017, tz:"tokyo" },
    { id:"naha",     ko:"나하",   ja:"那覇",       lon:127.6809, tz:"tokyo" }
  ];

  var EPOCH_MS = Date.UTC(1900, 0, 1);   // solar-terms.json の基準
  var table = null;                      // { j0, min:Int32Array }

  /* ---- 節気表 ------------------------------------------------------ */

  function load(json) {
    if (!json || json.v !== 1 || !json.t) throw new Error("solar-terms.json が読めません");
    var t = json.t, n = t.length, min = new Int32Array(n), acc = 0;
    for (var i = 0; i < n; i++) { acc += t[i]; min[i] = acc; }   // 差分を戻す
    table = { j0: json.j0, min: min, range: json.range };
    return table;
  }

  /** その時刻以前で最も近い節気の添字。無ければ -1。 */
  function termIndexAt(minutes) {
    var lo = 0, hi = table.min.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (table.min[mid] <= minutes) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** 黄経 lon 度の節気で、y 年に入るものの時刻（分）。無ければ null。 */
  function termOfYear(y, lon) {
    var j = lon / 15;
    // 添字 i の節気の黄経は ((j0+i)*15)%360。まず候補を年で絞る。
    var lo = 0, hi = table.min.length - 1;
    var target = Math.floor((Date.UTC(y, 0, 1) - EPOCH_MS) / 60000);
    var i = termIndexAt(target);
    if (i < 0) i = 0;
    for (; i < table.min.length; i++) {
      if (((table.j0 + i) % 24) !== j) continue;
      var d = new Date(EPOCH_MS + table.min[i] * 60000);
      if (d.getUTCFullYear() === y) return table.min[i];
      if (d.getUTCFullYear() > y) return null;
    }
    return null;
  }

  /* ---- 時刻の変換 --------------------------------------------------- */

  /** その UTC 時刻に効いている標準時（分）。 */
  function offsetAt(tzId, ms) {
    var z = TZ[tzId], off = z.base;
    for (var i = 0; i < z.at.length; i++) {
      if (ms >= z.at[i][0]) off = z.at[i][1]; else break;
    }
    return off;
  }

  /** 現地の壁時計 → UTC ミリ秒。
      標準時は「その瞬間」で決まるのに、分かっているのは壁時計の方なので
      一度仮の offset で当てて、出てきた瞬間で offset を引き直す。       */
  function localToUtc(tzId, y, mo, d, h, mi) {
    var naive = Date.UTC(y, mo - 1, d, h, mi);
    var off = offsetAt(tzId, naive - TZ[tzId].base * 60000);
    var ms = naive - off * 60000;
    var off2 = offsetAt(tzId, ms);
    return off2 === off ? ms : naive - off2 * 60000;
  }

  /** 均時差（分）。視太陽時 − 平均太陽時。Meeus 第 28 章。
      経度差だけでは真太陽時にならない。均時差は ±16 分あり、
      2 時間刻みの時支は境目でこれに動かされる。                        */
  function equationOfTime(ms) {
    var T = (ms / 86400000 + 2440587.5 - 2451545.0) / 36525;
    var rad = Math.PI / 180;
    var L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) * rad;
    var M  = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * rad;
    var e  = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    var eps = (23.439291111 - 0.0130041667 * T - 1.6389e-7 * T * T
               + 5.036e-7 * T * T * T) * rad;
    var y = Math.tan(eps / 2) * Math.tan(eps / 2);
    var E = y * Math.sin(2 * L0)
          - 2 * e * Math.sin(M)
          + 4 * e * y * Math.sin(M) * Math.cos(2 * L0)
          - 0.5 * y * y * Math.sin(4 * L0)
          - 1.25 * e * e * Math.sin(2 * M);
    return (E / rad) * 4;     // 度 → 分。Meeus の E がそのまま「視 − 平均」
  }

  /* ---- 四柱 --------------------------------------------------------- */

  function mod(a, n) { return ((a % n) + n) % n; }

  function gz(stem, branch) {
    return {
      stem: STEM[stem], branch: BRANCH[branch],
      hanja: STEM_HANJA[stem] + BRANCH_HANJA[branch],
      stemIdx: stem, branchIdx: branch,
      element: STEM_ELEMENT[stem], branchElement: BRANCH_ELEMENT[branch]
    };
  }

  /** グレゴリオ暦の通日（1970-01-01 = 2440588）。 */
  function dayNumber(y, mo, d) {
    return Math.round(Date.UTC(y, mo - 1, d) / 86400000) + 2440588;
  }

  /**
   * @param {object} o
   *   y, m, d       生年月日（現地の暦日）
   *   hour, minute  現地の壁時計。分からなければ hour を null にする
   *   city          CITIES の id。既定 'seoul'
   */
  function pillars(o) {
    if (!table) throw new Error("Saju.load() を先に呼んでください");

    var city = null;
    for (var i = 0; i < CITIES.length; i++)
      if (CITIES[i].id === (o.city || "seoul")) city = CITIES[i];
    if (!city) throw new Error("知らない都市: " + o.city);

    var known = o.hour !== null && o.hour !== undefined;
    // 時刻不明なら正午で置く。年月日柱はこれで動かない（節気の境目に
    // 当たる日だけは動くので、その旨を notes に出す）。
    var h = known ? o.hour : 12, mi = known ? (o.minute || 0) : 0;

    var utcMs = localToUtc(city.tz, o.y, o.m, o.d, h, mi);
    var notes = [];

    // 真太陽時。UTC に「経度 ÷ 15 時間」と均時差を足したもの。
    var eot = equationOfTime(utcMs);
    var lonMin = city.lon * 4;
    var solarMs = utcMs + (lonMin + eot) * 60000;
    var solar = new Date(solarMs);

    // --- 日柱 ---------------------------------------------------------
    // 真太陽時 23:00 以降は翌日に送る（早子時）。
    var sy = solar.getUTCFullYear(), sm = solar.getUTCMonth() + 1,
        sd = solar.getUTCDate(), sh = solar.getUTCHours();
    var dn = dayNumber(sy, sm, sd);
    // notes は画面にそのまま出る。このサイトの表示言語は日本語なので
    // 日本語で返す（干支の読み「경오」などは学習用の中身なので韓国語のまま）。
    if (known && sh >= 23) {
      dn += 1;
      notes.push("真太陽時で 23 時を過ぎているため、日柱は翌日として計算しました");
    }
    var day = gz(mod(dn + 9, 10), mod(dn + 1, 12));

    // --- 年柱 ---------------------------------------------------------
    // 立春（黄経 315°）が境目。元日でも旧正月でもない。
    var minutes = Math.floor((utcMs - EPOCH_MS) / 60000);
    var g = new Date(utcMs).getUTCFullYear();
    var ipchun = termOfYear(g, 315);
    if (ipchun === null) throw new RangeError("節気表の範囲外です: " + o.y + "年");
    var sajuYear = minutes < ipchun ? g - 1 : g;
    var year = gz(mod(sajuYear - 4, 10), mod(sajuYear - 4, 12));

    // --- 月柱 ---------------------------------------------------------
    // 12 の「節」で切る。中気（雨水・春分…）では切らない。
    var ti = termIndexAt(minutes);
    if (ti < 0) throw new RangeError("節気表の範囲外です");
    var k = table.j0 + ti;
    if ((k & 1) === 0) k -= 1;                     // 中気なら 1 つ前の節へ
    var q = Math.floor((k - 21) / 24);             // 21 = 立春
    var monthNo = (k - (21 + 24 * q)) / 2;         // 0 = 寅月
    var month = gz(mod(year.stemIdx % 5 * 2 + 2 + monthNo, 10), mod(2 + monthNo, 12));

    // --- 時柱 ---------------------------------------------------------
    var hour = null;
    if (known) {
      // 子時は 23:00〜01:00。1 時間ずらして 2 で割ると時支になる。
      var bi = mod(Math.floor((sh + 1) / 2), 12);
      hour = gz(mod(day.stemIdx % 5 * 2 + bi, 10), bi);
    } else {
      notes.push("生まれた時刻がわからないため、時柱を除いた 3 柱で計算しました");
    }

    // --- 五行の数 ------------------------------------------------------
    var el = { 목:0, 화:0, 토:0, 금:0, 수:0 };
    [year, month, day, hour].forEach(function (p) {
      if (!p) return;
      el[p.element]++; el[p.branchElement]++;
    });

    return {
      year: year, month: month, day: day, hour: hour,
      sajuYear: sajuYear,
      zodiac: ZODIAC[year.branchIdx],
      elements: el,
      solar: {
        utc: new Date(utcMs).toISOString().slice(0, 16) + "Z",
        trueSolar: solar.toISOString().slice(0, 16),
        offsetMin: offsetAt(city.tz, utcMs),
        lonMin: Math.round(lonMin - offsetAt(city.tz, utcMs)),  // 標準子午線との差
        eotMin: Math.round(eot * 10) / 10
      },
      city: city,
      notes: notes
    };
  }

  root.Saju = {
    load: load, pillars: pillars,
    CITIES: CITIES, STEM: STEM, BRANCH: BRANCH,
    STEM_HANJA: STEM_HANJA, BRANCH_HANJA: BRANCH_HANJA,
    STEM_ELEMENT: STEM_ELEMENT, BRANCH_ELEMENT: BRANCH_ELEMENT,
    equationOfTime: equationOfTime, offsetAt: offsetAt, dayNumber: dayNumber,
    _table: function () { return table; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
