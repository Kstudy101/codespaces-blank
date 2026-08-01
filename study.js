/* ==================================================================
   study.js — 単語帳・出席・発音（index.html と words.html で共用）

   ブラウザでも Node でも動く。検証は tools/verify-study.mjs が
   このファイルをそのまま読み込んで走らせる。

     <script src="/study.js"></script>
     Study.add(word);  Study.list();  Study.mark('2026-08-01');

   共用ファイルにしてあるのは、同じ処理を 2 ページに書き写すと必ず
   片方だけ直すことになるから。page.css を 3 ページで共有しているのと
   同じ理由（docs/plan-fortune-content.md §6）。

   保存するもの:

     k101.words    利用者が「保存」を押した単語だけ
     k101.attend   運勢を見た日付の一覧

   どちらも学習の記録で、名前や生年月日は入らない。プライバシー
   ポリシーの記載と 1 対 1 で対応させること（§4）。増やすときは
   privacy.html を同じコミットで直す。
   ================================================================== */
(function (root) {
  "use strict";

  /* ---- パッチム（終声）判定 -------------------------------------------
     韓国語の助詞は直前の音節にパッチムがあるかで形が変わる。
     index.html にも同じ判定があるが、あちらはページ内に閉じていて
     words.html からは呼べない。ハングルは規則的に並んでいるので、
     字母に分解しなくても剰余だけで出る。                              */
  var HANGUL_BASE = 0xac00, HANGUL_LAST = 0xd7a3;

  /** 末尾の音節にパッチムがあるか。ハングル以外は false。 */
  function hasJong(word) {
    if (!word) return false;
    var s = String(word).replace(/[^가-힣]/g, "");   // 記号や漢字を落とす
    if (!s) return false;
    var c = s.charCodeAt(s.length - 1);
    if (c < HANGUL_BASE || c > HANGUL_LAST) return false;
    return (c - HANGUL_BASE) % 28 !== 0;
  }

  /** 助詞を選ぶ。josa('책', '을', '를') → '을' */
  function josa(word, withJong, without) {
    return hasJong(word) ? withJong : without;
  }

  /* ---- 単語データ -----------------------------------------------------
     運勢の項目に紐づく。結果を読んだ流れでそのまま覚えられるように、
     占いの文句そのものではなく、日常でも使う言い回しを選んである。
     ローマ字は文化観光部 2000 年式（Revised Romanization）。          */
  var WORDS = {
    total: [
      { k:"운이 좋다", r:"un-i jota", j:"運がいい",
        p:[["운(運)","運"],["좋다","よい"]],
        g:"「운이 좋다」で一語のように使います。会話では「운이 좋네요」（運がいいですね）。" },
      { k:"잘 풀리다", r:"jal pullida", j:"うまくいく",
        p:[["잘","よく・うまく"],["풀리다","解ける・ほどける"]],
        g:"「풀리다」は「解ける」。物事がほどけていく比喩で「うまくいく」を表します。" },
      { k:"조심하다", r:"josimhada", j:"気をつける",
        p:[["조심(操心)","用心"],["-하다","〜する"]],
        g:"漢字語「操心」＋하다。命令形の「조심하세요」（気をつけてください）でよく聞きます。" },
      { k:"오늘 하루", r:"oneul haru", j:"今日一日",
        p:[["오늘","今日"],["하루","一日"]],
        g:"「하루」は日数の一日。日付の「1日」は「일일」で別の語です。" }
    ],
    money: [
      { k:"지갑", r:"jigap", j:"財布",
        p:[["지갑(紙匣)","財布"]],
        g:"漢字語「紙匣」。パッチムがあるので助詞は「지갑을」「지갑이」となります。" },
      { k:"절약하다", r:"jeoryakhada", j:"節約する",
        p:[["절약(節約)","節約"],["-하다","〜する"]],
        g:"発音は［저략하다］。パッチム ㄹ が次の母音につながって読まれます。" },
      { k:"횡재", r:"hoengjae", j:"思わぬ収入・棚ぼた",
        p:[["횡재(橫財)","橫財"]],
        g:"「횡재했다」で「棚ぼたに遭った」。占いの金運でよく出る語です。" },
      { k:"돈을 아끼다", r:"don-eul akkida", j:"お金を節約する",
        p:[["돈","お金"],["-을","〜を"],["아끼다","惜しむ・大事にする"]],
        g:"「돈」にパッチムがあるので助詞は「을」。「아끼다」は物にも人にも使えます。" }
    ],
    love: [
      { k:"마음에 들다", r:"ma-eum-e deulda", j:"気に入る",
        p:[["마음","心"],["-에","〜に"],["들다","入る"]],
        g:"直訳は「心に入る」。「마음에 들어요」（気に入っています）の形で覚えると使えます。" },
      { k:"설레다", r:"seolleda", j:"ときめく",
        p:[["설레다","ときめく・そわそわする"]],
        g:"名詞形は「설렘」。恋愛だけでなく、旅行前のわくわくにも使います。" },
      { k:"인연", r:"inyeon", j:"縁",
        p:[["인연(因緣)","因緣"]],
        g:"漢字語「因緣」。発音は［이년］でパッチム ㄴ が次につながります。" },
      { k:"고백하다", r:"gobaekhada", j:"告白する",
        p:[["고백(告白)","告白"],["-하다","〜する"]],
        g:"日本語と同じ漢字語。名詞のまま「고백」でも通じます。" }
    ],
    work: [
      { k:"기회", r:"gihoe", j:"機会・チャンス",
        p:[["기회(機會)","機會"]],
        g:"「기회를 잡다」（チャンスをつかむ）。パッチムが無いので助詞は「를」。" },
      { k:"맡다", r:"matda", j:"引き受ける・担当する",
        p:[["맡다","引き受ける"]],
        g:"「일을 맡다」（仕事を引き受ける）。同音の「맡다（嗅ぐ）」とは文脈で区別します。" },
      { k:"열심히", r:"yeolsimhi", j:"一生懸命に",
        p:[["열심(熱心)","熱心"],["-히","〜に（副詞をつくる）"]],
        g:"発音は［열씨미］。「-히」は漢字語につく副詞語尾です。" },
      { k:"회의", r:"hoe-ui", j:"会議",
        p:[["회의(會議)","會議"]],
        g:"日本語と同じ漢字語。二重母音が続くので、ゆっくり「フェ・ウィ」と読みます。" }
    ],
    health: [
      { k:"푹 쉬다", r:"puk swida", j:"ぐっすり休む",
        p:[["푹","ぐっすり・じゅうぶんに"],["쉬다","休む"]],
        g:"「푹 쉬세요」（ゆっくり休んでください）は別れぎわの定番です。" },
      { k:"무리하다", r:"murihada", j:"無理する",
        p:[["무리(無理)","無理"],["-하다","〜する"]],
        g:"「무리하지 마세요」（無理しないでください）の形でよく使います。" },
      { k:"건강", r:"geongang", j:"健康",
        p:[["건강(健康)","健康"]],
        g:"「건강하세요」は「お元気で」。別れの挨拶にもなります。" },
      { k:"산책하다", r:"sanchaekhada", j:"散歩する",
        p:[["산책(散策)","散策"],["-하다","〜する"]],
        g:"日本語の「散歩」は韓国語では「산책（散策）」。漢字が違う組み合わせです。" }
    ],
    study: [
      { k:"한 단어만", r:"han daneo-man", j:"一語だけ",
        p:[["한","一つの"],["단어(單語)","単語"],["-만","〜だけ"]],
        g:"「-만」は「〜だけ」。今日が振るわない日でも、これだけはという言い方です。" },
      { k:"꾸준히", r:"kkujunhi", j:"こつこつと・着実に",
        p:[["꾸준하다","たゆまない"],["-히","〜に（副詞をつくる）"]],
        g:"学習の話でいちばん出てくる副詞。「꾸준히 하면」（こつこつやれば）。" },
      { k:"외우다", r:"oeuda", j:"覚える・暗記する",
        p:[["외우다","暗記する"]],
        g:"「기억하다（記憶する）」が自然に覚えている状態、「외우다」は意識して覚える動作です。" },
      { k:"복습하다", r:"bokseuphada", j:"復習する",
        p:[["복습(復習)","復習"],["-하다","〜する"]],
        g:"予習は「예습(豫習)」。どちらも日本語と同じ漢字語です。" }
    ]
  };

  /** 項目 id と番号から 1 語選ぶ。番号は日辰から作るので、日替わりで
      変わるが同じ日なら何度開いても同じ語になる。 */
  function pick(catId, n) {
    var a = WORDS[catId] || WORDS.total;
    return a[((n % a.length) + a.length) % a.length];
  }

  /* ---- 発音 -----------------------------------------------------------
     ブラウザ内蔵の SpeechSynthesis を使う。外部への音声リクエストは
     発生しない。韓国語の音声を持たない端末があるので、話せるかどうかを
     先に確かめられるようにしておく（ボタンを押して無反応が最悪）。   */
  function voices() {
    try {
      if (!root.speechSynthesis) return [];
      return root.speechSynthesis.getVoices() || [];
    } catch (e) { return []; }
  }

  function koVoice() {
    var v = voices();
    for (var i = 0; i < v.length; i++) if ((v[i].lang || "").indexOf("ko") === 0) return v[i];
    return null;
  }

  /** 韓国語を読み上げられるか。声の一覧は非同期に来るので、
      voiceschanged のあとに呼び直す前提。 */
  function canSpeak() {
    return !!(root.speechSynthesis && root.SpeechSynthesisUtterance);
  }

  function speak(text) {
    if (!canSpeak()) return false;
    try {
      root.speechSynthesis.cancel();       // 連打で溜まらないように
      var u = new root.SpeechSynthesisUtterance(String(text));
      var v = koVoice();
      if (v) u.voice = v;
      u.lang = "ko-KR";
      u.rate = 0.9;                        // 学習用なので少し遅く
      root.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  /* ---- 保存の土台 ------------------------------------------------------ */

  function store() {
    try {
      var s = root.localStorage;
      s.setItem("k101.t", "1"); s.removeItem("k101.t");   // 私用モード対策
      return s;
    } catch (e) { return null; }
  }

  function read(key, fallback) {
    var s = store();
    if (!s) return fallback;
    try {
      var o = JSON.parse(s.getItem(key) || "null");
      if (!o || o.v !== 1) return fallback;
      return o;
    } catch (e) { return fallback; }
  }

  function write(key, obj) {
    var s = store();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(obj)); return true; }
    catch (e) { return false; }            // 容量超過。呼び出し側に返す
  }

  /* ---- 単語帳 ----------------------------------------------------------
     上限を決めてある。localStorage は 5MB 前後で、単語 1 件が 200 バイト
     ほどなので容量で詰まることはまずないが、上限が無いと「保存したのに
     入らない」が黙って起きる。入らなかったことは必ず返す。          */
  var KEY_WORDS = "k101.words";
  var MAX_WORDS = 200;

  function list() {
    var o = read(KEY_WORDS, null);
    return o && Array.isArray(o.list) ? o.list : [];
  }

  function has(korean) {
    var a = list();
    for (var i = 0; i < a.length; i++) if (a[i].k === korean) return true;
    return false;
  }

  /**
   * 単語を 1 つ保存する。
   * @returns {"added"|"duplicate"|"full"|"failed"}
   */
  function add(word, dateStr) {
    if (!word || !word.k) return "failed";
    if (has(word.k)) return "duplicate";           // 同じ語を二重に持たない
    var a = list();
    if (a.length >= MAX_WORDS) return "full";
    a.push({ k: word.k, r: word.r, j: word.j, d: dateStr || "" });
    return write(KEY_WORDS, { v: 1, list: a }) ? "added" : "failed";
  }

  function remove(korean) {
    var a = list(), out = [];
    for (var i = 0; i < a.length; i++) if (a[i].k !== korean) out.push(a[i]);
    if (out.length === a.length) return false;
    return write(KEY_WORDS, { v: 1, list: out });
  }

  /** 全部消す。保存すると書いた以上、消す手段は必ず要る（§4）。 */
  function clearWords() {
    var s = store();
    if (!s) return false;
    try { s.removeItem(KEY_WORDS); return true; } catch (e) { return false; }
  }

  /* ---- 出席 ------------------------------------------------------------
     日付の文字列を並べて持つだけ。時刻は持たない ── 何時に来たかは
     学習の記録として要らないし、少ないほど説明が短くて済む。         */
  var KEY_ATTEND = "k101.attend";
  var MAX_DAYS = 400;          // 1 年強。連続日数を出すのに過去は要らない

  function days() {
    var o = read(KEY_ATTEND, null);
    return o && Array.isArray(o.d) ? o.d : [];
  }

  function prevDay(dateStr) {
    var t = Date.parse(dateStr + "T00:00:00Z");
    if (isNaN(t)) return null;
    return new Date(t - 86400000).toISOString().slice(0, 10);
  }

  /** dateStr で終わる連続日数。並びは昇順である前提。 */
  function streakAt(sorted, dateStr) {
    var set = {}, n = 0, cur = dateStr;
    for (var i = 0; i < sorted.length; i++) set[sorted[i]] = true;
    while (set[cur]) { n++; cur = prevDay(cur); if (!cur) break; }
    return n;
  }

  /**
   * その日を出席にする。同じ日に何度呼んでも 1 日ぶん。
   * @returns {{days:number, streak:number, isNew:boolean, saved:boolean}}
   */
  function mark(dateStr) {
    var a = days(), isNew = a.indexOf(dateStr) < 0, saved = true;
    if (isNew) {
      a.push(dateStr);
      a.sort();
      if (a.length > MAX_DAYS) a = a.slice(a.length - MAX_DAYS);
      saved = write(KEY_ATTEND, { v: 1, d: a });
    }
    return { days: a.length, streak: streakAt(a, dateStr), isNew: isNew, saved: saved };
  }

  /** 書き込まずに今の状態だけ見る。 */
  function attendance(dateStr) {
    var a = days();
    return { days: a.length, streak: a.indexOf(dateStr) < 0 ? 0 : streakAt(a, dateStr) };
  }

  function clearAttend() {
    var s = store();
    if (!s) return false;
    try { s.removeItem(KEY_ATTEND); return true; } catch (e) { return false; }
  }

  root.Study = {
    hasJong: hasJong, josa: josa,
    WORDS: WORDS, pick: pick, MAX_WORDS: MAX_WORDS,
    canSpeak: canSpeak, speak: speak, koVoice: koVoice,
    list: list, has: has, add: add, remove: remove, clearWords: clearWords,
    mark: mark, attendance: attendance, clearAttend: clearAttend, days: days,
    KEY_WORDS: KEY_WORDS, KEY_ATTEND: KEY_ATTEND
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
