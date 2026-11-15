'use strict';

/* =========================================================================
 * 鲸鱼牌桌 —— 零依赖局域网多人下注小游戏（服务端）
 *
 * 只使用 Node.js 内置模块：http / fs / path / crypto。
 * WebSocket 的握手与帧编解码按 RFC 6455 手写实现，不依赖 ws 等第三方库。
 *
 * 服务端是唯一权威状态：客户端只负责渲染和发指令，
 * 任何下注合法性（轮次、金额、积分是否够）都在这里校验。
 * ========================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------------------- 可调参数 ---------------------------- */
const PORT = Number(process.env.PORT) || 8000;
const ROOT = __dirname;

const SMALL_BLIND = 1; // 小盲固定 1
const BIG_BLIND = 2;   // 大盲固定 2（= 本轮最低下注额）
const MIN_PLAYERS = 3; // 少于 3 人无法排出小盲/大盲/枪口三个位置
const MAX_PLAYERS = 8;
const DEFAULT_START_CHIPS = 100;
const MAX_PAYLOAD = 64 * 1024; // 单帧上限，防御异常客户端

/* ---------------------------- 静态文件服务 ---------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 允许对外提供的静态文件白名单 */
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'game.js']);

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  // 白名单：只对外提供前端需要的三个文件，
  // 同时天然挡掉目录穿越和服务端源码泄露。
  if (!PUBLIC_FILES.has(rel)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

/* ============================ WebSocket 层 ============================ */

/** 所有活动连接 */
const conns = new Set();
/** playerId -> conn，用于按座位广播 */
const playerConns = new Map();

/** 编码服务端 -> 客户端的帧（服务端帧不加掩码） */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN = 1
  return Buffer.concat([header, payload]);
}

/** 发送一个 JSON 文本帧 */
function sendJSON(conn, obj) {
  if (conn.closed) return;
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  try {
    conn.socket.write(encodeFrame(0x1, payload));
  } catch (e) {
    closeConn(conn);
  }
}

function sendRaw(conn, opcode, payload) {
  if (conn.closed) return;
  try {
    conn.socket.write(encodeFrame(opcode, payload));
  } catch (e) {
    closeConn(conn);
  }
}

/** 关闭连接并清理房间里的座位 */
function closeConn(conn) {
  if (conn.closed) return;
  conn.closed = true;
  try { conn.socket.destroy(); } catch (e) { /* 忽略 */ }
  conns.delete(conn);
  if (conn.playerId) playerConns.delete(conn.playerId);
  handleDisconnect(conn);
}

/** 从 TCP 数据流里切出完整帧（客户端帧必须带掩码） */
function pump(conn) {
  for (;;) {
    const buf = conn.buffer;
    if (buf.length < 2) return;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      len = hi * 4294967296 + lo;
      offset = 10;
    }
    if (len > MAX_PAYLOAD) {
      closeConn(conn);
      return;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return;

    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    conn.buffer = buf.subarray(offset + len);

    handleFrame(conn, fin, opcode, payload);
  }
}

