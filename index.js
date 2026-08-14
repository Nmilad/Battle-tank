import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(__dirname));


const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- logical arena (fixed, client scales to fit screen) ----------
const W = 900, H = 600;
const TANK_SIZE = 24;
const TANK_SPEED = 2.3;
const TURN_SPEED = 0.05;
const BULLET_SPEED = 6.2;
const BULLET_COOLDOWN = 24;
const MAX_HP = 100;
const BULLET_DAMAGE = 20;
const TICK_MS = 1000 / 30;

function makeWalls() {
  return [
    {x: W*0.46, y: 0, w: W*0.07, h: H*0.3},
    {x: W*0.46, y: H*0.7, w: W*0.07, h: H*0.3},
    {x: W*0.16, y: H*0.42, w: W*0.14, h: H*0.05},
    {x: W*0.70, y: H*0.53, w: W*0.14, h: H*0.05},
    {x: 0, y: 0, w: W, h: 6},
    {x: 0, y: H-6, w: W, h: 6},
    {x: 0, y: 0, w: 6, h: H},
    {x: W-6, y: 0, w: 6, h: H},
  ];
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function tankBounds(t) {
  return {x: t.x - TANK_SIZE/2, y: t.y - TANK_SIZE/2, w: TANK_SIZE, h: TANK_SIZE};
}

const rooms = new Map(); // roomId -> room state

function makeTank(x, y, angle) {
  return { x, y, angle, hp: MAX_HP, cooldown: 0, alive: true, input: {dx:0, dy:0, firing:false} };
}

function createRoom(roomId) {
  const room = {
    id: roomId,
    walls: makeWalls(),
    players: {}, // slot -> {ws, tank}
    bullets: [],
    round: 1,
    matchOver: true,
    winner: null,
    interval: null,
  };
  rooms.set(roomId, room);
  return room;
}

function resetMatch(room) {
  room.players[1].tank = makeTank(W*0.16, H*0.5, 0);
  room.players[2].tank = makeTank(W*0.84, H*0.5, Math.PI);
  room.bullets = [];
  room.matchOver = false;
  room.winner = null;
}

function tryMove(tank, otherTank, nx, ny, walls) {
  const b = {x: nx - TANK_SIZE/2, y: ny - TANK_SIZE/2, w: TANK_SIZE, h: TANK_SIZE};
  for (const w of walls) if (rectsOverlap(b, w)) return false;
  if (otherTank.alive && rectsOverlap(b, tankBounds(otherTank))) return false;
  return true;
}

function fireBullet(room, tank, slot) {
  if (tank.cooldown > 0) return;
  room.bullets.push({
    x: tank.x + Math.cos(tank.angle) * (TANK_SIZE/2 + 6),
    y: tank.y + Math.sin(tank.angle) * (TANK_SIZE/2 + 6),
    vx: Math.cos(tank.angle) * BULLET_SPEED,
    vy: Math.sin(tank.angle) * BULLET_SPEED,
    owner: slot,
  });
  tank.cooldown = BULLET_COOLDOWN;
}

function tick(room) {
  if (!room.matchOver) {
    for (const slot of [1, 2]) {
      const p = room.players[slot];
      if (!p || !p.tank.alive) continue;
      const t = p.tank;
      const other = room.players[slot === 1 ? 2 : 1].tank;
      const { dx: sx, dy: sy, firing } = t.input;

      if (Math.abs(sx) > 0.15 || Math.abs(sy) > 0.15) {
        const targetAngle = Math.atan2(sy, sx);
        let diff = targetAngle - t.angle;
        while (diff > Math.PI) diff -= Math.PI*2;
        while (diff < -Math.PI) diff += Math.PI*2;
        t.angle += Math.max(-TURN_SPEED, Math.min(TURN_SPEED, diff));

        const mag = Math.min(1, Math.hypot(sx, sy));
        const mx = Math.cos(t.angle) * TANK_SPEED * mag;
        const my = Math.sin(t.angle) * TANK_SPEED * mag;
        if (tryMove(t, other, t.x + mx, t.y, room.walls)) t.x += mx;
        if (tryMove(t, other, t.x, t.y + my, room.walls)) t.y += my;
      }
      t.cooldown = Math.max(0, t.cooldown - 1);
      if (firing) fireBullet(room, t, slot);
    }

    room.bullets = room.bullets.filter(b => {
      b.x += b.vx; b.y += b.vy;
      const bb = {x: b.x-3, y: b.y-3, w:6, h:6};
      for (const w of room.walls) if (rectsOverlap(bb, w)) return false;
      for (const slot of [1, 2]) {
        const p = room.players[slot];
        if (!p || slot === b.owner || !p.tank.alive) continue;
        if (rectsOverlap(bb, tankBounds(p.tank))) {
          p.tank.hp -= BULLET_DAMAGE;
          if (p.tank.hp <= 0) {
            p.tank.hp = 0; p.tank.alive = false;
            room.matchOver = true;
            room.winner = b.owner;
            room.round++;
          }
          return false;
        }
      }
      return b.x > 0 && b.x < W && b.y > 0 && b.y < H;
    });
  }

  const state = {
    type: 'state',
    players: {
      1: room.players[1] ? serTank(room.players[1].tank) : null,
      2: room.players[2] ? serTank(room.players[2].tank) : null,
    },
    bullets: room.bullets.map(b => ({x: b.x, y: b.y, owner: b.owner})),
    round: room.round,
    matchOver: room.matchOver,
    winner: room.winner,
    connected: { 1: !!room.players[1], 2: !!room.players[2] },
  };
  broadcast(room, state);
}

function serTank(t) {
  return { x: t.x, y: t.y, angle: t.angle, hp: t.hp, alive: t.alive };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const slot of [1, 2]) {
    const p = room.players[slot];
    if (p && p.ws.readyState === 1) p.ws.send(data);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const roomId = (url.searchParams.get('room') || 'default').toUpperCase().slice(0, 8);

  let room = rooms.get(roomId);
  if (!room) room = createRoom(roomId);

  let slot = null;
  if (!room.players[1]) slot = 1;
  else if (!room.players[2]) slot = 2;

  if (!slot) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  room.players[slot] = { ws, tank: makeTank(0, 0, 0) };
  ws.send(JSON.stringify({ type: 'welcome', slot, roomId, arena: { W, H }, walls: room.walls }));

  if (room.players[1] && room.players[2] && room.matchOver) {
    resetMatch(room);
  }

  if (!room.interval) {
    room.interval = setInterval(() => tick(room), TICK_MS);
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input') {
        const p = room.players[slot];
        if (p) p.tank.input = { dx: msg.dx || 0, dy: msg.dy || 0, firing: !!msg.firing };
      } else if (msg.type === 'restart') {
        if (room.players[1] && room.players[2]) resetMatch(room);
      }
    } catch (e) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    delete room.players[slot];
    room.matchOver = true;
    room.winner = null;
    broadcast(room, { type: 'state', players: {1:null,2:null}, bullets: [], round: room.round, matchOver: true, winner: null, connected: { 1: !!room.players[1], 2: !!room.players[2] } });
    if (!room.players[1] && !room.players[2]) {
      clearInterval(room.interval);
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Tank Arena server on :' + PORT));
