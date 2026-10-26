const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const ASSETS = {
  tech: { name: "AI·반도체", icon: "🤖" },
  energy: { name: "전기·에너지", icon: "⚡" },
  mobility: { name: "자동차·모빌리티", icon: "🚗" },
  health: { name: "바이오·헬스", icon: "🧬" },
  green: { name: "친환경 산업", icon: "🌱" },
  index: { name: "시장 지수", icon: "📈" }
};

const EVENTS = [
  { title: "AI 수요 급증", description: "기업들의 AI 투자가 예상보다 크게 늘었습니다.", effects: { tech: 18, energy: 8, mobility: 2, health: 3, green: 1, index: 5 } },
  { title: "전력망 투자 확대", description: "데이터센터 전력 수요로 전력 인프라 투자가 늘었습니다.", effects: { tech: 4, energy: 17, mobility: 2, health: 1, green: 8, index: 5 } },
  { title: "원자재 가격 급등", description: "원자재 가격 상승으로 제조 비용 부담이 커졌습니다.", effects: { tech: -5, energy: 3, mobility: -12, health: -4, green: -3, index: -6 } },
  { title: "친환경 정책 발표", description: "정부가 친환경 설비와 에너지 전환 지원을 발표했습니다.", effects: { tech: 2, energy: 7, mobility: 8, health: 1, green: 18, index: 5 } },
  { title: "신약 개발 성과", description: "주요 바이오 기업의 임상시험 성과가 발표됐습니다.", effects: { tech: 3, energy: 0, mobility: 0, health: 19, green: 1, index: 4 } },
  { title: "금리 상승 우려", description: "금리 상승 전망에 투자 심리가 위축됐습니다.", effects: { tech: -12, energy: -6, mobility: -7, health: -8, green: -5, index: -10 } },
  { title: "전기차 판매 호조", description: "전기차 판매가 시장 예상치를 웃돌았습니다.", effects: { tech: 4, energy: 6, mobility: 17, health: 0, green: 9, index: 5 } },
  { title: "시장 안정세", description: "불확실성이 줄며 대부분 업종이 완만하게 상승했습니다.", effects: { tech: 5, energy: 4, mobility: 4, health: 4, green: 5, index: 4 } },
  { title: "공급망 차질", description: "부품 공급이 늦어져 생산과 배송에 차질이 생겼습니다.", effects: { tech: -8, energy: -3, mobility: -14, health: -5, green: -4, index: -7 } },
  { title: "배터리 기술 혁신", description: "차세대 배터리의 성능 개선 소식이 전해졌습니다.", effects: { tech: 8, energy: 12, mobility: 14, health: 0, green: 11, index: 7 } },
  { title: "소비 심리 둔화", description: "가계 소비가 줄며 경기 둔화 우려가 커졌습니다.", effects: { tech: -5, energy: -3, mobility: -9, health: -2, green: -4, index: -7 } },
  { title: "시장 기대 이상", description: "여러 산업의 실적이 기대치를 웃돌았습니다.", effects: { tech: 9, energy: 7, mobility: 6, health: 8, green: 6, index: 9 } }
];