/** 处理单个帧：文本、分片、ping/pong、close */
function handleFrame(conn, fin, opcode, payload) {
  if (opcode === 0x8) { // close
    sendRaw(conn, 0x8, Buffer.alloc(0));
    closeConn(conn);
    return;
  }
  if (opcode === 0x9) { // ping
    sendRaw(conn, 0xa, payload);
    return;
  }
  if (opcode === 0xa) return; // pong 忽略

  if (opcode === 0x0) { // 分片续帧
    conn.fragments.push(payload);
  } else if (opcode === 0x1 || opcode === 0x2) {
    conn.fragments = [payload];
    conn.fragOpcode = opcode;
  } else {
    closeConn(conn);
    return;
  }
  if (!fin) return;

  const full = Buffer.concat(conn.fragments);
  conn.fragments = [];
  if (conn.fragOpcode !== 0x1) return; // 只接受文本帧

  let msg;
  try {
    msg = JSON.parse(full.toString('utf8'));
  } catch (e) {
    sendJSON(conn, { t: 'error', message: '消息格式错误' });
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;
  try {
    handleMessage(conn, msg);
  } catch (err) {
    console.error('[处理消息异常]', err);
    sendJSON(conn, { t: 'error', message: '服务端处理出错：' + err.message });
  }
}

/* HTTP upgrade：完成 RFC 6455 握手 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const conn = {
    socket,
    buffer: Buffer.alloc(0),
    fragments: [],
    fragOpcode: 0,
    closed: false,
    playerId: null,
    roomCode: null,
    name: '',
  };
  conns.add(conn);

  socket.on('data', (chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    pump(conn);
  });
  socket.on('close', () => closeConn(conn));
  socket.on('error', () => closeConn(conn));
});

/* ============================ 房间与对局状态 ============================ */

/** code -> room */
const rooms = new Map();

function makeRoomCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

/** 房间对象结构说明：
 *  phase: 'lobby' 等待开局 | 'betting' 下注中 | 'showdown' 等房主选赢家 | 'result' 已结算
 *  seats: 座位数组，顺序即顺时针方向
 *  bet.order: 本轮行动顺序（座位下标），大盲最后行动
 */
function addSeat(room, conn, name, avatar) {
  room.seats.push({
    id: conn.playerId,
    name,
    avatar,
    chips: room.startChips,
    contrib: 0,        // 本手牌累计投入公共池的积分
    streetContrib: 0,  // 本街已经投入的积分（用于算跟注差额）
    folded: false,     // 本手是否已弃牌
    allIn: false,      // 本手是否已经全下（全下后不再行动）
    mustBet: false,    // 第 1 街的小盲/大盲必须先下注，不能弃牌
    lastDelta: 0,      // 上一手盈亏（+赢 / -输）
    connected: true,
  });
}

/** 顺时针（数组下标 +1）方向找下一个座位 */
function nextSeat(room, from, dir, minChips) {
  const n = room.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (((from + dir * i) % n) + n) % n;
    if (room.seats[idx] && room.seats[idx].chips >= minChips) return idx;
  }
  return -1;
}

/**
 * 本街第一个下注的最小金额。
 *
 * 第 1 街由小盲自由决定（最少 1 分），之后各街沿用大盲第 1 街下的金额。
 * 一旦本街已经有人下注，新的下注额下限就是「当前最高注 × 2」。
 */
function minTargetFor(room) {
  return room.bet.currentBet === 0 ? room.minBet : room.bet.currentBet * 2;
}

/** 逆时针（下标递减）走 i 步，成环 */
function ccw(room, from, i) {
  const n = room.seats.length;
  return (((from - i) % n) + n) % n;
}

/**
 * 这个座位现在是否还需要行动。
 * 需要行动 = 没弃牌、没全下、还有积分，且（本街还没轮到他，或者下注额没跟齐）。
 */
function needsAction(room, idx) {
  const seat = room.seats[idx];
  if (!seat || seat.folded || seat.allIn || seat.chips <= 0) return false;
  if (!room.bet.acted.has(idx)) return true;
  return seat.streetContrib < room.bet.currentBet;
}

/** 从 fromIdx 的逆时针下一位开始找第一个还要行动的人，找不到返回 -1 */
function findNextActor(room, fromIdx) {
  const n = room.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = ccw(room, fromIdx, i);
    if (needsAction(room, idx)) return idx;
  }
  return -1;
}

/**
 * 牌桌上还能行动的玩家里面，手里积分最少的那个的积分。
 *
 * 全下以它为上限：大筹码不能一把压死小筹码，
 * 这样任何人被全下时都拿得出跟注的钱，也就不需要边池。
 */
function minStackOnTable(room) {
  let min = Infinity;
  for (const s of room.seats) {
    if (s.folded || s.allIn) continue;
    if (s.chips > 0 && s.chips < min) min = s.chips;
  }
  return min === Infinity ? 0 : min;
}

