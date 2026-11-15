/**
 * 鲸鱼牌桌 —— Deno Deploy 版本
 *
 * 与 server.js（Node 版）玩法完全一致，区别只在运行时：
 *   - 用 Deno.serve 处理请求
 *   - 用 Deno.upgradeWebSocket 接管 WebSocket（不需要手写帧协议）
 *   - 前端资源打包成 assets.ts 一起部署（Deno Deploy 没有文件系统）
 *
 * 房间状态放在内存里，靠 WebSocket 长连接把 isolate 钉住。
 */

import { INDEX_HTML, STYLE_CSS, GAME_JS } from './assets.ts';

/* ---------------------------- 参数 ---------------------------- */
const SMALL_BLIND = 1;
const BIG_BLIND = 2;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const DEFAULT_START_CHIPS = 100;

/* ---------------------------- 类型 ---------------------------- */
interface Seat {
  id: string;
  name: string;
  avatar: { emoji: string; color: string };
  chips: number;
  contrib: number;
  streetContrib: number;
  folded: boolean;
  allIn: boolean;
  mustBet: boolean;
  lastDelta: number;
  connected: boolean;
}

interface Room {
  code: string;
  hostId: string;
  phase: 'lobby' | 'betting' | 'showdown' | 'result' | 'over';
  startChips: number;
  round: number;
  dealerIndex: number;
  sbIndex: number;
  bbIndex: number;
  pot: number;
  lastPot: number;
  result: { winnerId: string; winnerName: string; amount: number } | null;
  seats: Seat[];
  bet: { currentBet: number; actor: number; acted: Set<number> };
  street: number;
  minBet: number;
  bigBlindLevel: number;
}

interface Conn {
  ws: WebSocket;
  playerId: string | null;
  roomCode: string | null;
  closed: boolean;
}

const rooms = new Map<string, Room>();
const playerConns = new Map<string, Conn>();

/* ---------------------------- 静态资源 ---------------------------- */
const STATIC: Record<string, { body: string; type: string }> = {
  '/': { body: INDEX_HTML, type: 'text/html; charset=utf-8' },
  '/index.html': { body: INDEX_HTML, type: 'text/html; charset=utf-8' },
  '/style.css': { body: STYLE_CSS, type: 'text/css; charset=utf-8' },
  '/game.js': { body: GAME_JS, type: 'application/javascript; charset=utf-8' },
};

function serveStatic(pathname: string): Response {
  const hit = STATIC[pathname];
  if (!hit) return new Response('404 Not Found', { status: 404 });
  return new Response(hit.body, {
    status: 200,
    headers: { 'content-type': hit.type, 'cache-control': 'no-store' },
  });
}

/* ---------------------------- 发送 ---------------------------- */
function sendJSON(conn: Conn, obj: unknown): void {
  if (conn.closed) return;
  try {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
  } catch {
    closeConn(conn);
  }
}

function closeConn(conn: Conn): void {
  if (conn.closed) return;
  conn.closed = true;
  if (conn.playerId) playerConns.delete(conn.playerId);
  try {
    conn.ws.close();
  } catch {
    /* 忽略 */
  }
  handleDisconnect(conn);
}

/* ---------------------------- 座位与盲注位置 ---------------------------- */
function addSeat(room: Room, conn: Conn, name: string, avatar: Seat['avatar']): void {
  room.seats.push({
    id: conn.playerId as string,
    name,
    avatar,
    chips: room.startChips,
    contrib: 0,
    streetContrib: 0,
    folded: false,
    allIn: false,
    mustBet: false,
    lastDelta: 0,
    connected: true,
  });
}

function nextSeat(room: Room, from: number, dir: number, minChips: number): number {
  const n = room.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (((from + dir * i) % n) + n) % n;
    if (room.seats[idx] && room.seats[idx].chips >= minChips) return idx;
  }
  return -1;
}

function ccw(room: Room, from: number, i: number): number {
  const n = room.seats.length;
  return (((from - i) % n) + n) % n;
}

function needsAction(room: Room, idx: number): boolean {
  const seat = room.seats[idx];
  if (!seat || seat.folded || seat.allIn || seat.chips <= 0) return false;
  if (!room.bet.acted.has(idx)) return true;
  return seat.streetContrib < room.bet.currentBet;
}

function findNextActor(room: Room, fromIdx: number): number {
  const n = room.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = ccw(room, fromIdx, i);
    if (needsAction(room, idx)) return idx;
  }
  return -1;
}

