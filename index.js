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
const W = 1000, H = 500;
const GROUND_Y = H - 60;
const TANK_W = 36, TANK_H = 44;
const GRAVITY = 0.55;
const JUMP_VELOCITY = -11.5;
const TICK_MS = 1000 / 30;

// ---------- class definitions ----------
const CLASSES = {
  typhoon: {
    name: 'تایفون', color: '#C9B458',
    maxHp: 150, speed: 2.6, jumpVel: JUMP_VELOCITY * 0.85,
    bulletDamage: 14, bulletSpeed: 7, fireCooldown: 30,
    ability: 'slam', abilityCooldown: 300,
  },
  reaper: {
    name: 'ریپر', color: '#AEB7BE',
    maxHp: 75, speed: 4.6, jumpVel: JUMP_VELOCITY * 1.1,
    bulletDamage: 9, bulletSpeed: 9.5, fireCooldown: 14,
    ability: 'dash', abilityCooldown: 130,
  },
  guardian: {
    name: 'گاردین', color: '#5FA0D6',
    maxHp: 105, speed: 3.2, jumpVel: JUMP_VELOCITY,
    bulletDamage: 7, bulletSpeed: 7.5, fireCooldown: 28,
    ability: 'heal', abilityCooldown: 350,
  },
  vanquisher: {
    name: 'وانکویشر', color: '#C25B4A',
    maxHp: 65, speed: 2.8, jumpVel: JUMP_VELOCITY * 0.9,
    bulletDamage: 24, bulletSpeed: 11, fireCooldown: 48,
    ability: 'snipe', abilityCooldown: 300,
  },
};
const DEFAULT_CLASS = 'typhoon';