function code() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function safeName(value) {
  return String(value || "플레이어").trim().replace(/[<>]/g, "").slice(0, 16) || "플레이어";
}
function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, started: room.started, round: room.round,
    maxRounds: room.maxRounds, phase: room.phase,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, balance: p.balance, totalInvested: p.totalInvested,
      portfolioValue: p.portfolioValue, netWorth: p.balance + p.portfolioValue,
      lastChange: p.lastChange, lastReturn: p.lastReturn, ready: p.ready,
      investment: p.investment ? { asset: p.investment.asset, amount: p.investment.amount } : null,
      hintsBought: p.hintsBought
    })),
    lastEvent: room.lastEvent ? { title: room.lastEvent.title, description: room.lastEvent.description, effects: room.lastEvent.effects } : null,
    history: room.history
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function fail(socket, message) { socket.emit("app:error", message); }
function pickNextEvent(room) {
  let choices = EVENTS.filter(e => !room.usedEvents.includes(e.title));
  if (!choices.length) { room.usedEvents = []; choices = EVENTS.slice(); }
  const e = choices[Math.floor(Math.random() * choices.length)];
  room.usedEvents.push(e.title);
  return e;
}
function roomFor(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function playerFor(socket, room) {
  return room && room.players.get(socket.id);
}
function sendHint(socket, room, tier) {
  const player = playerFor(socket, room);
  if (!player || !room.started || room.phase !== "invest") return fail(socket, "힌트는 투자 단계에서만 살 수 있어요.");
  const cost = tier === "cheap" ? 50 : 200;
  if (player.balance < cost) return fail(socket, "힌트를 살 잔액이 부족해요.");
  player.balance -= cost;
  player.hintsBought += 1;
  const event = room.nextEvent;
  if (tier === "cheap") {
    const positive = Object.entries(event.effects).filter(([,v]) => v >= 8).map(([k]) => ASSETS[k].name);
    const negative = Object.entries(event.effects).filter(([,v]) => v <= -8).map(([k]) => ASSETS[k].name);
    socket.emit("hint:result", {
      tier, cost,
      text: positive.length || negative.length
        ? `다음 사건에서 크게 움직일 가능성이 있는 분야: ${[...positive, ...negative].join(", ")}. 방향은 공개되지 않아요.`
        : "다음 사건은 특정 분야에 큰 영향을 주지 않을 가능성이 있어요. 방향은 공개되지 않아요."
    });
  } else {
    const ranked = Object.entries(event.effects).sort((a,b) => b[1]-a[1]);
    socket.emit("hint:result", {
      tier, cost,
      text: `다음 사건 예고: ${event.title}. 예상 효과: ${ranked.map(([k,v]) => `${ASSETS[k].name} ${v > 0 ? "+" : ""}${v}%`).join(" · ")}`
    });
  }
  emitRoom(room);
}
io.on("connection", socket => {
  socket.on("room:create", ({ name } = {}) => {
    let roomCode;
    do { roomCode = code(); } while (rooms.has(roomCode));
    const player = { id: socket.id, name: safeName(name), balance: 10000, totalInvested: 0, portfolioValue: 0, lastChange: 0, lastReturn: 0, ready: false, investment: null, hintsBought: 0 };
    const room = { code: roomCode, hostId: socket.id, players: new Map([[socket.id, player]]), started: false, round: 0, maxRounds: 5, phase: "lobby", nextEvent: null, lastEvent: null, usedEvents: [], history: [] };
    rooms.set(roomCode, room);
    socket.join(roomCode); socket.data.roomCode = roomCode;
    socket.emit("room:joined", { code: roomCode, host: true });
    emitRoom(room);
  });
  socket.on("room:join", ({ code: rawCode, name } = {}) => {
    const roomCode = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return fail(socket, "방을 찾을 수 없어요. 방 코드를 확인해 주세요.");
    if (room.started && room.phase === "finished") return fail(socket, "이미 종료된 방이에요.");
    if (room.players.size >= 12) return fail(socket, "한 방에는 최대 12명까지 참가할 수 있어요.");
    const player = { id: socket.id, name: safeName(name), balance: 10000, totalInvested: 0, portfolioValue: 0, lastChange: 0, lastReturn: 0, ready: false, investment: null, hintsBought: 0 };
    room.players.set(socket.id, player);
    socket.join(roomCode); socket.data.roomCode = roomCode;
    socket.emit("room:joined", { code: roomCode, host: room.hostId === socket.id });
    emitRoom(room);
  });
  socket.on("game:start", () => {
    const room = roomFor(socket);
    if (!room || room.hostId !== socket.id) return fail(socket, "방장만 게임을 시작할 수 있어요.");
    if (room.started) return;
    if (room.players.size < 1) return fail(socket, "참가자가 없어요.");
    room.started = true; room.round = 1; room.phase = "invest"; room.nextEvent = pickNextEvent(room);
    for (const p of room.players.values()) { p.investment = null; p.ready = false; }
    emitRoom(room);
  });
  socket.on("investment:submit", ({ asset, amount } = {}) => {
    const room = roomFor(socket), player = playerFor(socket, room);
    if (!room || !player || room.phase !== "invest") return fail(socket, "지금은 투자할 수 없어요.");
    if (!Object.prototype.hasOwnProperty.call(ASSETS, asset)) return fail(socket, "투자 분야를 선택해 주세요.");
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n < 100 || n > player.balance) return fail(socket, "투자 금액은 100원 이상, 보유 잔액 이하로 입력해 주세요.");
    if (player.investment) player.balance += player.investment.amount;
    player.balance -= n;
    player.investment = { asset, amount: n };
    player.ready = true;
    emitRoom(room);
  });
  socket.on("hint:buy", ({ tier } = {}) => {
    const room = roomFor(socket);
    if (!room) return fail(socket, "먼저 방에 참가해 주세요.");
    if (!["cheap", "expensive"].includes(tier)) return fail(socket, "올바른 힌트를 선택해 주세요.");
    sendHint(socket, room, tier);
  });
  socket.on("round:resolve", () => {
    const room = roomFor(socket);
    if (!room || room.hostId !== socket.id) return fail(socket, "방장만 라운드를 진행할 수 있어요.");
    if (room.phase !== "invest") return fail(socket, "현재 라운드를 정산할 수 없어요.");
    const event = room.nextEvent;
    for (const p of room.players.values()) {
      const inv = p.investment;
      if (inv) {
        const rate = event.effects[inv.asset] || 0;
        const change = Math.round(inv.amount * rate / 100);
        p.balance += inv.amount + change;
        p.totalInvested += inv.amount;
        p.lastChange = change;
        p.lastReturn = rate;
      } else {
        p.lastChange = 0; p.lastReturn = 0;
      }
      p.investment = null; p.ready = false;
    }
    room.lastEvent = event;
    room.history.push({ round: room.round, title: event.title, description: event.description });
    room.phase = room.round >= room.maxRounds ? "finished" : "result";
    room.nextEvent = room.phase === "finished" ? null : pickNextEvent(room);
    emitRoom(room);
  });
  socket.on("round:next", () => {
    const room = roomFor(socket);
    if (!room || room.hostId !== socket.id) return fail(socket, "방장만 다음 라운드를 시작할 수 있어요.");
    if (room.phase !== "result") return fail(socket, "다음 라운드로 넘어갈 수 없어요.");
    room.round += 1; room.phase = "invest";
    for (const p of room.players.values()) { p.investment = null; p.ready = false; p.lastChange = 0; p.lastReturn = 0; }
    emitRoom(room);
  });
  socket.on("disconnect", () => {
    const room = roomFor(socket);
    if (!room) return;
    room.players.delete(socket.id);
    if (!room.players.size) rooms.delete(room.code);
    else {
      if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
      emitRoom(room);
    }
  });
});
server.listen(PORT, "0.0.0.0", () => console.log(`Investment game running on port ${PORT}`));