function minStackOnTable(room: Room): number {
  let min = Infinity;
  for (const s of room.seats) {
    if (s.folded || s.allIn) continue;
    if (s.chips > 0 && s.chips < min) min = s.chips;
  }
  return min === Infinity ? 0 : min;
}

function allInLimit(room: Room, seat: Seat): number {
  return Math.min(seat.chips, minStackOnTable(room));
}

function countCanAct(room: Room): number {
  return room.seats.filter((s) => !s.folded && !s.allIn && s.chips > 0).length;
}

/** 本街下注/加注的下限 */
function minTargetFor(room: Room): number {
  return room.bet.currentBet === 0 ? room.minBet : room.bet.currentBet * 2;
}

/* ---------------------------- 开牌与街 ---------------------------- */
function beginRound(room: Room): void {
  const n = room.seats.length;
  room.round += 1;
  room.street = 1;
  room.pot = 0;
  room.result = null;
  room.bigBlindLevel = 0;

  for (const s of room.seats) {
    s.contrib = 0;
    s.streetContrib = 0;
    s.folded = false;
    s.allIn = false;
    s.mustBet = false;
    s.lastDelta = 0;
  }

  room.dealerIndex = room.dealerIndex < 0
    ? Math.floor(Math.random() * n)
    : (room.dealerIndex + 1) % n;

  const sb = nextSeat(room, room.dealerIndex, -1, 1);
  const bb = sb < 0 ? -1 : nextSeat(room, sb, -1, 1);
  room.sbIndex = sb;
  room.bbIndex = bb;

  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  room.minBet = SMALL_BLIND;

  if (sb < 0 || bb < 0) {
    room.phase = 'showdown';
    broadcast(room);
    return;
  }

  // 第 1 街：小盲先自由下注（≥1），大盲必须 ≥ 小盲的 2 倍；两人都不能弃牌
  room.seats[sb].mustBet = true;
  room.seats[bb].mustBet = true;

  room.bet.actor = sb;
  room.phase = countCanAct(room) > 1 ? 'betting' : 'showdown';
  if (room.phase === 'showdown') room.bet.actor = -1;
  broadcast(room);
}

