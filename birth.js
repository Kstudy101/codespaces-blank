/* ==================================================================
   birth.js — 生年月日を、同じタブの中だけで持ち回る

   ブラウザでも Node でも動く。検証は tools/verify-birth.mjs が
   このファイルをそのまま読み込んで走らせる。

     <script src="/birth.js"></script>
     Birth.save({ y:1995, m:4, d:12, hour:9, city:'tokyo' });
     Birth.load();     // → 同じ値、無ければ null
     Birth.clear();

   なぜ要るか。/gilbang と /amulet は「足りない五行」を出すのに四柱が
   要るので、以前はそれぞれのページに生年月日の欄を持っていた。トップで
   一度入れた人にもう一度入れさせることになり、同じ人の同じ生年月日を
   1 セッションで 3 回訊いていた。

   保存先は sessionStorage で、localStorage ではない。この違いがそのまま
   privacy.html の約束になっている:

     ・タブを閉じると消える（localStorage は残る）
     ・別のタブからは見えない
     ・サーバーへは送られない。送る先が無い

   点数・単語・おみくじは localStorage に残す。あちらは「続けている」を
   出すために日をまたぐ必要があるもので、生年月日は日をまたぐ必要が無い。
   残す期間は用途で決まるのであって、置き場所の都合ではない。

   受け取る範囲は saju.js に節気表がある 1930〜2030 に合わせる。ここを
   広く取ると、保存はできたのに読み出した先で四柱が立たない、という
   ページごとに違う失敗の仕方をする。
   ================================================================== */
(function (root) {
  "use strict";

  var KEY = "k101.birth";

  var MIN_YEAR = 1930, MAX_YEAR = 2030;

  /* 書き込めるか確かめてから返す。プライベートブラウズや容量超過では
     sessionStorage が在るのに setItem だけ投げるので、有無を見るだけでは
     足りない（omikuji.js の store() と同じ理由・同じ形）。 */
  function store() {
    try {
      var s = root.sessionStorage;
      s.setItem(KEY + ".t", "1"); s.removeItem(KEY + ".t");
      return s;
    } catch (e) { return null; }
  }

  /**
   * 受け取れる形か。読み書きの両側で同じものを通す ── 片方だけ緩いと、
   * 保存はできたのに読み出した先で例外になる。
   * @returns {boolean}
   */
  function valid(o) {
    if (!o || typeof o !== "object") return false;
    var y = o.y, m = o.m, d = o.d, h = o.hour;
    if (!isInt(y) || y < MIN_YEAR || y > MAX_YEAR) return false;
    if (!isInt(m) || m < 1 || m > 12) return false;
    if (!isInt(d) || d < 1 || d > 31) return false;
    // 2月30日のような日付をここで弾く。Date は勝手に繰り上げてしまう。
    var chk = new Date(Date.UTC(y, m - 1, d));
    if (chk.getUTCMonth() + 1 !== m || chk.getUTCDate() !== d) return false;
    if (h !== null && h !== undefined && (!isInt(h) || h < 0 || h > 23)) return false;
    if (typeof o.city !== "string" || !o.city) return false;
    return true;
  }

  function isInt(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }

  /**
   * 覚えておく。保存できなくても値は返す ── 保存できないことと
   * 使えないことは別で、呼んだ側はその場の計算を続けられる。
   * @returns {?object} 正規化した値。受け取れない形なら null
   */
  function save(o) {
    if (!valid(o)) return null;
    var out = {
      y: o.y, m: o.m, d: o.d,
      hour: (o.hour === null || o.hour === undefined) ? null : o.hour,
      city: o.city
    };
    var s = store();
    if (s) {
      try { s.setItem(KEY, JSON.stringify({ v: 1, b: out })); }
      catch (e) { /* 容量超過。持ち回れないだけで、この場では使える */ }
    }
    return out;
  }

  /** 覚えているものを返す。無ければ null。 */
  function load() {
    var s = store();
    if (!s) return null;
    var raw;
    try { raw = s.getItem(KEY); } catch (e) { return null; }
    if (!raw) return null;

    var o;
    try { o = JSON.parse(raw); } catch (e) { o = null; }
    // 版が違う・壊れている・範囲外は、無かったことにして捨てる。
    // 中途半端に読めた値で四柱を立てると、どこで狂ったか分からなくなる。
    if (!o || o.v !== 1 || !valid(o.b)) { clear(); return null; }
    return o.b;
  }

  /** 覚えているかどうかだけ見る。 */
  function has() { return !!load(); }

  function clear() {
    var s = store();
    if (s) { try { s.removeItem(KEY); } catch (e) {} }
  }

  root.Birth = {
    save: save, load: load, has: has, clear: clear, valid: valid,
    KEY: KEY, MIN_YEAR: MIN_YEAR, MAX_YEAR: MAX_YEAR
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
