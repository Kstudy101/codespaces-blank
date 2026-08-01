/* ==================================================================
   amulet.js — 부적（符籍）の中身を決める

   ブラウザでも Node でも動く。検証は tools/verify-amulet.mjs が
   このファイルをそのまま読み込んで走らせる。

     <script src="/saju.js"></script>
     <script src="/gilbang.js"></script>
     <script src="/amulet.js"></script>
     Amulet.of({ cat:"money" });                    // 願いだけで 1 枚
     Amulet.of({ cat:null, saju: Saju.pillars({...}) });  // 命式から選ぶ

   ここは他の 3 つと「変わる周期」が違う（§5）。

     今日の運勢   毎日変わる（四柱 × その日の日辰）
     おみくじ     1 日 1 回、引くたびに変わる
     길방         日ごと・年ごとに変わる
     부적         変わらない。願いと命式が同じなら常に同じ 1 枚

   부적は本来 1 年持つもので、正月に新しくする。だから日付を入れない。
   「今日の부적」にしてしまうと、毎日作り直すものになって性格が変わる。
   tools/verify-amulet.mjs が「日付を変えても同じ 1 枚が出るか」を見ている。

   保存はしない。このページは localStorage に一切触らない ──
   触らないので privacy.html の保存 4 種に足すものが無い。検証が
   「このファイルに localStorage が出てこないこと」を確かめている。

   五行と項目の対応は fortune.js の CATS が決めている。ここで別に
   決めると、金運の부적が水の五行になる、という食い違いが起きる。
   検証が 6 項目とも突き合わせている。
   ================================================================== */