function startStreet(room: Room): void {
  room.street += 1;
  for (const s of room.seats) {
    s.streetContrib = 0;
    s.mustBet = false;
  }
  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  room.minBet = room.bigBlindLevel > 0 ? room.bigBlindLevel : BIG_BLIND;

  const start = room.sbIndex >= 0 ? room.sbIndex : room.dealerIndex;
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

function endStreet(room: Room): void {
  const alive = room.seats.filter((s) => !s.folded);
  if (alive.length <= 1 || countCanAct(room) <= 1) {
    endBetting(room);
    return;
  }
  startStreet(room);
}

function advance(room: Room): void {
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

function endBetting(room: Room): void {
  room.bet.actor = -1;
  room.phase = 'showdown';
  broadcast(room);
}

function settle(room: Room, winnerIndex: number): void {
  const winner = room.seats[winnerIndex];
  if (!winner) return;
  const pot = room.pot;
  for (const s of room.seats) s.lastDelta = -s.contrib;
  winner.chips += pot;
  winner.lastDelta = pot - winner.contrib;
  room.result = { winnerId: winner.id, winnerName: winner.name, amount: pot };
  room.lastPot = pot;
  room.pot = 0;
  room.bet = { currentBet: 0, actor: -1, acted: new Set() };
  room.phase = 'result';
  broadcast(room);
}

function endGame(room: Room): void {
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

function restartGame(room: Room): void {
  for (const s of room.seats) {
    s.chips = room.startChips;
    s.contrib = 0;
    s.streetContrib = 0;
    s.folded = false;
    s.allIn = false;
    s.mustBet = false;
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
  room.street = 0;
  room.minBet = SMALL_BLIND;
  room.bigBlindLevel = 0;
  room.phase = 'lobby';
  broadcast(room);
}

/* ---------------------------- 状态快照 ---------------------------- */
function stateFor(room: Room, viewerId: string) {
  const seats = room.seats;
  const me = seats.find((s) => s.id === viewerId) || null;
  const actorSeat = room.bet.actor >= 0 ? seats[room.bet.actor] : null;
  const myStreet = me ? me.streetContrib : 0;
  const need = me ? Math.max(0, room.bet.currentBet - myStreet) : 0;
  const minTarget = minTargetFor(room);
  const mustBet = me !== null && me.mustBet === true;
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
        canCheck: canAct && !mustBet && need === 0,
        canCall: canAct && !mustBet && need > 0 && (me as Seat).chips >= need,
        canRaise: canAct && (me as Seat).chips >= minTarget - myStreet,
        canAllIn: canAct && (me as Seat).chips > 0 && (me as Seat).chips < owedToAct,
        allInAmount: me ? allInLimit(room, me) : 0,
      },
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

function broadcast(room: Room): void {
  for (const seat of room.seats) {
    const conn = playerConns.get(seat.id);
    if (conn && !conn.closed) sendJSON(conn, stateFor(room, seat.id));
  }
}

/* ---------------------------- WebSocket ---------------------------- */
function handleWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const conn: Conn = { ws: socket, playerId: null, roomCode: null, closed: false };

  socket.onmessage = (event) => {
    let msg: { t?: string };
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      sendJSON(conn, { t: 'error', message: '消息格式错误' });
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handleMessage(conn, msg as { t: string } & Record<string, unknown>);
    } catch (err) {
      console.error('[处理消息异常]', err);
      sendJSON(conn, { t: 'error', message: '服务端处理出错：' + (err as Error).message });
    }
  };
  socket.onclose = () => closeConn(conn);
  socket.onerror = () => closeConn(conn);

  return response;
}

/* ---------------------------- 消息处理 ---------------------------- */
function handleMessage(conn: Conn, msg: { t: string } & Record<string, unknown>): void {
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

function cleanName(raw: unknown): string {
  const name = String(raw == null ? '' : raw).trim().slice(0, 8);
  return name || '玩家' + Math.floor(1000 + Math.random() * 9000);
}

function cleanAvatar(raw: unknown): Seat['avatar'] {
  const o = (raw || {}) as { emoji?: unknown; color?: unknown };
  const emoji = typeof o.emoji === 'string' ? o.emoji.slice(0, 4) : '🐳';
  const color = typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : '#3b6ea5';
  return { emoji, color };
}

function requireRoom(conn: Conn): Room | null {
  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  if (!room) {
    sendJSON(conn, { t: 'error', message: '你还没有加入任何房间' });
    return null;
  }
  return room;
}

function makeRoomCode(): string {
  for (let i = 0; i < 200; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}

function onCreate(conn: Conn, msg: Record<string, unknown>): void {
  if (conn.roomCode) {
    sendJSON(conn, { t: 'error', message: '你已经在房间里了' });
    return;
  }
  conn.playerId = crypto.randomUUID();
  playerConns.set(conn.playerId, conn);

  const room: Room = {
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
    minBet: SMALL_BLIND,
    bigBlindLevel: 0,
  };
  rooms.set(room.code, room);
  conn.roomCode = room.code;
  addSeat(room, conn, cleanName(msg.name), cleanAvatar(msg.avatar));
  console.log(`[房间] 创建 ${room.code}`);
  broadcast(room);
}

function onJoin(conn: Conn, msg: Record<string, unknown>): void {
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
  playerConns.set(conn.playerId, conn);
  conn.roomCode = room.code;
  addSeat(room, conn, cleanName(msg.name), cleanAvatar(msg.avatar));
  console.log(`[房间] ${room.code} 加入（${room.seats.length} 人）`);
  broadcast(room);
}

function onStart(conn: Conn): void {
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
    s.allIn = false;
    s.mustBet = false;
  }
  room.dealerIndex = -1;
  room.round = 0;
  beginRound(room);
}

function onSetChips(conn: Conn, msg: Record<string, unknown>): void {
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

function onAct(conn: Conn, msg: Record<string, unknown>): void {
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
  const need = Math.max(0, room.bet.currentBet - seat.streetContrib);
  const minTarget = minTargetFor(room);
  const owedToAct = seat.mustBet ? Math.max(0, minTarget - seat.streetContrib) : need;

  const pay = (amount: number) => {
    seat.chips -= amount;
    seat.contrib += amount;
    seat.streetContrib += amount;
    room.pot += amount;
    if (seat.chips === 0) seat.allIn = true;
  };

  if (msg.kind === 'fold') {
    if (seat.mustBet) {
      sendJSON(conn, { t: 'error', message: '第一轮小盲/大盲必须先下注，不能弃牌' });
      return;
    }
    seat.folded = true;
    advance(room);
    return;
  }

  if (msg.kind === 'check') {
    if (seat.mustBet) {
      sendJSON(conn, { t: 'error', message: `你必须先下注，至少 ${minTarget} 积分` });
      return;
    }
    if (need > 0) {
      sendJSON(conn, { t: 'error', message: `还有 ${need} 积分没跟齐，不能过牌，只能跟注/加注/弃牌` });
      return;
    }
    room.bet.acted.add(seatIdx);
    advance(room);
    return;
  }

  if (msg.kind === 'call') {
    if (seat.mustBet) {
      sendJSON(conn, { t: 'error', message: `你必须先下注，至少 ${minTarget} 积分，不能只跟注` });
      return;
    }
    if (need === 0) {
      room.bet.acted.add(seatIdx);
      advance(room);
      return;
    }
    if (seat.chips < need) {
      sendJSON(conn, { t: 'error', message: `积分不足，跟注需要 ${need}，你只有 ${seat.chips}，只能弃牌或全下` });
      return;
    }
    pay(need);
    room.bet.acted.add(seatIdx);
    advance(room);
    return;
  }

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
      sendJSON(conn, { t: 'error', message: `积分足够（需要 ${owedToAct}），请直接跟注或下注` });
      return;
    }
    const amount = allInLimit(room, seat);
    if (amount <= 0) {
      sendJSON(conn, { t: 'error', message: '没有可全下的积分' });
      return;
    }
    pay(amount);
    seat.allIn = true;
    seat.mustBet = false;
    if (seat.streetContrib > room.bet.currentBet) {
      room.bet.currentBet = seat.streetContrib;
      room.bet.acted.clear();
    }
    room.bet.acted.add(seatIdx);
    advance(room);
    return;
  }

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
      sendJSON(conn, { t: 'error', message: `积分不足，下到 ${amount} 还需投入 ${cost}，你只有 ${seat.chips}，可以用全下` });
      return;
    }
    pay(cost);
    room.bet.currentBet = amount;
    if (room.street === 1 && seatIdx === room.bbIndex) room.bigBlindLevel = amount;
    room.bet.acted.clear();
    room.bet.acted.add(seatIdx);
    seat.mustBet = false;
    advance(room);
    return;
  }

  sendJSON(conn, { t: 'error', message: '未知下注动作' });
}