/** 某个玩家这次全下最多能押多少（自己全部积分 与 全场最小积分 取小） */
function allInLimit(room, seat) {
  return Math.min(seat.chips, minStackOnTable(room));
}

/**
 * 开一手牌：清空本手状态、换庄、进入第 1 街。
 *
 * 不再有系统强制盲注：第 1 街由小盲位先行动，自己决定下多少（最少 1 分）；
 * 大盲位接着必须至少下小盲的 2 倍；两人在这之前不能弃牌。
 */
function beginRound(room) {
  const n = room.seats.length;
  room.round += 1;
  room.street = 1;
  room.pot = 0;
  room.result = null;
  room.bigBlindLevel = 0; // 第 1 街大盲实际下注额，之后作为后续街的最低下注额

  for (const s of room.seats) {
    s.contrib = 0;
    s.streetContrib = 0;
    s.folded = false;
    s.allIn = false;
    s.mustBet = false;
    s.lastDelta = 0;
  }

  // 庄位：第一手随机，之后顺时针轮换（下标 +1）
  room.dealerIndex = room.dealerIndex < 0
    ? Math.floor(Math.random() * n)
    : (room.dealerIndex + 1) % n;

  // 小盲 = 庄位逆时针第一位；大盲 = 第二位
  const sb = nextSeat(room, room.dealerIndex, -1, 1);
  const bb = sb < 0 ? -1 : nextSeat(room, sb, -1, 1);
  room.sbIndex = sb;
  room.bbIndex = bb;

  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  room.minBet = SMALL_BLIND; // 本街首个下注的最小金额：小盲最少下 1

  if (sb < 0 || bb < 0) {
    // 没有任何人有积分了，直接交给房主判定
    room.phase = 'showdown';
    broadcast(room);
    return;
  }

  // 小盲、大盲都必须下注，不能弃牌也不能过牌
  room.seats[sb].mustBet = true;
  room.seats[bb].mustBet = true;

  // 第 1 街从「小盲位」开始说话
  room.bet.actor = sb;
  room.phase = countCanAct(room) > 1 ? 'betting' : 'showdown';
  if (room.phase === 'showdown') room.bet.actor = -1;
  broadcast(room);
}

/**
 * 进入下一条街。
 * 新街无人下注、所有人本街投入清零，第一个行动的人可以过牌，也可以下注。
 * 下注下限沿用第 1 街大盲的实际下注额；行动从小盲位开始，小盲已弃牌则顺延。
 */
function startStreet(room) {
  room.street += 1;
  for (const s of room.seats) {
    s.streetContrib = 0;
    s.mustBet = false;
  }
  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  // 后续街的最低下注额 = 第 1 街大盲下的金额
  room.minBet = room.bigBlindLevel > 0 ? room.bigBlindLevel : BIG_BLIND;

  const start = room.sbIndex >= 0 ? room.sbIndex : room.dealerIndex;
  // findNextActor 从「传入座位的下一位」开始找，传 start + 1 让候选正好是小盲本人
  const first = findNextActor(room, start + 1);
  if (first < 0) {
    room.phase = 'showdown';
    broadcast(room);
    return;
  }
  room.bet.actor = first;
  room.phase = 'betting';
  broadcast(room);
}

/** 还能自由行动的玩家数（没弃牌、没全下、还有积分） */
function countCanAct(room) {
  return room.seats.filter((s) => !s.folded && !s.allIn && s.chips > 0).length;
}

/**
 * 一条街走完：还剩两人以上就开下一街，只剩一人直接进入判定。
 * 注意「还能行动的人 ≤ 1」也必须直接收口——否则剩下那个人会自己跟自己抬价。
 */
function endStreet(room) {
  const alive = room.seats.filter((s) => !s.folded);
  if (alive.length <= 1 || countCanAct(room) <= 1) {
    endBetting(room);
    return;
  }
  startStreet(room);
}

