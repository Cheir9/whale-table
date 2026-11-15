'use strict';

/* =========================================================================
 * 鲸鱼牌桌 — 客户端
 *
 * 只做三件事：
 *   1. 和服务器保持一条 WebSocket，发指令、收全量状态快照；
 *   2. 把状态渲染成界面（自己永远在正下方，其他人顺时针围绕公共池）；
 *   3. 按规则校验下注输入，把非法操作挡在本地。
 *
 * 真正的规则判定在 server.js，这里只是「提前提示」和「不让按钮乱点」。
 * ========================================================================= */

(function () {
  /* ---------------------------- 工具 ---------------------------- */
  const $ = (sel) => document.querySelector(sel);

  const EMOJIS = ['🐳', '🐋', '🦈', '🐬', '🐙', '🦑', '🦀', '🐢', '🐠', '🦭', '🐧', '🐨'];
  const COLORS = ['#3b6ea5', '#8a5cd1', '#c25b6a', '#c98a3c', '#3f9e6b', '#4a8fb8', '#a05ca0', '#5b6b7f'];

  /** 全局界面状态 */
  const ui = {
    ws: null,
    state: null,          // 服务器最近一次推送的完整快照
    screen: 'home',
    avatar: { emoji: EMOJIS[0], color: COLORS[0] },
    raiseDraft: '',       // 加注输入框里正在输入的内容
    seatNodes: new Map(), // id -> DOM 节点，复用节点让位置变化有过渡效果
    toastTimer: 0,
  };

  /* ---------------------------- 提示条 ---------------------------- */
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => el.classList.remove('is-on'), 2400);
  }

  /* ---------------------------- 屏幕切换 ---------------------------- */
  function setScreen(name) {
    if (ui.screen === name) return;
    ui.screen = name;
    ['home', 'lobby', 'table'].forEach((key) => {
      const el = $('#screen-' + key);
      if (el) el.classList.toggle('is-active', key === name);
    });
  }

  /* ---------------------------- 网络连接 ---------------------------- */
  function connect() {
    return new Promise((resolve, reject) => {
      if (ui.ws && ui.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      // 用文件方式直接打开时没有 ws 服务，给出明确指引
      if (location.protocol === 'file:') {
        reject(new Error('请先在项目目录运行 node server.js，再用 http://localhost:8080 打开'));
        return;
      }
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let socket;
      try {
        socket = new WebSocket(proto + '//' + location.host);
      } catch (err) {
        reject(new Error('浏览器无法建立 WebSocket 连接'));
        return;
      }
      let settled = false;
      socket.onopen = () => {
        settled = true;
        ui.ws = socket;
        resolve();
      };
      socket.onmessage = (ev) => onServerMessage(ev.data);
      socket.onclose = () => {
        ui.ws = null;
        if (ui.state) toast('与服务器的连接已断开，请刷新页面重连');
      };
      socket.onerror = () => {
        if (!settled) reject(new Error('连接服务器失败，请确认 server.js 正在运行'));
      };
    });
  }

  function send(msg) {
    if (!ui.ws || ui.ws.readyState !== WebSocket.OPEN) {
      toast('还没连上服务器');
      return;
    }
    ui.ws.send(JSON.stringify(msg));
  }

  function onServerMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!data || typeof data.t !== 'string') return;
    if (data.t === 'error') {
      toast(data.message || '操作失败');
      return;
    }
    if (data.t === 'state') {
      ui.state = data;
      render();
    }
  }

  /* ---------------------------- 首页：头像选择 ---------------------------- */
  function buildPickers() {
    const emojiBox = $('#emoji-picker');
    EMOJIS.forEach((emoji, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-btn' + (i === 0 ? ' is-on' : '');
      btn.textContent = emoji;
      btn.dataset.emoji = emoji;
      btn.addEventListener('click', () => {
        ui.avatar.emoji = emoji;
        emojiBox.querySelectorAll('.emoji-btn').forEach((b) => b.classList.remove('is-on'));
        btn.classList.add('is-on');
        syncPreview();
      });
      emojiBox.appendChild(btn);
    });

    const colorBox = $('#color-picker');
    COLORS.forEach((color, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-btn' + (i === 0 ? ' is-on' : '');
      btn.style.background = color;
      btn.dataset.color = color;
      btn.addEventListener('click', () => {
        ui.avatar.color = color;
        colorBox.querySelectorAll('.color-btn').forEach((b) => b.classList.remove('is-on'));
        btn.classList.add('is-on');
        syncPreview();
      });
      colorBox.appendChild(btn);
    });

    $('#input-name').addEventListener('input', syncPreview);
  }

  function syncPreview() {
    const preview = $('#avatar-preview');
    preview.textContent = ui.avatar.emoji;
    preview.style.background = ui.avatar.color;
    const name = $('#input-name').value.trim();
    $('#name-preview').textContent = name || '未命名';
  }

  /* ---------------------------- 渲染入口 ---------------------------- */
  function render() {
    const state = ui.state;
    if (!state || !state.room) return;
    const room = state.room;
    if (room.phase === 'lobby') {
      setScreen('lobby');
      renderLobby(state);
    } else {
      setScreen('table');
      renderTable(state);
    }
  }

  /* ---------------------------- 大厅 ---------------------------- */
  function renderLobby(state) {
    const room = state.room;
    $('#lobby-code').textContent = '房间 ' + room.code;
    $('#lobby-count').textContent = room.seats.length + ' / ' + room.maxPlayers + ' 人';

    const list = $('#lobby-list');
    list.innerHTML = '';
    room.seats.forEach((seat) => {
      const li = document.createElement('li');
      li.className = 'lobby-item';

      const avatar = document.createElement('span');
      avatar.className = 'seat-avatar';
      avatar.style.background = seat.avatar.color;
      avatar.textContent = seat.avatar.emoji;

      const name = document.createElement('span');
      name.className = 'lobby-name';
      name.textContent = seat.name + (seat.id === state.you ? '（你）' : '');

      li.appendChild(avatar);
      li.appendChild(name);
      if (seat.id === room.hostId) {
        const tag = document.createElement('span');
        tag.className = 'tag tag-host';
        tag.textContent = '房主';
        li.appendChild(tag);
      }
      list.appendChild(li);
    });

    const hostPanel = $('#host-panel');
    hostPanel.classList.toggle('hidden', !state.isHost);

    const chipsInput = $('#input-chips');
    // 用户正在输入时不要覆盖他的内容
    if (document.activeElement !== chipsInput) chipsInput.value = String(room.startChips);

    const btnStart = $('#btn-start');
    btnStart.disabled = room.seats.length < room.minPlayers;

    const hint = $('#lobby-hint');
    if (room.seats.length < room.minPlayers) {
      hint.textContent = '至少需要 ' + room.minPlayers + ' 人才能开局，还差 '
        + (room.minPlayers - room.seats.length) + ' 人';
    } else if (state.isHost) {
      hint.textContent = '人齐了，点「开始游戏」。盲注：小盲 1，大盲 2。';
    } else {
      hint.textContent = '等待房主开始游戏…';
    }
  }

  /* ---------------------------- 牌桌：座位定位 ---------------------------- */
  /**
   * 把第 index 个座位换算成屏幕上的百分比坐标。
   * 自己（myIndex）永远在正下方，其余人按顺时针均匀围绕圆心。
   */
  function seatPosition(index, myIndex, total) {
    const relative = ((index - myIndex) % total + total) % total;
    const angle = Math.PI / 2 + (relative * 2 * Math.PI) / total;
    const radius = total <= 4 ? 34 : total <= 6 ? 36 : 37;
    return {
      left: (50 + radius * Math.cos(angle)).toFixed(2) + '%',
      top: (50 + radius * Math.sin(angle)).toFixed(2) + '%',
    };
  }

  /* ---------------------------- 牌桌：主渲染 ---------------------------- */
  function renderTable(state) {
    const room = state.room;
    const seats = room.seats;

    $('#table-code').textContent = '房间 ' + room.code;
    $('#table-round').textContent = '第 ' + room.round + ' 手 · 第 ' + (room.street || 0) + ' 街';
    $('#pot-value').textContent = String(room.pot);
    $('#pot-sub').textContent = '最低下注 ' + room.highestBet;

    const statusMap = {
      betting: '下注中',
      showdown: '等待判定',
      result: '本轮已结算',
      over: '游戏已结束',
      lobby: '等待开局',
    };
    $('#table-status').textContent = statusMap[room.phase] || '';

    // 以自己为基准旋转视角
    const myIndex = seats.findIndex((s) => s.id === state.you);
    const base = myIndex >= 0 ? myIndex : 0;
    const host = $('#seats');
    const seen = new Set();

    seats.forEach((seat, index) => {
      seen.add(seat.id);
      let node = ui.seatNodes.get(seat.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'seat';
        node.innerHTML =
          '<div class="seat-marks"></div>' +
          '<span class="seat-avatar"></span>' +
          '<div class="seat-name"></div>' +
          '<div class="seat-chips"></div>' +
          '<div class="seat-bet"></div>' +
          '<div class="seat-delta"></div>';
        host.appendChild(node);
        ui.seatNodes.set(seat.id, node);
      }

      const pos = seatPosition(index, base, seats.length);
      node.style.left = pos.left;
      node.style.top = pos.top;

      node.classList.toggle('is-me', seat.id === state.you);
      node.classList.toggle('is-acting', seat.id === room.actorId);
      node.classList.toggle('is-folded', seat.folded);
      node.classList.toggle('is-offline', !seat.connected);

      const avatar = node.querySelector('.seat-avatar');
      avatar.style.background = seat.avatar.color;
      avatar.textContent = seat.avatar.emoji;

      node.querySelector('.seat-name').textContent =
        seat.name + (seat.id === state.you ? '（你）' : '');
      node.querySelector('.seat-chips').textContent = '积分 ' + seat.chips;

      // 本街已经押了多少（新街开始会归零）
      const betLine = node.querySelector('.seat-bet');
      if (seat.streetContrib > 0) {
        betLine.textContent = '本街 ' + seat.streetContrib;
      } else {
        betLine.textContent = '';
      }

      const delta = node.querySelector('.seat-delta');
      if (seat.lastDelta > 0) {
        delta.textContent = '+' + seat.lastDelta;
        delta.className = 'seat-delta up';
      } else if (seat.lastDelta < 0) {
        delta.textContent = String(seat.lastDelta);
        delta.className = 'seat-delta down';
      } else {
        delta.textContent = '';
        delta.className = 'seat-delta';
      }

      // 庄家 / 盲注 / 弃牌标记
      const marks = [];
      if (seat.id === room.dealerId) marks.push('<span class="mark mark-dealer">庄</span>');
      if (seat.id === room.sbId) marks.push('<span class="mark mark-sb">小盲</span>');
      if (seat.id === room.bbId) marks.push('<span class="mark mark-bb">大盲</span>');
      if (seat.folded) marks.push('<span class="mark mark-fold">弃牌</span>');
      if (seat.allIn && !seat.folded) marks.push('<span class="mark mark-allin">全下</span>');
      node.querySelector('.seat-marks').innerHTML = marks.join('');
    });

    // 移除已经不在牌桌上的座位节点
    for (const [id, node] of ui.seatNodes) {
      if (!seen.has(id)) {
        node.remove();
        ui.seatNodes.delete(id);
      }
    }

    renderResultLayer(state);
    renderActionBar(state);
  }

  /* ---------------------------- 牌桌：结算浮层 ---------------------------- */
  function renderResultLayer(state) {
    const room = state.room;
    const layer = $('#result-layer');

    // 房主结束整局：浮层变成最终名次表
    if (room.phase === 'over') {
      const sorted = room.seats.slice().sort((a, b) => b.chips - a.chips);
      layer.classList.remove('hidden');
      layer.innerHTML =
        '<div class="result-title">游戏结束 · 最终积分</div>' +
        sorted.map((seat, i) =>
          '<div class="result-row"><span>' + (i + 1) + '. ' + escapeHtml(seat.name) + '</span>'
          + '<b>' + seat.chips + '</b></div>').join('');
      return;
    }

    if (room.phase !== 'result' || !room.result) {
      layer.classList.add('hidden');
      layer.innerHTML = '';
      return;
    }
    layer.classList.remove('hidden');
    layer.innerHTML =
      '<div class="result-title">本轮赢家</div>' +
      '<div class="result-name">' + escapeHtml(room.result.winnerName) + '</div>' +
      '<div class="result-amount">赢得公共池 ' + room.result.amount + ' 积分</div>';
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* ---------------------------- 牌桌：底部操作区 ---------------------------- */
  function renderActionBar(state) {
    const room = state.room;
    const bar = $('#action-bar');
    const legal = room.legal;
    bar.innerHTML = '';

    if (room.phase === 'betting') {
      if (legal.canAct) {
        let tip;
        if (legal.mustBet) {
          tip = '第 ' + room.street + ' 街 · 你必须先下注，至少 ' + legal.minTarget + ' 积分';
        } else if (legal.need > 0) {
          tip = '第 ' + room.street + ' 街 · 跟注需要 ' + legal.need
            + ' 积分，加注至少 ' + legal.minTarget;
        } else {
          tip = '第 ' + room.street + ' 街 · 可以过牌，或下注至少 ' + legal.minTarget + ' 积分';
        }
        bar.appendChild(makeTip(tip));
        bar.appendChild(makeBetRow(state));
      } else {
        const actor = room.seats.find((s) => s.id === room.actorId);
        bar.appendChild(makeTip(actor ? '等待 ' + actor.name + ' 行动…' : '等待行动…'));
      }
    } else if (room.phase === 'showdown') {
      if (state.isHost) {
        bar.appendChild(makeTip('下注已结束，选择一名玩家获胜：公共池 ' + room.pot + ' 积分全部归他'));
        const grid = document.createElement('div');
        grid.className = 'pick-grid';
        room.seats.forEach((seat) => {
          grid.appendChild(makeButton('🏆 ' + seat.name, 'btn btn-gold',
            () => send({ t: 'pick', id: seat.id })));
        });
        bar.appendChild(grid);
      } else {
        bar.appendChild(makeTip('下注结束，等待房主选择本轮赢家…'));
      }
    } else if (room.phase === 'result') {
      bar.appendChild(makeTip('本轮赢家：' + (room.result ? room.result.winnerName : '—')
        + '，赢得 ' + (room.result ? room.result.amount : 0) + ' 积分'));
      if (state.isHost) {
        const row = document.createElement('div');
        row.className = 'action-row';
        row.appendChild(makeButton('开始下一轮', 'btn btn-primary', () => send({ t: 'next' })));
        bar.appendChild(row);
      } else {
        bar.appendChild(makeTip('等待房主开始下一轮…'));
      }
    } else if (room.phase === 'over') {
      // 房主已经结束整局，只保留「重新开局」
      bar.appendChild(makeTip('房主已结束游戏，最终积分见牌桌中央'));
      if (room.canRestart) {
        const row = document.createElement('div');
        row.className = 'action-row';
        row.appendChild(makeButton('重新开局', 'btn btn-primary', () => send({ t: 'restart' })));
        bar.appendChild(row);
      } else {
        bar.appendChild(makeTip('等待房主重新开局…'));
      }
      return;
    } else {
      bar.appendChild(makeTip('大厅中，等待开局…'));
      return;
    }

    // 房主控制条：结束下注（仅下注中）+ 随时结束游戏
    if (room.canEndGame) {
      const row = document.createElement('div');
      row.className = 'action-row';
      if (room.phase === 'betting') {
        row.appendChild(makeButton('结束下注', 'btn btn-ghost', () => send({ t: 'endbet' })));
      }
      row.appendChild(makeButton('结束游戏', 'btn btn-danger', () => send({ t: 'endgame' })));
      bar.appendChild(row);
    }
  }

  /** 造一个带点击事件的按钮 */
  function makeButton(text, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function makeTip(text) {
    const div = document.createElement('div');
    div.className = 'action-tip';
    div.textContent = text;
    return div;
  }

  /**
   * 弃牌 / 过牌或跟注 / 下注或加注。
   * 「过牌」只在无需补钱时出现；「加注」必须按规则输入准确的数字。
   */
  function makeBetRow(state) {
    const room = state.room;
    const legal = room.legal;
    const wrap = document.createElement('div');
    const minT = legal.minTarget;
    const verb = room.highestBet === 0 ? '下注' : '加注';
    const forced = Boolean(legal.mustBet);

    // 第 1 街的小盲/大盲必须下注，系统不再替他们扣
    if (forced) {
      wrap.appendChild(makeTip('第 1 街 ' + (state.room.sbId === state.you ? '小盲' : '大盲')
        + ' 必须下注，至少 ' + minT + ' 积分（不能弃牌）'));
    }

    // 金额自选：只要 ≥ 下限就能提交，3 倍、4 倍、任意更高都行
    if (legal.canRaise) {
      const box = document.createElement('div');
      box.className = 'raise-box';

      const input = document.createElement('input');
      input.className = 'text-input';
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = String(minT);
      input.placeholder = verb + '至少 ' + minT;
      input.value = ui.raiseDraft;

      const raiseBtn = document.createElement('button');
      raiseBtn.type = 'button';
      raiseBtn.className = 'btn btn-gold';
      raiseBtn.textContent = verb;

      const parsed = () => {
        const n = Math.floor(Number(input.value));
        return Number.isFinite(n) ? n : 0;
      };
      raiseBtn.disabled = parsed() < minT;

      input.addEventListener('input', () => {
        ui.raiseDraft = input.value;
        raiseBtn.disabled = parsed() < minT;
      });
      raiseBtn.addEventListener('click', () => {
        const n = parsed();
        if (n < minT) {
          toast(verb + '不能低于 ' + minT);
          return;
        }
        ui.raiseDraft = '';
        send({ t: 'act', kind: 'raise', amount: n });
      });

      box.appendChild(input);
      box.appendChild(raiseBtn);
      wrap.appendChild(box);
    } else {
      wrap.appendChild(makeTip('积分不足以' + verb + '到 ' + minT + '，可以跟注或全下'));
    }

    const row = document.createElement('div');
    row.className = 'action-row';

    // 被逼下注时不允许弃牌/过牌/跟注，只有下注或全下
    if (legal.canFold) {
      row.appendChild(makeButton('弃牌', 'btn btn-danger', () => {
        ui.raiseDraft = '';
        send({ t: 'act', kind: 'fold' });
      }));
    }

    if (legal.canCheck) {
      row.appendChild(makeButton('过牌', 'btn btn-ghost', () => {
        ui.raiseDraft = '';
        send({ t: 'act', kind: 'check' });
      }));
    } else if (legal.canCall) {
      row.appendChild(makeButton('跟注 ' + legal.need, 'btn btn-ghost', () => {
        ui.raiseDraft = '';
        send({ t: 'act', kind: 'call' });
      }));
    }

    if (legal.canAllIn) {
      // 全下额度 = min(自己积分, 全场最少积分)，被压住时说明原因
      const tableMin = room.seats
        .filter((s) => !s.folded && !s.allIn && s.chips > 0)
        .reduce((min, s) => Math.min(min, s.chips), Infinity);
      const mySeat = room.seats.find((s) => s.id === state.you);
      const capped = Boolean(mySeat && legal.allInAmount < mySeat.chips);
      wrap.appendChild(makeTip('积分不够，可以全下 ' + legal.allInAmount
        + (capped ? '（不超过全场最少积分 ' + tableMin + '）' : '')));
      row.appendChild(makeButton('全下 ' + legal.allInAmount, 'btn btn-gold', () => {
        ui.raiseDraft = '';
        send({ t: 'act', kind: 'allin' });
      }));
    }

    if (!legal.canFold && !legal.canCheck && !legal.canCall && !legal.canAllIn && !legal.canRaise) {
      wrap.appendChild(makeTip('你没有可用的行动，只能等这手结束'));
    }

    wrap.appendChild(row);
    return wrap;
  }

  /* ---------------------------- 首页事件绑定 ---------------------------- */
  function bindHome() {
    $('#btn-create').addEventListener('click', async () => {
      const name = $('#input-name').value.trim();
      try {
        await connect();
      } catch (err) {
        toast(err.message);
        return;
      }
      send({ t: 'create', name: name, avatar: ui.avatar });
    });

    $('#btn-join').addEventListener('click', async () => {
      const code = $('#input-code').value.trim();
      if (!/^\d{3,6}$/.test(code)) {
        toast('请输入数字房间号');
        return;
      }
      const name = $('#input-name').value.trim();
      try {
        await connect();
      } catch (err) {
        toast(err.message);
        return;
      }
      send({ t: 'join', code: code, name: name, avatar: ui.avatar });
    });

    // 房主改起始积分：失焦或回车时提交，避免每敲一个数字就广播
    const chipsInput = $('#input-chips');
    const submitChips = () => {
      if (!ui.state) return;
      const value = Number(chipsInput.value);
      if (!Number.isFinite(value)) return;
      send({ t: 'setchips', value: value });
    };
    chipsInput.addEventListener('change', submitChips);
    chipsInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submitChips();
    });

    $('#btn-start').addEventListener('click', () => send({ t: 'start' }));
  }

  /* ---------------------------- 初始化 ---------------------------- */
  function init() {
    buildPickers();
    syncPreview();
    bindHome();
  }

  init();
})();