function onEndBet(conn: Conn): void {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以结束下注' });
    return;
  }
  if (room.phase !== 'betting') return;
  endBetting(room);
}

function onEndGame(conn: Conn): void {
  const room = requireRoom(conn);
  if (!room) return;
  if (conn.playerId !== room.hostId) {
    sendJSON(conn, { t: 'error', message: '只有房主可以结束游戏' });
    return;
  }
  if (room.phase === 'over' || room.phase === 'lobby') return;
  endGame(room);
}

function onRestart(conn: Conn): void {
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
  restartGame(room);
}

function onPick(conn: Conn, msg: Record<string, unknown>): void {
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
  settle(room, idx);
}

function onNext(conn: Conn): void {
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

/* ---------------------------- 断线 ---------------------------- */
function handleDisconnect(conn: Conn): void {
  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  if (!room) return;

  const seat = room.seats.find((s) => s.id === conn.playerId);
  if (seat) seat.connected = false;

  if (room.phase === 'lobby' && seat) {
    room.seats = room.seats.filter((s) => s.id !== conn.playerId);
  }

  const online = room.seats.filter((s) => s.connected);
  if (online.length === 0) {
    rooms.delete(room.code);
    console.log(`[房间] ${room.code} 已解散`);
    return;
  }

  if (room.hostId === conn.playerId) {
    room.hostId = online[0].id;
  }

  if (room.phase === 'betting' && online.length < MIN_PLAYERS) {
    endBetting(room);
    return;
  }
  broadcast(room);
}

/* ---------------------------- 入口 ---------------------------- */
function resolvePort(): number {
  // Deno Deploy 不需要端口；本地跑时允许用 PORT 环境变量指定
  try {
    const raw = Deno.env.get('PORT');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 8000;
  } catch {
    return 8000;
  }
}

Deno.serve({ port: resolvePort() }, (req: Request) => {
  const url = new URL(req.url);
  const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
  if (upgrade === 'websocket') return handleWs(req);
  return serveStatic(url.pathname);
});