/** 当前行动者结束行动，找下一位；都跟齐了本街就结束 */
function advance(room) {
  // 只剩一个人还能行动时，本街立刻结束，不再让他跟自己下注
  if (countCanAct(room) <= 1) {
    endStreet(room);
    return;
  }
  const next = findNextActor(room, room.bet.actor);
  if (next < 0) {
    endStreet(room);
    return;
  }
  room.bet.actor = next;
  broadcast(room);
}

function endBetting(room) {
  room.bet.actor = -1;
  room.phase = 'showdown';
  broadcast(room);
}

/** 结算：房主指定赢家，池子全归他 */
function settle(room, winnerIndex) {
  const winner = room.seats[winnerIndex];
  if (!winner) return;
  const pot = room.pot;
  for (const s of room.seats) s.lastDelta = -s.contrib;
  winner.chips += pot;
  winner.lastDelta = pot - winner.contrib;
  room.result = {
    winnerId: winner.id,
    winnerName: winner.name,
    amount: pot,
  };
  room.lastPot = pot;
  room.pot = 0;
  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  room.phase = 'result';
  broadcast(room);
}

/**
 * 房主随时结束整局游戏。
 * 还没结算的公共池按各自已投入的积分原路退回，保证总积分不凭空消失。
 */
function endGame(room) {
  for (const s of room.seats) {
    s.chips += s.contrib;
    s.contrib = 0;
  }
  room.pot = 0;
  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  room.result = null;
  room.phase = 'over';
  broadcast(room);
}

/** 房主在结束后重新开一局：所有人积分回到起始值，回到大厅 */
function restartGame(room) {
  for (const s of room.seats) {
    s.chips = room.startChips;
    s.contrib = 0;
    s.folded = false;
    s.lastDelta = 0;
  }
  room.round = 0;
  room.dealerIndex = -1;
  room.sbIndex = -1;
  room.bbIndex = -1;
  room.pot = 0;
  room.lastPot = 0;
  room.result = null;
  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  room.phase = 'lobby';
  broadcast(room);
}

/* ---------------------------- 状态快照 ---------------------------- */

/** 为某个玩家生成完整状态快照（全量推送，避免增量同步出错） */
function stateFor(room, viewerId) {
  const seats = room.seats;
  const me = seats.find((s) => s.id === viewerId) || null;
  const actorSeat = room.bet.actor >= 0 ? seats[room.bet.actor] : null;
  // 跟注差额必须按「本街」已投入的积分算。
  // 用整手牌的 contrib 会算错：第 2 街起 contrib 里还含第 1 街的钱，
  // 会导致欠款被算成 0，客户端把「跟注」错显示成「过牌」。
  const myStreet = me ? me.streetContrib : 0;
  const need = me ? Math.max(0, room.bet.currentBet - myStreet) : 0;
  // 本街下注/加注的下限：首次下注看 minBet，之后一律「当前最高注 × 2」，
  // 但允许玩家下得更大（3 倍、4 倍都可以）。
  const minTarget = minTargetFor(room);
  const mustBet = me !== null && me.mustBet === true;
  // 被迫下注时，必须补到 minTarget；否则补到当前最高注
  const owedToAct = me
    ? Math.max(0, (mustBet ? minTarget : room.bet.currentBet) - myStreet)
    : 0;
  const canAct = room.phase === 'betting' && me !== null && actorSeat !== null && actorSeat.id === me.id;

  return {
    t: 'state',
    you: me ? me.id : null,
    isHost: me !== null && me.id === room.hostId,
    room: {
      code: room.code,
      phase: room.phase,
      round: room.round,
      street: room.street,
      pot: room.pot,
      startChips: room.startChips,
      highestBet: room.bet.currentBet,
      actorId: actorSeat ? actorSeat.id : null,
      dealerId: seats[room.dealerIndex] ? seats[room.dealerIndex].id : null,
      sbId: seats[room.sbIndex] ? seats[room.sbIndex].id : null,
      bbId: seats[room.bbIndex] ? seats[room.bbIndex].id : null,
      result: room.result,
      lastPot: room.lastPot || 0,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      legal: {
        canAct,
        need,
        minTarget,
        mustBet,
        canFold: canAct && !mustBet,
        // 无权补钱时不能过牌；被迫下注时也不能过牌
        canCheck: canAct && !mustBet && need === 0,
        canCall: canAct && !mustBet && need > 0 && me.chips >= need,
        canRaise: canAct && me.chips >= minTarget - myStreet,
        // 积分不够补齐（或被逼下注却拿不出最低额）时，允许把剩下的押上（全下）；
        // 额度还受「全场最少积分」封顶，避免一把压死小筹码
        canAllIn: canAct && me.chips > 0 && me.chips < owedToAct,
        allInAmount: me ? allInLimit(room, me) : 0,
      },
      // 房主随时可以结束整局游戏
      canEndGame: me !== null && me.id === room.hostId && room.phase !== 'over' && room.phase !== 'lobby',
      canRestart: me !== null && me.id === room.hostId && room.phase === 'over',
      seats: seats.map((s, i) => ({
        id: s.id,
        name: s.name,
        avatar: s.avatar,
        chips: s.chips,
        contrib: s.contrib,
        streetContrib: s.streetContrib,
        folded: s.folded,
        allIn: s.allIn,
        connected: s.connected,
        lastDelta: s.lastDelta,
        index: i,
      })),
    },
  };
}

