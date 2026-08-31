/* 설헌마블 웹앱 — 앱 로직
 * 2026-08-29 / 임새로이
 * 시안 v5(단일 목업)를 실제 동작 웹앱으로 재구성.
 *  - 모바일 전체화면 SPA
 *  - 진행상황 localStorage 저장 (새로고침·재접속해도 이어서)
 *  - 부스 QR(카메라) 진입 → 조각 획득
 */
(function () {
  'use strict';

  var SAVE_KEY = 'seolheon_marble_v1';
  var REDEEM_KEY = 'seolheon_marble_coin_v1';   // 엽전 수령 기록 — 새 놀이로도 지워지지 않음
  var STAMPS = SM.STAMP_ORDER;           // [8,10,7,4,5,9]
  var BOOTHS = STAMPS.filter(function (i) { return i !== 9; });
  var HALL = 9;

  /* 판 위 4x4 배치 (grid-area) — 반시계 방향 링 */
  var GRID = {
    0: '4/1', 1: '4/2', 2: '4/3', 3: '4/4',
    4: '3/4', 5: '2/4', 6: '1/4', 7: '1/3',
    8: '1/2', 9: '1/1', 10: '2/1', 11: '3/1'
  };

  /* ───────── 상태 ───────── */
  var S = null;
  var pendingBooth = null;   // 설정 전에 QR로 들어온 경우 보관
  var rolling = false;
  var quizPick = [];
  var camStream = null, camTimer = null;

  function blankState() {
    return {
      v: 1, name: '', charId: SM.CHARACTERS[0].id,
      pos: 0, dest: null, visited: {}, hallTries: 0,
      startedAt: null, finishedAt: null
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || o.v !== 1 || !o.name) return null;
      return o;
    } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {}
  }
  function wipe() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

  /* ── 엽전 수령 기록 (이 기기 1회 제한) ──
   * localStorage + 쿠키에 이중으로 남긴다. 둘 중 하나만 남아 있어도 차단.
   * 쿠키는 만료 2027-01-01 (행사 후로 넉넉히).
   */
  function readCoinCookie() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)sm_coin=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }
  function coinRedeemed() {
    var a = null;
    try { a = localStorage.getItem(REDEEM_KEY); } catch (e) {}
    return a || readCoinCookie();
  }
  function markCoinRedeemed(code) {
    var v = code || 'OK';
    try { localStorage.setItem(REDEEM_KEY, v); } catch (e) {}
    try {
      document.cookie = 'sm_coin=' + encodeURIComponent(v) +
        '; expires=Fri, 01 Jan 2027 00:00:00 GMT; path=/; SameSite=Lax';
    } catch (e) {}
  }
  function showDone() {
    var c = coinRedeemed();
    $('doneCode').textContent = (c && c !== 'OK') ? '완주번호 ' + c : '기록 완료';
    show('v-done');
  }

  /* ───────── 헬퍼 ───────── */
  function $(id) { return document.getElementById(id); }
  function cell(i) { return SM.CELLS[i]; }
  function chr() {
    for (var k = 0; k < SM.CHARACTERS.length; k++) {
      if (SM.CHARACTERS[k].id === S.charId) return SM.CHARACTERS[k];
    }
    return SM.CHARACTERS[0];
  }
  function got(i) { return !!(S && S.visited[i]); }
  function boothsDone() {
    var n = 0;
    for (var k = 0; k < BOOTHS.length; k++) if (got(BOOTHS[k])) n++;
    return n;
  }
  function totalDone() {
    var n = 0;
    for (var k = 0; k < STAMPS.length; k++) if (got(STAMPS[k])) n++;
    return n;
  }
  function allDone() { return totalDone() === STAMPS.length; }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.innerHTML = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  var curView = 'v-cover';
  function show(id) {
    if (curView === 'v-qr' && id !== 'v-qr') stopCam();
    var vs = document.querySelectorAll('.view');
    for (var k = 0; k < vs.length; k++) vs[k].classList.remove('on');
    $(id).classList.add('on');
    curView = id;
    var sc = $(id).querySelector('.scroll');
    if (sc) sc.scrollTop = 0;
  }

  /* ───────── 표지 ───────── */
  function initCover() {
    $('coverBadge').textContent = SM.FESTIVAL.badge;
    $('coverProg').textContent = SM.FESTIVAL.program;
    $('coverTitle').textContent = SM.FESTIVAL.title;
    $('coverWhen').textContent = SM.FESTIVAL.when;
    var saved = load();
    if (saved) {
      $('btnResume').style.display = 'block';
      $('btnResume').textContent = '이어서 하기 (' + saved.name + ')';
      $('btnStart').textContent = '새로 시작하기';
    }
  }

  /* ───────── 말 고르기 ───────── */
  function renderPieces() {
    var g = $('pieceGrid');
    g.innerHTML = '';
    SM.CHARACTERS.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'piece' + (c.id === S.charId ? ' sel' : '');
      b.type = 'button';
      b.setAttribute('data-id', c.id);
      b.innerHTML =
        '<div class="piece-av" style="background-image:url(' + c.img + ')"></div>' +
        '<div class="piece-nm">' + c.name + '</div>' +
        '<div class="piece-gd">' + c.gender + '</div>';
      b.addEventListener('click', function () {
        S.charId = c.id;
        renderPieces();
      });
      g.appendChild(b);
    });
    $('charIntro').textContent = chr().intro;
  }

  /* ───────── 게임판 ───────── */
  function renderBoard() {
    var b = $('board');
    b.innerHTML = '';
    SM.CELLS.forEach(function (c) {
      var d = document.createElement('div');
      var cls = 'tile';
      if (c.kind === 'corner') cls += ' corner';
      if (c.i === 0) cls += ' start';
      if (c.kind === 'hall') cls += ' goal';
      if (got(c.i)) cls += ' got';
      if (S.dest === c.i) cls += ' dest';
      d.className = cls;
      d.style.gridArea = GRID[c.i];
      d.setAttribute('data-i', c.i);
      var h = '';
      if (c.color && c.kind !== 'hall') h += '<div class="tile-band" style="background:' + c.color + '"></div>';
      h += '<div class="tile-nm"' + (c.kind === 'hall' ? ' style="color:' + c.color + '"' : '') + '>' + c.name + '</div>';
      if (c.no) h += '<div class="tile-no">' + c.no + '</div>';
      h += '<div class="tile-sub">' + c.sub + '</div>';
      if (c.seal) h += '<div class="tile-seal"><span>' + c.seal + '</span></div>';
      d.innerHTML = h;
      b.appendChild(d);
    });

    // 중앙 주사위
    var ct = document.createElement('div');
    ct.className = 'center';
    ct.innerHTML =
      '<span class="center-lbl">조각 <b id="cCnt">0</b> / 6</span>' +
      '<div class="dice" id="dice"></div>' +
      '<span class="center-cap" id="cCap">눌러서 굴리기</span>';
    b.appendChild(ct);

    // 말
    var tk = document.createElement('div');
    tk.className = 'token';
    tk.id = 'token';
    b.appendChild(tk);

    $('dice').addEventListener('click', rollDice);
    drawPips(1);
    syncBoard();
    setTimeout(placeToken, 60);
  }

  function drawPips(n) {
    // 3x3 그리드 좌표(1-indexed col/row)
    var MAP = {
      1: [[2, 2]],
      2: [[1, 1], [3, 3]],
      3: [[1, 1], [2, 2], [3, 3]],
      4: [[1, 1], [3, 1], [1, 3], [3, 3]],
      5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
      6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]]
    };
    var d = $('dice');
    if (!d) return;
    d.innerHTML = '';
    MAP[n].forEach(function (p) {
      var e = document.createElement('div');
      e.className = 'pip' + (n === 1 ? ' red' : '');
      e.style.gridColumn = p[0];
      e.style.gridRow = p[1];
      d.appendChild(e);
    });
  }

  function syncBoard() {
    var c = chr();
    $('tallyAv').style.backgroundImage = 'url(' + c.img + ')';
    $('tallyNm').textContent = S.name;
    $('tallyCnt').textContent = totalDone();
    if ($('cCnt')) $('cCnt').textContent = totalDone();
    $('token').style.backgroundImage = 'url(' + c.img + ')';

    // 타일 상태
    var tiles = document.querySelectorAll('.tile');
    for (var k = 0; k < tiles.length; k++) {
      var i = +tiles[k].getAttribute('data-i');
      tiles[k].classList.toggle('got', got(i));
      tiles[k].classList.toggle('dest', S.dest === i);
    }

    renderTrack('track');

    // 목적지 카드 / 버튼
    var dc = $('destCard'), dl = $('destL'), dv = $('destV'), bq = $('btnQr');
    if (S.dest === null || S.dest === undefined) {
      dc.classList.remove('go');
      dl.textContent = allDone() ? '모든 조각을 모았어요!' : '가운데 주사위를 굴리세요';
      dv.textContent = allDone() ? '완주증을 받으러 가요' : '';
      bq.disabled = true;
      bq.textContent = allDone() ? '완주증 받기' : '체험 완료 · QR 찍기';
      bq.disabled = !allDone();
    } else {
      var t = cell(S.dest);
      dc.classList.add('go');
      dl.textContent = t.kind === 'hall' ? '이번에 갈 곳 (전시 관람)' : '이번에 갈 곳 (' + t.fee + ')';
      dv.textContent = t.name + (t.no ? ' ' + t.no : '');
      bq.disabled = false;
      bq.textContent = t.kind === 'hall' ? '전시관 도착 · 정답 입력하기' : '체험 완료 · QR 찍기';
    }
  }

  function renderTrack(elId, highlight) {
    var w = $(elId);
    if (!w) return;
    w.innerHTML = '';
    STAMPS.forEach(function (i) {
      var c = cell(i);
      var e = document.createElement('span');
      var on = got(i);
      e.className = 'chip' + (on ? ' on' : '') + (i === HALL && on ? ' last' : '');
      e.textContent = on ? c.gshort : '?';
      if (highlight === i) e.style.transform = 'scale(1.12)';
      w.appendChild(e);
    });
  }

  function placeToken() {
    var tile = document.querySelector('.tile[data-i="' + S.pos + '"]');
    var board = $('board'), tk = $('token');
    if (!tile || !board || !tk) return;
    var br = board.getBoundingClientRect(), tr = tile.getBoundingClientRect();
    if (!tr.width) return;
    tk.style.left = (tr.left - br.left + tr.width / 2 - 16) + 'px';
    tk.style.top = (tr.top - br.top + tr.height / 2 - 16) + 'px';
  }

  /* 목적지 후보: 아직 안 받은 부스. 5개 다 받았으면 전시관만. */
  function targets() {
    return STAMPS.filter(function (i) { return !got(i); });
  }
  function fwd(from, to) { return (to - from + 12) % 12; }

  function rollDice() {
    if (rolling) return;
    var tg = targets();
    if (!tg.length) { toast('모든 조각을 모았어요!'); return; }
    if (S.dest !== null && S.dest !== undefined) {
      toast('먼저 <b>' + cell(S.dest).name + '</b>에 다녀오세요');
      return;
    }
    rolling = true;
    var dice = $('dice');
    dice.classList.add('roll');
    $('cCap').textContent = '구르는 중…';

    // 나올 눈 결정: 미션 칸에 정확히 서는 눈을 우선
    var hit = [], k;
    for (k = 1; k <= 6; k++) {
      if (tg.indexOf((S.pos + k) % 12) !== -1) hit.push(k);
    }
    var face;
    if (hit.length) {
      face = hit[Math.floor(Math.random() * hit.length)];
    } else {
      // 가장 가까운 미션 칸에 최대한 붙는 눈 (다음 굴림에 반드시 도착)
      var best = 1, bestD = 99;
      for (k = 1; k <= 6; k++) {
        var p = (S.pos + k) % 12, d = 99;
        for (var j = 0; j < tg.length; j++) d = Math.min(d, fwd(p, tg[j]));
        if (d < bestD) { bestD = d; best = k; }
      }
      face = best;
    }

    var spin = 0;
    var anim = setInterval(function () {
      drawPips(1 + Math.floor(Math.random() * 6));
      spin++;
    }, 80);

    setTimeout(function () {
      clearInterval(anim);
      dice.classList.remove('roll');
      drawPips(face);
      hop(face, function () {
        rolling = false;
        var landed = S.pos;
        if (tg.indexOf(landed) !== -1) {
          S.dest = landed;
          $('cCap').textContent = face + '칸 이동!';
          save(); syncBoard();
          var c = cell(landed);
          toast('🎲 <b>' + c.name + '</b>(으)로 가세요');
        } else {
          S.dest = null;
          $('cCap').textContent = '한 번 더 굴리기';
          save(); syncBoard();
          toast('여기는 <b>' + cell(landed).name + '</b> — 한 번 더 굴려요');
        }
      });
    }, 700);
  }

  function hop(steps, done) {
    if (steps <= 0) { save(); return done && done(); }
    S.pos = (S.pos + 1) % 12;
    placeToken();
    setTimeout(function () { hop(steps - 1, done); }, 240);
  }

  /* ───────── QR / 부스 처리 ───────── */
  function openQr() {
    if (allDone()) { gotoBook(); return; }
    var t = S.dest !== null && S.dest !== undefined ? cell(S.dest) : null;
    /* 전시관은 QR 없이 바로 정답 입력 화면으로 */
    if (t && t.kind === 'hall') {
      S.pos = HALL; save();
      if (got(HALL)) { S.dest = null; save(); showHallDone(); } else { startQuiz(); }
      return;
    }
    $('qrTitle').textContent = t ? t.name + ' QR 찍기' : '부스 QR을 찍어 주세요';
    $('qrHero').textContent = t ? t.art : '📷';
    $('codeIn').value = '';
    $('codeErr').textContent = '';
    show('v-qr');
  }

  /* 부스 코드/QR 처리의 단일 관문 */
  function claim(boothId, key) {
    var c = cell(boothId);
    if (!c || c.kind !== 'booth') {
      toast('설헌마블 부스 QR이 아니에요');
      return false;
    }
    if (key !== undefined && key !== null && String(key) !== String(SM.BOOTH_KEYS[boothId])) {
      toast('QR 정보가 맞지 않아요. 운영자에게 문의해 주세요');
      return false;
    }
    if (got(boothId)) {
      S.pos = boothId; S.dest = null; save();
      showGain(boothId, true);
      return true;
    }
    var offRoute = (S.dest !== boothId);
    S.visited[boothId] = Date.now();
    S.pos = boothId;
    S.dest = null;
    if (!S.startedAt) S.startedAt = Date.now();
    save();
    showGain(boothId, false);
    if (offRoute) toast('주사위가 정한 곳은 아니지만, 다녀오셨으니 인정!');
    return true;
  }

  /* URL 로 들어온 부스 QR 처리 (?b=8&k=bit) */
  function readQueryBooth() {
    var q = new URLSearchParams(location.search);
    var b = q.get('b') || q.get('booth');
    if (b === null) return null;
    var out = { id: parseInt(b, 10), key: q.get('k') };
    // 주소창 정리 (새로고침 시 중복 처리 방지)
    if (history.replaceState) history.replaceState(null, '', location.pathname);
    return isNaN(out.id) ? null : out;
  }

  /* 스캔한 URL 문자열에서 부스 정보 뽑기 */
  function parseScanned(text) {
    try {
      var u = new URL(text, location.href);
      var b = u.searchParams.get('b') || u.searchParams.get('booth');
      if (b === null) return null;
      var id = parseInt(b, 10);
      if (isNaN(id)) return null;
      return { id: id, key: u.searchParams.get('k') };
    } catch (e) { return null; }
  }

  /* 코드 직접 입력 (카메라 안 될 때 대비) */
  function submitCode() {
    var v = $('codeIn').value.trim().split(' ').join('').toLowerCase();
    if (!v) { $('codeErr').textContent = '확인 글자를 적어 주세요'; return; }
    var found = null;
    for (var id in SM.BOOTH_KEYS) {
      if (String(SM.BOOTH_KEYS[id]).trim().split(' ').join('').toLowerCase() === v) { found = parseInt(id, 10); break; }
    }
    if (found === null) { $('codeErr').textContent = '그런 글자는 없어요. 안내판을 다시 봐 주세요'; return; }
    $('codeErr').textContent = '';
    claim(found, SM.BOOTH_KEYS[found]);
  }

  /* 인앱 카메라 (지원 기기만) */
  function startCam() {
    if (!('BarcodeDetector' in window)) {
      toast('이 휴대폰은 앱 안 촬영이 안 돼요.<br>카메라 앱으로 QR을 찍어 주세요');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('카메라를 열 수 없어요');
      return;
    }
    var det = new window.BarcodeDetector({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (st) {
        camStream = st;
        var v = $('qrVideo');
        v.srcObject = st;
        v.play();
        $('reader').classList.add('on');
        $('btnCam').textContent = '촬영 멈추기';
        camTimer = setInterval(function () {
          det.detect(v).then(function (codes) {
            if (!codes || !codes.length) return;
            var hit = parseScanned(codes[0].rawValue);
            if (!hit) return;
            stopCam();
            claim(hit.id, hit.key);
          }).catch(function () {});
        }, 400);
      })
      .catch(function () { toast('카메라 사용을 허용해 주세요'); });
  }
  function stopCam() {
    if (camTimer) { clearInterval(camTimer); camTimer = null; }
    if (camStream) {
      camStream.getTracks().forEach(function (t) { t.stop(); });
      camStream = null;
    }
    var r = $('reader');
    if (r) r.classList.remove('on');
    var b = $('btnCam');
    if (b) b.textContent = '앱에서 바로 촬영하기';
  }

  /* ───────── 조각 획득 화면 ───────── */
  function showGain(i, again) {
    var c = cell(i);
    $('gainTop').style.background = c.tint;
    $('gainTtl').innerHTML = again
      ? '<b>' + c.gain + '</b><br>이미 받은 조각이에요'
      : '<b>' + c.gain + '</b>을(를)<br>획득하셨습니다';
    $('gainSub').textContent = (c.no ? c.no + ' ' : '') + c.name + ' · ' + c.story;
    $('gainArt').textContent = c.art;
    $('gainArt').style.background = c.tint;
    $('gainVerse').innerHTML = c.verse || '';
    $('gainBy').textContent = c.by || '';
    $('gainPoem').style.display = c.verse ? 'block' : 'none';
    $('gainWhy').innerHTML = c.why || '';
    var n = $('gainNote');
    if (c.note) { n.style.display = 'block'; n.innerHTML = '※ ' + c.note; }
    else { n.style.display = 'none'; }
    renderTrack('gainTrack', i);
    $('btnGainOk').textContent = allDone() ? '완주증 받으러 가기' : '판으로 돌아가기';
    show('v-gain');
  }

  /* ───────── 전시관 퀴즈 ───────── */
  function startQuiz() {
    quizPick = [];
    $('quizIntro').innerHTML = SM.QUIZ.intro;
    $('quizQ').textContent = SM.QUIZ.question;
    $('quizErr').textContent = '';
    $('quizHint').classList.remove('on');
    renderQuiz();
    show('v-hall');
  }
  function renderQuiz() {
    var s = $('slots');
    s.innerHTML = '';
    for (var k = 0; k < SM.QUIZ.answer.length; k++) {
      var e = document.createElement('div');
      e.className = 'slot' + (quizPick[k] ? '' : ' empty');
      e.textContent = quizPick[k] || '?';
      s.appendChild(e);
    }
    var t = $('qtiles');
    t.innerHTML = '';
    SM.QUIZ.tiles.forEach(function (ch) {
      var b = document.createElement('button');
      var used = quizPick.indexOf(ch) !== -1;
      b.className = 'qtile' + (used ? ' used' : '');
      b.type = 'button';
      b.textContent = ch;
      b.addEventListener('click', function () {
        if (used || quizPick.length >= SM.QUIZ.answer.length) return;
        quizPick.push(ch);
        $('quizErr').textContent = '';
        renderQuiz();
      });
      t.appendChild(b);
    });
    $('btnQuizOk').disabled = quizPick.length !== SM.QUIZ.answer.length;
  }
  function checkQuiz() {
    if (quizPick.join('') === SM.QUIZ.answer.join('')) {
      S.visited[HALL] = Date.now();
      S.dest = null;
      if (!S.startedAt) S.startedAt = Date.now();
      if (allDone()) S.finishedAt = Date.now();
      save();
      showHallDone();
      return;
    }
    S.hallTries = (S.hallTries || 0) + 1;
    save();
    var h = $('quizHint');
    if (S.hallTries === 1) {
      h.innerHTML = '💡 ' + SM.QUIZ.hint1;
    } else {
      h.innerHTML = '💡 ' + SM.QUIZ.hint2;
    }
    h.classList.add('on');
    $('quizErr').textContent = '조금 달라요. 다시 해 볼까요? (몇 번이든 괜찮아요)';
    quizPick = [];
    renderQuiz();
  }

  function showHallDone() {
    var c = cell(HALL);
    $('gainTop').style.background = c.tint;
    $('gainTtl').innerHTML = '<b>' + c.gain + '</b>을<br>찾으셨습니다';
    $('gainSub').textContent = '전시관 · ' + c.story;
    $('gainArt').textContent = c.art;
    $('gainArt').style.background = c.tint;
    $('gainPoem').style.display = 'block';
    $('gainVerse').innerHTML = '<span class="hanja">' + SM.QUIZ.successTitle + '</span>';
    $('gainBy').textContent = '허난설헌의 호(號)';
    $('gainWhy').innerHTML = SM.QUIZ.successBody;
    var n = $('gainNote');
    n.style.display = 'block';
    n.innerHTML = '※ ' + SM.QUIZ.successNote;
    renderTrack('gainTrack', HALL);
    $('btnGainOk').textContent = allDone() ? '완주증 받으러 가기' : '판으로 돌아가기';
    show('v-gain');
  }

  /* ───────── 시집첩 ───────── */
  function gotoBook() {
    $('bookTitle').textContent = S.name + '의 시집첩';
    $('bookCnt').textContent = totalDone() + ' / ' + STAMPS.length;
    var w = $('bookList');
    w.innerHTML = '';
    STAMPS.forEach(function (i) {
      var c = cell(i), on = got(i);
      var d = document.createElement('div');
      d.className = 'book-item' + (on ? '' : ' locked');
      d.innerHTML =
        '<div class="book-ic" style="background:' + (on ? c.tint : '#F2EBD9') + '">' + (on ? c.art : '🔒') + '</div>' +
        '<div class="book-tx">' +
          '<div class="book-nm">' + (on ? c.gain : '아직 못 받은 조각') + '</div>' +
          '<div class="book-ds">' + (on ? (c.by || '전시관 미션') : (c.no ? c.no + ' ' : '') + c.name + '에서 받을 수 있어요') + '</div>' +
        '</div>';
      w.appendChild(d);
    });
    var fin = allDone();
    $('bookFinale').style.display = fin ? 'block' : 'none';
    $('btnCert').style.display = fin ? 'block' : 'none';
    show('v-book');
  }

  /* ───────── 완주증 ───────── */
  function certCode() {
    var base = (S.name || '') + '|' + S.charId + '|' + (S.finishedAt || 0);
    var h = 0;
    for (var k = 0; k < base.length; k++) { h = (h * 31 + base.charCodeAt(k)) >>> 0; }
    var s = h.toString(36).toUpperCase();
    while (s.length < 6) s = '0' + s;
    return 'SM-' + s.slice(-6);
  }
  function gotoCert() {
    if (!S.finishedAt) { S.finishedAt = Date.now(); save(); }
    $('certNm').textContent = S.name;
    $('certChar').textContent = chr().name + ' 말과 함께';
    var d = new Date(S.finishedAt);
    $('certDate').textContent =
      d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 · 광주시문화재단';
    $('certCode').textContent = '완주번호 ' + certCode();
    show('v-cert');
  }

  /* ───────── 시작 ───────── */
  function boot() {
    initCover();
    // 엽전을 이미 받은 기기는 어떤 경로로 들어와도 재참여 불가
    if (coinRedeemed()) { showDone(); return; }
    var q = readQueryBooth();
    var saved = load();

    if (saved) {
      S = saved;
      renderPieces();
      renderBoard();
      if (q) {
        show('v-board');
        setTimeout(function () { claim(q.id, q.key); }, 120);
      } else {
        show('v-cover');
      }
      return;
    }

    S = blankState();
    if (q) pendingBooth = q;
    renderPieces();
    show('v-cover');
    if (q) {
      setTimeout(function () {
        toast('먼저 이름과 말을 정해 주세요');
        goSetup();
      }, 300);
    }
  }

  function goSetup() {
    if (!S) S = blankState();
    $('nameIn').value = S.name || '';
    $('nameErr').textContent = '';
    renderPieces();
    show('v-setup');
  }

  function confirmSetup() {
    var v = $('nameIn').value.trim();
    if (!v) { $('nameErr').textContent = '이름을 적어 주세요'; return; }
    if (v.length > 6) { $('nameErr').textContent = '이름은 6글자까지예요'; return; }
    S.name = v;
    if (!S.startedAt) S.startedAt = Date.now();
    save();
    renderBoard();
    show('v-board');
    if (pendingBooth) {
      var p = pendingBooth; pendingBooth = null;
      setTimeout(function () { claim(p.id, p.key); }, 150);
    }
  }

  /* ───────── 이벤트 연결 ───────── */
  function bind() {
    $('btnStart').addEventListener('click', function () {
      if (load() && !confirm('진행 중인 놀이가 있어요. 새로 시작하면 모은 조각이 지워집니다. 계속할까요?')) return;
      wipe();
      S = blankState();
      pendingBooth = null;
      goSetup();
    });
    $('btnResume').addEventListener('click', function () {
      S = load() || blankState();
      renderBoard();
      show('v-board');
    });
    $('btnToBoard').addEventListener('click', confirmSetup);
    $('nameIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmSetup(); }
    });

    $('btnQr').addEventListener('click', openQr);
    $('btnBook').addEventListener('click', gotoBook);
    $('lnkQrBack').addEventListener('click', function () { show('v-board'); syncBoard(); setTimeout(placeToken, 40); });
    $('btnCam').addEventListener('click', function () { camStream ? stopCam() : startCam(); });
    $('btnCode').addEventListener('click', submitCode);
    $('codeIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitCode(); }
    });

    $('btnGainOk').addEventListener('click', function () {
      if (allDone()) { gotoBook(); return; }
      show('v-board'); syncBoard(); setTimeout(placeToken, 40);
    });

    $('btnQuizOk').addEventListener('click', checkQuiz);
    $('lnkUndo').addEventListener('click', function () { quizPick.pop(); renderQuiz(); });
    $('lnkReset').addEventListener('click', function () { quizPick = []; $('quizErr').textContent = ''; renderQuiz(); });

    $('btnBookBack').addEventListener('click', function () { show('v-board'); syncBoard(); setTimeout(placeToken, 40); });
    $('btnCert').addEventListener('click', gotoCert);
    $('lnkCertBack').addEventListener('click', gotoBook);
    $('btnCoinDone').addEventListener('click', function () {
      if (!confirm(
        '[운영진 확인용]\n\n' +
        '참가자에게 엽전을 드렸습니까?\n' +
        '확인을 누르면 이 휴대폰에서는 설헌마블을 다시 이용할 수 없습니다.\n' +
        '(참가자가 실수로 누른 경우 취소를 눌러 주세요)'
      )) return;
      markCoinRedeemed(certCode());
      wipe();
      S = blankState();
      showDone();
    });

    window.addEventListener('resize', placeToken);
    window.addEventListener('orientationchange', function () { setTimeout(placeToken, 250); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stopCam(); });
  }

  document.addEventListener('DOMContentLoaded', function () { bind(); boot(); });
})();