function makePlatforms() {
  return [
    // ground
    {x: 0, y: GROUND_Y, w: W, h: H - GROUND_Y},
    // floating platforms
    {x: W*0.10, y: GROUND_Y - 130, w: W*0.16, h: 16},
    {x: W*0.74, y: GROUND_Y - 130, w: W*0.16, h: 16},
    {x: W*0.42, y: GROUND_Y - 220, w: W*0.16, h: 16},
    // side walls (invisible bounds)
    {x: -20, y: 0, w: 20, h: H},
    {x: W, y: 0, w: 20, h: H},
  ];
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function tankBounds(t) {
  return {x: t.x - TANK_W/2, y: t.y - TANK_H, w: TANK_W, h: TANK_H};
}

const rooms = new Map();

function makeTank(x, cls) {
  const def = CLASSES[cls] || CLASSES[DEFAULT_CLASS];
  return {
    x, y: GROUND_Y, vy: 0, facing: 1, grounded: true, cls,
    hp: def.maxHp, maxHp: def.maxHp,
    cooldown: 0, alive: true,
    input: {dx:0, firing:false},
    abilityCooldown: 0,
    dashTicks: 0,
    aimBoostTicks: 0,
  };
}

function createRoom(roomId) {
  const room = {
    id: roomId,
    platforms: makePlatforms(),
    players: {},
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
  const cls1 = (room.players[1] && room.players[1].cls) || DEFAULT_CLASS;
  const cls2 = (room.players[2] && room.players[2].cls) || DEFAULT_CLASS;
  room.players[1].tank = makeTank(W*0.2, cls1);
  room.players[1].tank.facing = 1;
  room.players[2].tank = makeTank(W*0.8, cls2);
  room.players[2].tank.facing = -1;
  room.bullets = [];
  room.matchOver = false;
  room.winner = null;
}

// resolve movement with platform collision (simple AABB, solid platforms)
function moveTank(t, other, platforms) {
  // horizontal
  const newX = t.x + t._dx;
  let b = {x: newX - TANK_W/2, y: t.y - TANK_H, w: TANK_W, h: TANK_H};
  let blocked = false;
  for (const p of platforms) if (rectsOverlap(b, p)) { blocked = true; break; }
  if (other.alive && rectsOverlap(b, tankBounds(other))) blocked = true;
  if (!blocked) t.x = Math.max(10, Math.min(W - 10, newX));

  // vertical
  t.vy += GRAVITY;
  const newY = t.y + t.vy;
  b = {x: t.x - TANK_W/2, y: newY - TANK_H, w: TANK_W, h: TANK_H};
  let vBlocked = false;
  let landed = false;
  for (const p of platforms) {
    if (rectsOverlap(b, p)) {
      vBlocked = true;
      if (t.vy > 0) { t.y = p.y; landed = true; }
      else { t.y = p.y + p.h + TANK_H; }
      t.vy = 0;
      break;
    }
  }
  if (!vBlocked) t.y = newY;
  t.grounded = landed;
}

function fireBullet(room, tank, slot) {
  const def = CLASSES[tank.cls];
  if (tank.cooldown > 0) return;
  const dmgMult = tank.aimBoostTicks > 0 ? 1.5 : 1;
  const spdMult = tank.aimBoostTicks > 0 ? 1.3 : 1;
  room.bullets.push({
    x: tank.x + tank.facing * (TANK_W/2 + 4),
    y: tank.y - TANK_H*0.55,
    vx: tank.facing * def.bulletSpeed * spdMult,
    owner: slot,
    damage: def.bulletDamage * dmgMult,
  });
  tank.cooldown = def.fireCooldown;
}

function applyDamage(room, targetSlot, amount, sourceSlot) {
  const p = room.players[targetSlot];
  if (!p || !p.tank.alive) return;
  p.tank.hp -= amount;
  if (p.tank.hp <= 0) {
    p.tank.hp = 0; p.tank.alive = false;
    room.matchOver = true;
    room.winner = sourceSlot;
    room.round++;
  }
}

function useAbility(room, slot) {
  const p = room.players[slot];
  if (!p || !p.tank.alive) return;
  const t = p.tank;
  const def = CLASSES[t.cls];
  if (t.abilityCooldown > 0) return;
  t.abilityCooldown = def.abilityCooldown;

  const otherSlot = slot === 1 ? 2 : 1;
  const other = room.players[otherSlot];

  switch (def.ability) {
    case 'slam': {
      if (other && other.tank.alive) {
        const dist = Math.hypot(other.tank.x - t.x, other.tank.y - t.y);
        if (dist < 110) {
          applyDamage(room, otherSlot, 18, slot);
          const dir = other.tank.x > t.x ? 1 : -1;
          other.tank.x += dir * 45;
          other.tank.vy = -6;
        }
      }
      break;
    }
    case 'dash': {
      t.dashTicks = 9;
      break;
    }
    case 'heal': {
      t.hp = Math.min(t.maxHp, t.hp + 35);
      break;
    }
    case 'snipe': {
      t.aimBoostTicks = 90;
      break;
    }
  }
}

function jumpTank(room, slot) {
  const p = room.players[slot];
  if (!p || !p.tank.alive) return;
  const t = p.tank;
  const def = CLASSES[t.cls];
  if (t.grounded) {
    t.vy = def.jumpVel;
    t.grounded = false;
  }
}

function tick(room) {
  if (!room.matchOver) {
    for (const slot of [1, 2]) {
      const p = room.players[slot];
      if (!p || !p.tank.alive) continue;
      const t = p.tank;
      const def = CLASSES[t.cls];
      const other = room.players[slot === 1 ? 2 : 1].tank;
      const { dx, firing } = t.input;

      if (t.abilityCooldown > 0) t.abilityCooldown--;
      if (t.aimBoostTicks > 0) t.aimBoostTicks--;

      let moveDx = 0;
      if (t.dashTicks > 0) {
        t.dashTicks--;
        moveDx = t.facing * def.speed * 2.4;
      } else if (Math.abs(dx) > 0.12) {
        moveDx = Math.sign(dx) * def.speed * Math.min(1, Math.abs(dx));
        t.facing = dx > 0 ? 1 : -1;
      }
      t._dx = moveDx;
      moveTank(t, other, room.platforms);

      t.cooldown = Math.max(0, t.cooldown - 1);
      if (firing) fireBullet(room, t, slot);
    }

    room.bullets = room.bullets.filter(b => {
      b.x += b.vx;
      const bb = {x: b.x-4, y: b.y-3, w:8, h:6};
      for (const slot of [1, 2]) {
        const p = room.players[slot];
        if (!p || slot === b.owner || !p.tank.alive) continue;
        if (rectsOverlap(bb, tankBounds(p.tank))) {
          applyDamage(room, slot, b.damage, b.owner);
          return false;
        }
      }
      return b.x > -20 && b.x < W + 20;
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
  const def = CLASSES[t.cls];
  return {
    x: t.x, y: t.y, facing: t.facing, hp: t.hp, maxHp: t.maxHp, alive: t.alive,
    cls: t.cls, abilityCooldown: t.abilityCooldown, abilityMax: def.abilityCooldown,
    dashing: t.dashTicks > 0, aimBoost: t.aimBoostTicks > 0, grounded: t.grounded,
  };
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
  const cls = CLASSES[url.searchParams.get('cls')] ? url.searchParams.get('cls') : DEFAULT_CLASS;

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

  room.players[slot] = { ws, tank: makeTank(0, cls), cls };
  ws.send(JSON.stringify({
    type: 'welcome', slot, roomId, arena: { W, H, GROUND_Y },
    platforms: room.platforms,
    classes: Object.fromEntries(Object.entries(CLASSES).map(([k,v]) => [k, {name:v.name, color:v.color}])),
  }));

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
        if (p) p.tank.input = { dx: msg.dx || 0, firing: !!msg.firing };
      } else if (msg.type === 'jump') {
        jumpTank(room, slot);
      } else if (msg.type === 'ability') {
        useAbility(room, slot);
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