function broadcast(room) {
  for (const seat of room.seats) {
    const conn = playerConns.get(seat.id);
    if (conn && !conn.closed) sendJSON(conn, stateFor(room, seat.id));
  }
}

/* ---------------------------- 消息处理 ---------------------------- */

function handleMessage(conn, msg) {
  switch (msg.t) {
    case 'create': return onCreate(conn, msg);
    case 'join': return onJoin(conn, msg);
    case 'setchips': return onSetChips(conn, msg);
    case 'start': return onStart(conn);
    case 'act': return onAct(conn, msg);
    case 'endbet': return onEndBet(conn);
    case 'endgame': return onEndGame(conn);
    case 'restart': return onRestart(conn);
    case 'pick': return onPick(conn, msg);
    case 'next': return onNext(conn);
    default:
      sendJSON(conn, { t: 'error', message: '未知指令：' + msg.t });
  }
}

function cleanName(raw) {
  const name = String(raw == null ? '' : raw).trim().slice(0, 8);
  return name || '玩家' + Math.floor(1000 + Math.random() * 9000);
}

function cleanAvatar(raw) {
  const emoji = raw && typeof raw.emoji === 'string' ? raw.emoji.slice(0, 4) : '🐳';
  const color = raw && typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)
    ? raw.color
    : '#3b6ea5';
  return { emoji, color };
}

function requireRoom(conn) {
  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  if (!room) {
    sendJSON(conn, { t: 'error', message: '你还没有加入任何房间' });
    return null;
  }
  return room;
}

function onCreate(conn, msg) {
  if (conn.roomCode) {
    sendJSON(conn, { t: 'error', message: '你已经在房间里了' });
    return;
  }
  conn.playerId = crypto.randomUUID();
  conn.name = cleanName(msg.name);
  playerConns.set(conn.playerId, conn);

  const room = {
    code: makeRoomCode(),
    hostId: conn.playerId,
    phase: 'lobby',
    startChips: DEFAULT_START_CHIPS,
    round: 0,
    dealerIndex: -1,
    sbIndex: -1,
    bbIndex: -1,
    pot: 0,
    lastPot: 0,
    result: null,
    seats: [],
    bet: { currentBet: 0, actor: -1, acted: new Set() },
    street: 0,
    minBet: SMALL_BLIND,   // 本街首个下注的最小金额
    bigBlindLevel: 0,      // 第 1 街大盲实际下注额，后续街沿用
  };
  rooms.set(room.code, room);
  conn.roomCode = room.code;
  addSeat(room, conn, conn.name, cleanAvatar(msg.avatar));

  console.log(`[房间] 创建 ${room.code} 房主=${conn.name}`);
  broadcast(room);
}