(function (root) {
  "use strict";

  /* ---- 五方色（오방색） ------------------------------------------------
     青＝木、赤＝火、黄＝土、白＝金、黒＝水。方位と同じ並びで、
     韓国の伝統色の骨格になっている考え方そのもの。

     fill は印（도장）の色。ink はその上に置く文字の色で、白だけは
     紙の色に沈むので反転させる。                                     */
  var COLORS = {
    목: { ja:"青", ko:"청", hanja:"青", eum:"청", fill:"#1c6d88", ink:"#ffffff" },
    화: { ja:"赤", ko:"적", hanja:"赤", eum:"적", fill:"#b8352a", ink:"#ffffff" },
    토: { ja:"黄", ko:"황", hanja:"黄", eum:"황", fill:"#c8971d", ink:"#ffffff" },
    금: { ja:"白", ko:"백", hanja:"白", eum:"백", fill:"#f6f1e4", ink:"#4a3520" },
    수: { ja:"黒", ko:"흑", hanja:"黒", eum:"흑", fill:"#2b2124", ink:"#ffffff" }
  };

  /* ---- 五行の漢字 ------------------------------------------------------ */
  var ELEMENT_HANJA = { 목:"木", 화:"火", 토:"土", 금:"金", 수:"水" };

  /* ---- 6 種 ------------------------------------------------------------
     項目の並びと id は fortune.js の CATS に合わせてある。総合運だけ
     五行を持たない（fortune.js で総合運が 5 項目の平均ではないのと同じ
     理由で、特定の五行に紐づかない）ので、色は五方色をすべて並べる。

     中央に置く漢字は「願いを表す 1 字」で選んだ。五行そのものの字
     （木火土金水）ではないのは、부적は願いを書くものだから ──
     五行は印のほうに回してある。

     中央の 1 字は、韓国で使う정자（正字）と日本の新字体で形が割れない
     ものだけを選んだ。韓国の부적は정자で書くので、学（學）や縁（緣）の
     ように形が分かれる字を置くと、画面と実物が別の字になってしまう。
     検証は kanji.json の구자체 표で機械的に確かめている ── 学には
     學（U+5B78）という別の字が立っているが、福・財・愛・業・康・習には
     無い。福だけは互換漢字（U+FA1B）としての異体があるが、これは
     字形が分かれているのではなく符号化の都合で、韓国でも日本でも
     書く形は同じ福（U+798F）。検証もこの 2 つを区別している。

     한국 한자음（eum）と훈음（hun）は kanji.json の値と一致していなければ
     ならない。検証がこの 2 つを 1 字ずつ突き合わせている ── ここが
     ずれると「漢字の韓国読みを教えるサイト」が間違いを教えることになる。 */
  var KINDS = [
    {
      cat:"total", el:null,
      ja:"厄除け", ko:"액막이",
      hanja:"福", eum:"복", hun:"복 복",
      lead:"どの願いにも当てはまる、いちばん基本の 1 枚です。",
      wish:{
        k:"액운을 물리치소서", r:"aegun-eul mullichisoseo", j:"厄を追い払ってください",
        p:[["액운(厄運)","厄運・悪い運"],["-을","〜を"],["물리치다","追い払う"],
           ["-소서","祈願を表す古語の語尾"]],
        g:"「-소서」は古い祈願文の終結語尾。現代の「〜してください」の格式体にあたり、" +
          "今は祈りの文句や祝詞にだけ残っています。"
      }
    },
    {
      cat:"money", el:"금",
      ja:"金運", ko:"재물운",
      hanja:"財", eum:"재", hun:"재물 재",
      lead:"貯まらない・出ていく、が続くときに。",
      wish:{
        k:"재물이 모이소서", r:"jaemul-i moisoseo", j:"財が集まりますように",
        p:[["재물(財物)","財産・お金"],["-이","〜が"],["모이다","集まる"],
           ["-소서","祈願を表す古語の語尾"]],
        g:"「모이다」は「모으다（集める）」の自動詞。人が集める話ではなく、" +
          "ひとりでに集まる、という言い方です。"
      }
    },
    {
      cat:"love", el:"수",
      ja:"恋愛運", ko:"연애운",
      hanja:"愛", eum:"애", hun:"사랑 애",
      lead:"出会いを待つとき、今の関係を続けたいときに。",
      wish:{
        k:"좋은 인연을 만나소서", r:"joeun inyeon-eul mannasoseo", j:"よい縁に出会えますように",
        p:[["좋은","よい（좋다の連体形）"],["인연(因緣)","縁"],["-을","〜を"],
           ["만나다","会う"],["-소서","祈願を表す古語の語尾"]],
        g:"韓国語では縁に「会う」と言い、助詞は「-을/를」。日本語の「縁に恵まれる」" +
          "とは組み立てが違います。「인연」は［이년］と読みます。"
      }
    },
    {
      cat:"work", el:"목",
      ja:"仕事運", ko:"사업운",
      hanja:"業", eum:"업", hun:"업 업",
      lead:"始めるとき、通したい話があるときに。",
      wish:{
        k:"하는 일이 잘되소서", r:"haneun il-i jaldoesoseo", j:"することがうまくいきますように",
        p:[["하는","する（하다の連体形）"],["일","こと・仕事"],["-이","〜が"],
           ["잘되다","うまくいく"],["-소서","祈願を表す古語の語尾"]],
        g:"「일」は「こと」と「仕事」の両方。「하는 일」で「やっていること」を指し、" +
          "職業に限りません。"
      }
    },
    {
      cat:"health", el:"토",
      ja:"健康運", ko:"건강운",
      hanja:"康", eum:"강", hun:"편안 강",
      lead:"本人にも、渡したい相手にも。",
      wish:{
        k:"몸이 건강하소서", r:"mom-i geonganghasoseo", j:"体が健やかでありますように",
        p:[["몸","体"],["-이","〜が"],["건강(健康)하다","健康だ"],
           ["-소서","祈願を表す古語の語尾"]],
        g:"「건강하세요」は別れぎわの「お元気で」。健康は韓国語では形容詞なので、" +
          "「健康である」の形で使います。"
      }
    },
    {
      cat:"study", el:"화",
      ja:"学習運", ko:"학업운",
      hanja:"習", eum:"습", hun:"익힐 습",
      lead:"試験の前に、続かないときに。",
      wish:{
        k:"배움이 깊어지소서", r:"baeum-i gipeojisoseo", j:"学びが深まりますように",
        p:[["배움","学び（배우다の名詞形）"],["-이","〜が"],["깊어지다","深くなる"],
           ["-소서","祈願を表す古語の語尾"]],
        g:"「-어지다」は「〜くなる」。「깊다（深い）」→「깊어지다（深くなる）」のように、" +
          "形容詞を変化の意味に変えます。"
      }
    }
  ];

  /* ---- 上部の勅令 ------------------------------------------------------
     부적の多くは「勅令（칙령）」で始まる。天の命令としてこの符を発する、
     という体裁で、韓国でも中国でも見られる書き出し。ここで考えた文句
     ではないので、そのまま置いて意味だけ説明する。

     こちらは中央の 1 字と違い、古い形の敕（U+6555）で書かれた부적もある。
     同じ字の新旧なので読みはどちらも칙で、kanji.json の구자체 표が
     敕 → 勅 の対応を持っている。検証がその 1 行を確かめている。      */
  var HEADER = { hanja:"勅令", eum:"칙령", ja:"勅命として（符の書き出し）",
                 old:"敕令" };

  function byCat(cat) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].cat === cat) return KINDS[i];
    return null;
  }

  function byElement(el) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].el === el) return KINDS[i];
    return null;
  }

  /* ---- 命式から 1 種を選ぶ ---------------------------------------------
     足りない五行の判定は gilbang.js の mine() をそのまま呼ぶ。同じ判定を
     ここにもう一度書くと、比率（土は 12 支のうち 4 つ）を直すときに
     片方だけ直すことになる。fortune.js と gilbang.js で既に 2 か所ある
     ので、3 か所目は作らない。                                        */
  function lacking(saju) {
    var G = root.Gilbang;
    if (!G) throw new Error("gilbang.js を先に読み込んでください");
    return G.mine(saju);
  }

  /**
   * 부적 1 枚ぶんの中身。
   *
   * @param {object} o
   *   cat  願いの id（KINDS の cat）。null なら命式から選ぶ
   *   saju Saju.pillars() の結果。無くてもよい
   * @returns {{kind, header, color, element, dir, lack, recommended, chosen}}
   */
  function of(o) {
    o = o || {};
    var lack = null, suggested = null;

    if (o.saju) {
      lack = lacking(o.saju);
      suggested = byElement(lack.element);
    }

    // 願いが指定されていればそちらを優先する。命式が勧めるものと違っても
    // 上書きしない ── 願いは本人が決めることで、計算が決めることではない。
    var kind = o.cat ? byCat(o.cat) : (suggested || byCat("total"));
    if (!kind) throw new Error("知らない願いです: " + o.cat);

    // 方位は gilbang.js の対応表から取る。無い状態で進むと、色は付いて
    // いるのに方位だけ欠けた札ができてしまうので、ここで止める。
    var G = root.Gilbang;
    if (!G) throw new Error("gilbang.js を先に読み込んでください");

    return {
      kind: kind,
      header: HEADER,
      element: kind.el,
      hanja: ELEMENT_HANJA[kind.el] || null,
      color: kind.el ? COLORS[kind.el] : null,
      colors: kind.el ? null : allColors(),          // 総合運は五方色すべて
      dir: kind.el ? G.ofElement(kind.el).dir : null,
      lack: lack,
      suggested: suggested,
      recommended: !!(suggested && suggested.cat === kind.cat),
      chosen: o.cat ? "wish" : (suggested ? "saju" : "default")
    };
  }

  function allColors() {
    var a = [], e;
    for (e in ELEMENT_HANJA) a.push(COLORS[e]);
    return a;
  }

  root.Amulet = {
    KINDS: KINDS, COLORS: COLORS, HEADER: HEADER, ELEMENT_HANJA: ELEMENT_HANJA,
    of: of, byCat: byCat, byElement: byElement, lacking: lacking
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
