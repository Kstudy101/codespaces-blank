/* ==================================================================
   omikuji.js — おみくじの抽選と、1 日 1 回の制限

   ブラウザでも Node でも動く。検証は tools/verify-omikuji.mjs が
   このファイルをそのまま読み込んで走らせる。

     <script src="/omikuji.js"></script>
     Omikuji.draw('2026-08-01');    // その日ぶんを引く（2 回目は同じ結果）
     Omikuji.drawn('2026-08-01');   // 引いたかどうかだけ見る

   ここは「今日の運勢」とわざと逆にしてある（§5）。

     今日の運勢   四柱から計算する。乱数を使わないので引き直しても同じ
     おみくじ     その場の抽選。引くたびに違う

   だから制限の要り方も逆になる。運勢は決定論なので押し直しても同じ数字が
   出るだけで、制限そのものが不要だった。おみくじは違う結果が出てしまうので、
   1 日 1 回で止めないと「引き直して良いのが出るまで」になり、結果の重さが
   なくなる（§7）。

   日付の区切りは端末の暦日。韓国時間ではない ── 利用者の多くは日本在住で、
   KST と JST はどちらも UTC+9 なので実際には同じ時刻に変わる。

   保存するのは日付と 2 つの番号だけ。privacy.html の記載と対応させること。
   ================================================================== */