function onJoin(conn, msg) {
  if (conn.roomCode) {
    sendJSON(conn, { t: 'error', message: '你已经在房间里了' });
    return;
  }
  const code = String(msg.code == null ? '' : msg.code).trim();
  const room = rooms.get(code);
  if (!room) {
    sendJSON(conn, { t: 'error', message: '房间号不存在：' + code });
    return;
  }
  if (room.phase !== 'lobby') {
    sendJSON(conn, { t: 'error', message: '这局已经开始，无法加入' });
    return;
  }
  if (room.seats.length >= MAX_PLAYERS) {
    sendJSON(conn, { t: 'error', message: '房间已满（最多 ' + MAX_PLAYERS + ' 人）' });
    return;
  }

  conn.playerId = crypto.randomUUID();
  conn.name = cleanName(msg.name);
  playerConns.set(conn.playerId, conn);
  conn.roomCode = room.code;
  addSeat(room, conn, conn.name, cleanAvatar(msg.avatar));

  console.log(`[房间] ${room.code} 加入 ${conn.name}（${room.seats.length} 人）`);
  broadcast(room);
}

function onStart(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以开始游戏' });
    return;
  }
  if (room.phase !== 'lobby') return;
  if (room.seats.length < MIN_PLAYERS) {
    sendJSON(conn, { t: 'error', message: '至少需要 ' + MIN_PLAYERS + ' 名玩家才能开局' });
    return;
  }
  for (const s of room.seats) {
    s.chips = room.startChips;
    s.lastDelta = 0;
    s.contrib = 0;
    s.folded = false;
  }
  room.dealerIndex = -1; // 第一轮随机抽庄
  room.round = 0;
  beginRound(room);
}

/** 房主设置每人起始积分（仅在大厅阶段生效） */
function onSetChips(conn, msg) {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以设置起始积分' });
    return;
  }
  if (room.phase !== 'lobby') {
    sendJSON(conn, { t: 'error', message: '开局后不能修改起始积分' });
    return;
  }
  const value = Math.floor(Number(msg.value));
  if (!Number.isFinite(value) || value < 10 || value > 100000) {
    sendJSON(conn, { t: 'error', message: '起始积分需在 10 ~ 100000 之间' });
    return;
  }
  room.startChips = value;
  for (const s of room.seats) s.chips = value;
  broadcast(room);
}

function onAct(conn, msg) {
  const room = requireRoom(conn);
  if (!room) return;
  if (room.phase !== 'betting') {
    sendJSON(conn, { t: 'error', message: '当前不是下注阶段' });
    return;
  }
  const seatIdx = room.seats.findIndex((s) => s.id === conn.playerId);
  if (seatIdx < 0) return;
  if (room.bet.actor !== seatIdx) {
    sendJSON(conn, { t: 'error', message: '还没轮到你行动' });
    return;
  }
  const seat = room.seats[seatIdx];
  // 跟注差额按「本街」已经投入的积分算，不是整手牌的累计
  const need = Math.max(0, room.bet.currentBet - seat.streetContrib);
  // 本街下注/加注的下限：首次下注看 minBet，之后一律「当前最高注 × 2」
  const minTarget = minTargetFor(room);
  // 小盲/大盲第 1 街被迫下注时，必须跟到 minTarget
  const owedToAct = seat.mustBet
    ? Math.max(0, minTarget - seat.streetContrib)
    : need;

  /** 支付一笔积分进公共池 */
  const pay = (amount) => {
    seat.chips -= amount;
    seat.contrib += amount;
    seat.streetContrib += amount;
    room.pot += amount;
    if (seat.chips === 0) seat.allIn = true;
  };

  // ---------- 弃牌 ----------
  if (msg.kind === 'fold') {
    if (seat.mustBet) {
      sendJSON(conn, { t: 'error', message: '第一轮小盲/大盲必须先下注，不能弃牌' });
      return;
    }
    seat.folded = true;
    console.log(`[对局] ${room.code} ${seat.name} 弃牌（第 ${room.street} 街）`);
    advance(room);
    return;
  }

  // ---------- 过牌：只有无需补钱时才能过 ----------
  if (msg.kind === 'check') {
    if (seat.mustBet) {
      sendJSON(conn, { t: 'error', message: `你必须先下注，至少 ${minTarget} 积分` });
      return;
    }
    if (need > 0) {
      sendJSON(conn, {
        t: 'error',
        message: `还有 ${need} 积分没跟齐，不能过牌，只能跟注/加注/弃牌`,
      });
      return;
    }
    room.bet.acted.add(seatIdx);
    console.log(`[对局] ${room.code} ${seat.name} 过牌`);
    advance(room);
    return;
  }

  // ---------- 跟注 ----------
  if (msg.kind === 'call') {
    if (seat.mustBet) {
      sendJSON(conn, { t: 'error', message: `你必须先下注，至少 ${minTarget} 积分，不能只跟注` });
      return;
    }
    if (need === 0) {
      // 没有欠款时「跟注」等价于过牌
      room.bet.acted.add(seatIdx);
      console.log(`[对局] ${room.code} ${seat.name} 过牌（无欠款跟注）`);
      advance(room);
      return;
    }
    if (seat.chips < need) {
      sendJSON(conn, {
        t: 'error',
        message: `积分不足，跟注需要 ${need}，你只有 ${seat.chips}，只能弃牌或全下`,
      });
      return;
    }
    pay(need);
    room.bet.acted.add(seatIdx);
    console.log(`[对局] ${room.code} ${seat.name} 跟注 ${need}`);
    advance(room);
    return;
  }

  // ---------- 全下：积分不够跟注（或被逼下注但拿不出最低额）时 ----------
  if (msg.kind === 'allin') {
    if (seat.chips <= 0) {
      sendJSON(conn, { t: 'error', message: '你的积分已经是 0，不需要全下' });
      return;
    }
    if (owedToAct <= 0) {
      sendJSON(conn, { t: 'error', message: '当前不需要补钱，不需要全下' });
      return;
    }
    if (seat.chips >= owedToAct) {
      sendJSON(conn, {
        t: 'error',
        message: `积分足够（需要 ${owedToAct}），请直接跟注或下注`,
      });
      return;
    }

    const amount = allInLimit(room, seat);
    if (amount <= 0) {
      sendJSON(conn, { t: 'error', message: '没有可全下的积分' });
      return;
    }
    pay(amount);
    // 被「全场最小积分」封顶时手上会剩钱，但仍然算已全下，本手不再行动
    seat.allIn = true;
    seat.mustBet = false;

    // 全下额若超过当前最高注，等同一次加注：其他人必须重新跟齐或弃牌
    if (seat.streetContrib > room.bet.currentBet) {
      room.bet.currentBet = seat.streetContrib;
      room.bet.acted.clear();
    }
    room.bet.acted.add(seatIdx);
    console.log(`[对局] ${room.code} ${seat.name} 全下 ${amount}`);
    advance(room);
    return;
  }

  // ---------- 下注 / 加注：金额自选，下限是 minTarget，上不封顶 ----------
  if (msg.kind === 'raise') {
    const amount = Math.floor(Number(msg.amount));

    if (!Number.isFinite(amount) || amount < minTarget) {
      sendJSON(conn, {
        t: 'error',
        message: seat.mustBet
          ? `你必须下注，而且不能低于 ${minTarget}（大盲至少要给到当前最高注的 2 倍）`
          : `下注/加注不能低于 ${minTarget}（当前最高注的 2 倍）`,
      });
      return;
    }

    const cost = amount - seat.streetContrib;
    if (cost <= 0) {
      sendJSON(conn, { t: 'error', message: '你已经下到这个额度，要加就必须更高' });
      return;
    }
    if (seat.chips < cost) {
      sendJSON(conn, {
        t: 'error',
        message: `积分不足，下到 ${amount} 还需投入 ${cost}，你只有 ${seat.chips}，可以用全下`,
      });
      return;
    }

    pay(cost);
    room.bet.currentBet = amount;
    // 第 1 街大盲下的金额，作为后续各街的最低下注额
    if (room.street === 1 && seatIdx === room.bbIndex) {
      room.bigBlindLevel = amount;
    }
    // 有人加注：其他所有玩家必须重新跟齐或弃牌，所以清空「已行动」标记
    room.bet.acted.clear();
    room.bet.acted.add(seatIdx);
    seat.mustBet = false;
    console.log(`[对局] ${room.code} ${seat.name} 下注/加注到 ${amount}`);
    advance(room);
    return;
  }

  sendJSON(conn, { t: 'error', message: '未知下注动作' });
}