(function (root) {
  "use strict";

  /* ---- 等級 ------------------------------------------------------------
     神社によって構成は違うので「正しい配分」というものは無い。ここでは
     大吉が出すぎない・大凶が滅多に出ない、という形に決めて固定する。
     合計 100。tools/verify-omikuji.mjs が実際の出方を見ている。       */
  var GRADES = [
    { ja:"大吉", ko:"대길", w:10, tone:"good" },
    { ja:"吉",   ko:"길",   w:20, tone:"good" },
    { ja:"中吉", ko:"중길", w:15, tone:"good" },
    { ja:"小吉", ko:"소길", w:15, tone:"mid"  },
    { ja:"末吉", ko:"말길", w:20, tone:"mid"  },
    { ja:"凶",   ko:"흉",   w:15, tone:"warn" },
    { ja:"大凶", ko:"대흉", w: 5, tone:"warn" }
  ];

  /* ---- ことわざ --------------------------------------------------------
     おみくじの本文にあたる部分。作り物の占い文句ではなく、実在の
     韓国のことわざ（속담）を置いている。覚えて損がないうえ、日本の
     ことわざと対応するものが多く、この사이트の主旨に合う。

     等級の調子に合わせて 3 組に分けてある。大吉に「後の祭り」が出ると
     おみくじとして成立しない。                                        */
  var SAYINGS = {
    good: [
      { k:"시작이 반이다", r:"sijagi banida", j:"始めれば半分終わったも同じ",
        n:"日本の「思い立ったが吉日」に近い言い方。動き出すこと自体を評価します。" },
      { k:"티끌 모아 태산", r:"tikkeul moa taesan", j:"ちりも積もれば山となる",
        n:"「티끌」はちり、「태산（泰山）」は大きな山。日本語とほぼ同じ発想です。" },
      { k:"고생 끝에 낙이 온다", r:"gosaeng kkeute nagi onda", j:"苦労の末に楽が来る",
        n:"「고생(苦生)」は苦労、「낙(樂)」は楽しみ。どちらも漢字語です。" },
      { k:"웃는 얼굴에 침 못 뱉는다", r:"unneun eolgure chim mot baenneunda",
        j:"笑顔に唾は吐けない",
        n:"笑顔で来られると強く出られない、という意味。「뱉는다」は［밴는다］と読みます。" },
      { k:"하늘이 무너져도 솟아날 구멍이 있다",
        r:"haneuri muneojyeodo sosanal gumeongi itda",
        j:"天が崩れても抜け出る穴はある",
        n:"「捨てる神あれば拾う神あり」にあたる、韓国でとてもよく使われる励ましです。" }
    ],
    mid: [
      { k:"천 리 길도 한 걸음부터", r:"cheolli gildo han georeumbuteo",
        j:"千里の道も一歩から",
        n:"「천 리」は［철리］と読みます。ㄴ と ㄹ が続くと ㄹㄹ になる規則です。" },
      { k:"급할수록 돌아가라", r:"geuphalsurok doragara", j:"急がば回れ",
        n:"「-을수록」は「〜すればするほど」。使い回しの利く文法です。" },
      { k:"아는 길도 물어 가라", r:"aneun gildo mureo gara", j:"知っている道も聞いて行け",
        n:"慣れたことほど確認を、という戒め。「아는」は「알다」の連体形です。" },
      { k:"백문이 불여일견", r:"baengmuni buryeoilgyeon", j:"百聞は一見に如かず",
        n:"漢字語そのまま「百聞不如一見」。四字熟語は日韓で共通のものが多くあります。" },
      { k:"말 한마디에 천 냥 빚도 갚는다", r:"mal hanmadie cheon nyang bitdo gamneunda",
        j:"一言で千両の借金も返せる",
        n:"言葉づかい次第で物事が動く、という意味。「냥(兩)」は昔のお金の単位です。" }
    ],
    warn: [
      { k:"돌다리도 두들겨 보고 건너라", r:"doldarido dudeulgyeo bogo geonneora",
        j:"石橋も叩いて渡れ",
        n:"日本語と同じ言い回し。「-아/어 보다」は「〜してみる」です。" },
      { k:"낮말은 새가 듣고 밤말은 쥐가 듣는다",
        r:"nanmareun saega deutgo bammareun jwiga deunneunda",
        j:"昼の話は鳥が聞き、夜の話はネズミが聞く",
        n:"「壁に耳あり障子に目あり」にあたります。「낮말」は［난말］と読みます。" },
      { k:"소 잃고 외양간 고친다", r:"so ilko oeyanggan gochinda",
        j:"牛を失ってから牛小屋を直す",
        n:"「後の祭り」にあたる言い方。「외양간」は家畜小屋のことです。" },
      { k:"원숭이도 나무에서 떨어진다", r:"wonsungido namueseo tteoreojinda",
        j:"猿も木から落ちる",
        n:"これも日本語と同じ。得意なことほど気をつけよ、という意味です。" },
      { k:"서두르면 일을 그르친다", r:"seodureumyeon ireul geureuchinda",
        j:"急ぐと事を仕損じる",
        n:"「그르치다」は「しくじる・だめにする」。「-면」は「〜すれば」です。" }
    ]
  };

  /* ---- 抽選 ------------------------------------------------------------ */

  /** 重みつきで等級を 1 つ。rnd は 0〜1 の値を返すもの（試験で差し替える）。 */
  function pickGrade(rnd) {
    var total = 0, i;
    for (i = 0; i < GRADES.length; i++) total += GRADES[i].w;
    var x = rnd() * total;
    for (i = 0; i < GRADES.length; i++) {
      x -= GRADES[i].w;
      if (x < 0) return i;
    }
    return GRADES.length - 1;      // 丸め誤差で落ちてきたとき
  }

  function result(gi, si) {
    var g = GRADES[gi], list = SAYINGS[g.tone];
    return { grade: g, saying: list[si % list.length], gi: gi, si: si };
  }

  /* ---- 保存 ------------------------------------------------------------ */

  var KEY = "k101.omikuji";

  function store() {
    try {
      var s = root.localStorage;
      s.setItem(KEY + ".t", "1"); s.removeItem(KEY + ".t");
      return s;
    } catch (e) { return null; }
  }

  function saved() {
    var s = store();
    if (!s) return null;
    try {
      var o = JSON.parse(s.getItem(KEY) || "null");
      if (!o || o.v !== 1 || typeof o.d !== "string") return null;
      if (!(o.gi >= 0 && o.gi < GRADES.length)) return null;
      return o;
    } catch (e) { return null; }
  }

  /** その日ぶんを引いたか。 */
  function drawn(dateStr) {
    var o = saved();
    return !!(o && o.d === dateStr);
  }

  /** 引いた結果を見るだけ（引いていなければ null）。 */
  function today(dateStr) {
    var o = saved();
    return o && o.d === dateStr ? result(o.gi, o.si) : null;
  }

  /**
   * その日ぶんを引く。すでに引いていれば同じ結果をそのまま返す。
   * @param {string} dateStr  YYYY-MM-DD（端末の暦日）
   * @param {function} [rnd]  試験用。既定は Math.random
   * @returns {{grade,saying,gi,si,fresh:boolean,saved:boolean}}
   */
  function draw(dateStr, rnd) {
    var old = today(dateStr);
    if (old) { old.fresh = false; old.saved = true; return old; }

    var r = rnd || Math.random;
    var gi = pickGrade(r);
    var si = Math.floor(r() * SAYINGS[GRADES[gi].tone].length);
    var out = result(gi, si);
    out.fresh = true;

    var s = store();
    out.saved = false;
    if (s) {
      try { s.setItem(KEY, JSON.stringify({ v:1, d:dateStr, gi:gi, si:si })); out.saved = true; }
      catch (e) { /* 容量超過。引いた結果は見せる ── 保存できないことと
                     引けないことは別なので、ここで止めない */ }
    }
    return out;
  }

  function clear() {
    var s = store();
    if (s) { try { s.removeItem(KEY); } catch (e) {} }
  }

  root.Omikuji = {
    GRADES: GRADES, SAYINGS: SAYINGS,
    draw: draw, drawn: drawn, today: today, clear: clear,
    KEY: KEY, _pickGrade: pickGrade, _result: result
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