/** 房主提前收口 */
function onEndBet(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以结束下注' });
    return;
  }
  if (room.phase !== 'betting') return;
  endBetting(room);
}

/** 房主随时结束整局游戏 */
function onEndGame(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以结束游戏' });
    return;
  }
  if (room.phase === 'over' || room.phase === 'lobby') return;
  console.log(`[对局] ${room.code} 房主结束游戏`);
  endGame(room);
}

/** 房主结束游戏后重新开局 */
function onRestart(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以重新开局' });
    return;
  }
  if (room.phase !== 'over') {
    sendJSON(conn, { t: 'error', message: '游戏还没结束' });
    return;
  }
  console.log(`[对局] ${room.code} 房主重新开局`);
  restartGame(room);
}

/** 房主指定赢家 */
function onPick(conn, msg) {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以选择赢家' });
    return;
  }
  if (room.phase !== 'showdown') {
    sendJSON(conn, { t: 'error', message: '下注还没结束' });
    return;
  }
  const idx = room.seats.findIndex((s) => s.id === msg.id);
  if (idx < 0) {
    sendJSON(conn, { t: 'error', message: '找不到这名玩家' });
    return;
  }
  console.log(`[对局] ${room.code} 房主判定 ${room.seats[idx].name} 获胜，赢得 ${room.pot}`);
  settle(room, idx);
}

/** 房主开启下一轮 */
function onNext(conn) {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以开下一轮' });
    return;
  }
  if (room.phase !== 'result') {
    sendJSON(conn, { t: 'error', message: '本轮还没结算' });
    return;
  }
  beginRound(room);
}

/* ---------------------------- 断线处理 ---------------------------- */

function handleDisconnect(conn) {
  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  if (!room) return;

  const seat = room.seats.find((s) => s.id === conn.playerId);
  if (seat) seat.connected = false;

  // 大厅阶段直接移除座位，牌局中保留座位（仅标记离线，跳过其行动）
  if (room.phase === 'lobby' && seat) {
    room.seats = room.seats.filter((s) => s.id !== conn.playerId);
  }

  const online = room.seats.filter((s) => s.connected);

  if (online.length === 0) {
    rooms.delete(room.code);
    console.log(`[房间] ${room.code} 已解散`);
    return;
  }

  // 房主掉线：把房主转给还在线的第一个人，避免房间无人能操作
  if (room.hostId === conn.playerId) {
    room.hostId = online[0].id;
    console.log(`[房间] ${room.code} 房主转移给 ${online[0].name}`);
  }

  // 下注中有人掉线导致人数不足，直接收口交给房主结算
  if (room.phase === 'betting' && online.length < MIN_PLAYERS) {
    endBetting(room);
    return;
  }
  broadcast(room);
}

/* ---------------------------- 启动 ---------------------------- */

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  鲸鱼牌桌 已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  console.log('  局域网内手机访问：把 localhost 换成电脑的局域网 IP');
  console.log('  例如 http://192.168.1.10:' + PORT);
  console.log('  按 Ctrl+C 停止');
  console.log('==============================================');
});
