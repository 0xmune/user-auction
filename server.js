const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MIN_TEAMS = 2;
const MAX_TEAMS = 8;
const DEFAULT_MAX_TEAM_SIZE = 5;

const TEAM_COLORS = [
  '#5b8cff', '#e84057', '#0ac8b9', '#ffd166',
  '#c77dff', '#ff8c42', '#4fd18b', '#ff6ec7',
];

const DEFAULT_TIMER = {
  totalSeconds: 30, // 아이템당 기본 제한시간
  antiSnipeThreshold: 5, // 이 시간(초) 미만에서 상위 입찰이 들어오면
  antiSnipeReset: 5, // 남은 시간을 이 값(초)으로 재설정
};

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTimerSettings(input) {
  const src = input || {};
  return {
    totalSeconds: clampInt(src.totalSeconds, 5, 600, DEFAULT_TIMER.totalSeconds),
    antiSnipeThreshold: clampInt(src.antiSnipeThreshold, 0, 300, DEFAULT_TIMER.antiSnipeThreshold),
    antiSnipeReset: clampInt(src.antiSnipeReset, 1, 300, DEFAULT_TIMER.antiSnipeReset),
  };
}

/** @type {Map<string, Room>} */
const rooms = new Map();

function genRoomCode() {
  let code;
  do {
    code = crypto.randomInt(100000, 999999).toString();
  } while (rooms.has(code));
  return code;
}

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseYoutubeId(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s; // 이미 영상 ID만 준 경우
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const url = new URL(s);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.slice(1).split('/')[0] || null;
    }
    if (url.hostname.includes('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
      if (url.pathname.startsWith('/embed/')) return url.pathname.split('/')[2] || null;
    }
  } catch (e) {
    return null;
  }
  return null;
}

function normalizePlayer(p) {
  const name = ((p && p.name) || '').trim();
  if (!name) return null;
  return {
    id: genId(),
    name,
    tier: ((p && p.tier) || '').trim(),
    mainPosition: ((p && p.mainPosition) || '').trim(),
    subPosition: ((p && p.subPosition) || '').trim(),
    comment: ((p && p.comment) || '').trim(),
    status: 'pending',
  };
}

function createRoom({ teams, poolOrder, timerSettings, mode, maxTeamSize, initialPlayers, bgmUrl }) {
  const code = genRoomCode();
  const room = {
    code,
    hostSocketId: null,
    poolOrder: poolOrder === 'random' ? 'random' : 'input',
    mode: mode === 'blind' ? 'blind' : 'open', // open: 목록 순서 공개 / blind: 목록 순서 비공개
    maxTeamSize: clampInt(maxTeamSize, 1, 20, DEFAULT_MAX_TEAM_SIZE),
    timer: normalizeTimerSettings(timerSettings),
    teams: teams.map((t, i) => ({
      id: genId(),
      name: t.name,
      leaderNickname: t.leaderNickname,
      leaderSocketId: null,
      color: TEAM_COLORS[i % TEAM_COLORS.length],
      points: Number(t.points) || 0,
      remainingPoints: Number(t.points) || 0,
      members: [], // {name, price}
    })),
    pool: Array.isArray(initialPlayers) ? initialPlayers.map(normalizePlayer).filter(Boolean) : [],
    order: [], // array of pool ids in auction order
    auctionIndex: -1,
    current: null, // {playerId, currentBid, currentTeamId, deadline, timeoutHandle}
    phase: 'setup', // setup | bidding | finished
    spectators: new Map(), // socketId -> nickname
    bgm: {
      playlist: [], // {id, videoId, title}
      currentTrackId: null,
      isPlaying: false,
      position: 0, // 마지막으로 기록된 재생 위치(초)
      updatedAt: Date.now(), // position이 기록된 시각
    },
  };

  const initialVideoId = parseYoutubeId(bgmUrl);
  if (initialVideoId) {
    const track = { id: genId(), videoId: initialVideoId, title: initialVideoId };
    room.bgm.playlist.push(track);
    room.bgm.currentTrackId = track.id;
    room.bgm.isPlaying = true;
    room.bgm.updatedAt = Date.now();
  }

  rooms.set(code, room);
  return room;
}

function roomPublicState(room, viewerRole) {
  const hidden = room.mode === 'blind' && viewerRole !== 'host';
  return {
    code: room.code,
    poolOrder: room.poolOrder,
    mode: room.mode,
    maxTeamSize: room.maxTeamSize,
    timer: room.timer,
    phase: room.phase,
    teams: room.teams.map((t) => ({
      id: t.id,
      name: t.name,
      leaderNickname: t.leaderNickname,
      leaderConnected: !!t.leaderSocketId,
      color: t.color,
      points: t.points,
      remainingPoints: t.remainingPoints,
      members: t.members,
    })),
    pool: room.pool.map((p) => {
      const conceal = hidden && p.status === 'pending';
      return {
        id: p.id,
        name: conceal ? null : p.name,
        tier: conceal ? null : p.tier,
        mainPosition: conceal ? null : p.mainPosition,
        subPosition: conceal ? null : p.subPosition,
        comment: conceal ? null : p.comment,
        status: p.status,
        soldTo: p.soldTo,
        price: p.price,
      };
    }),
    // 경매 목록(누가 있는지)은 블라인드 모드에서도 항상 공개. 숨겨지는 건 "순서"뿐이라
    // 뽑히는 차례를 유추할 수 없도록 이름순으로 정렬해서 내려준다.
    roster: room.pool
      .map((p) => ({
        id: p.id,
        name: p.name,
        tier: p.tier,
        mainPosition: p.mainPosition,
        subPosition: p.subPosition,
        comment: p.comment,
        status: p.status,
        soldTo: p.soldTo,
        price: p.price,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    order: room.order,
    auctionIndex: room.auctionIndex,
    current: room.current
      ? {
          player: room.pool.find((p) => p.id === room.current.playerId),
          currentBid: room.current.currentBid,
          currentTeamId: room.current.currentTeamId,
          currentTeamName: room.current.currentTeamId
            ? room.teams.find((t) => t.id === room.current.currentTeamId)?.name
            : null,
          currentTeamColor: room.current.currentTeamId
            ? room.teams.find((t) => t.id === room.current.currentTeamId)?.color
            : null,
          deadline: room.current.deadline,
          foldedTeamIds: room.current.foldedTeamIds,
        }
      : null,
    spectatorCount: room.spectators.size,
    bgm: room.bgm,
  };
}

function broadcast(room) {
  const socketsInRoom = io.sockets.adapter.rooms.get(room.code);
  if (!socketsInRoom) return;
  for (const socketId of socketsInRoom) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) continue;
    s.emit('state', roomPublicState(room, s.data.role));
  }
}

function findTeamBySocket(room, socketId) {
  return room.teams.find((t) => t.leaderSocketId === socketId);
}

function clearTimer(room) {
  if (room.current && room.current.timeoutHandle) {
    clearTimeout(room.current.timeoutHandle);
    room.current.timeoutHandle = null;
  }
}

function startTimer(room) {
  clearTimer(room);
  const ms = room.timer.totalSeconds * 1000;
  room.current.deadline = Date.now() + ms;
  room.current.timeoutHandle = setTimeout(() => finalizeCurrent(room), ms);
}

// 상위 입찰 발생 시: 남은 시간이 anti-snipe 기준보다 짧으면 남은 시간을 리셋값으로 재설정.
// 그렇지 않으면 타이머는 그대로 흘러간다 (매 입찰마다 처음부터 다시 시작하지 않음).
function onNewBid(room) {
  const remainingMs = room.current.deadline - Date.now();
  const thresholdMs = room.timer.antiSnipeThreshold * 1000;
  if (remainingMs < thresholdMs) {
    clearTimer(room);
    const resetMs = room.timer.antiSnipeReset * 1000;
    room.current.deadline = Date.now() + resetMs;
    room.current.timeoutHandle = setTimeout(() => finalizeCurrent(room), resetMs);
  }
}

function finalizeCurrent(room) {
  if (!room.current) return;
  clearTimer(room);
  const player = room.pool.find((p) => p.id === room.current.playerId);
  if (!player) return;

  if (room.current.currentTeamId) {
    const team = room.teams.find((t) => t.id === room.current.currentTeamId);
    team.remainingPoints -= room.current.currentBid;
    team.members.push({
      name: player.name,
      price: room.current.currentBid,
      tier: player.tier,
      mainPosition: player.mainPosition,
      subPosition: player.subPosition,
    });
    player.status = 'sold';
    player.soldTo = team.name;
    player.price = room.current.currentBid;
  } else {
    player.status = 'unsold';
  }
  room.current = null;
  broadcast(room);
}

function advanceToNext(room, autoStart) {
  room.auctionIndex += 1;
  if (room.auctionIndex >= room.order.length) {
    room.phase = 'finished';
    room.current = null;
    broadcast(room);
    return;
  }
  const playerId = room.order[room.auctionIndex];
  const player = room.pool.find((p) => p.id === playerId);
  player.status = 'active';
  room.current = {
    playerId,
    currentBid: 0,
    currentTeamId: null,
    deadline: null,
    timeoutHandle: null,
    foldedTeamIds: [],
  };
  if (autoStart) startTimer(room);
  broadcast(room);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ teams, poolOrder, timerSettings, mode, maxTeamSize, initialPlayers, bgmUrl }, cb) => {
    try {
      if (!Array.isArray(teams) || teams.length < MIN_TEAMS || teams.length > MAX_TEAMS) {
        return cb({ error: `팀은 ${MIN_TEAMS}~${MAX_TEAMS}개 사이여야 합니다.` });
      }
      for (const t of teams) {
        if (!t.name || !t.leaderNickname) return cb({ error: '팀 이름과 팀장 닉네임을 모두 입력하세요.' });
      }
      const room = createRoom({ teams, poolOrder, timerSettings, mode, maxTeamSize, initialPlayers, bgmUrl });
      room.hostSocketId = socket.id;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.role = 'host';
      cb({ room: roomPublicState(room, 'host'), role: 'host', code: room.code });
    } catch (e) {
      cb({ error: '방 생성 중 오류가 발생했습니다.' });
    }
  });

  socket.on('joinRoom', ({ code, nickname, intent }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: '존재하지 않는 방 코드입니다.' });

    const trimmed = (nickname || '').trim();

    if (intent === 'leader') {
      if (!trimmed) return cb({ error: '팀장 닉네임을 입력하세요.' });
      const team = room.teams.find((t) => t.leaderNickname === trimmed);
      if (!team) return cb({ error: '등록된 팀장 닉네임과 일치하지 않습니다.' });
      socket.join(room.code);
      socket.data.roomCode = room.code;
      team.leaderSocketId = socket.id;
      socket.data.role = 'leader';
      socket.data.teamId = team.id;
      cb({ room: roomPublicState(room, 'leader'), role: 'leader', teamId: team.id });
    } else {
      const name = trimmed || `관전자${Math.floor(1000 + Math.random() * 9000)}`;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      room.spectators.set(socket.id, name);
      socket.data.role = 'spectator';
      cb({ room: roomPublicState(room, 'spectator'), role: 'spectator' });
    }
    broadcast(room);
  });

  socket.on('addPoolPlayer', (playerInput, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    const player = normalizePlayer(playerInput);
    if (!player) return cb && cb({ error: '닉네임을 입력하세요.' });
    room.pool.push(player);
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('removePoolPlayer', ({ id }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.phase !== 'setup') return;
    room.pool = room.pool.filter((p) => p.id !== id);
    broadcast(room);
  });

  socket.on('startAuction', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    if (room.pool.length === 0) return cb && cb({ error: '경매 목록이 비어있습니다.' });
    const ids = room.pool.map((p) => p.id);
    room.order = room.poolOrder === 'random' ? shuffle(ids) : ids;
    room.auctionIndex = -1;
    room.phase = 'bidding';
    advanceToNext(room, true);
    cb && cb({ ok: true });
  });

  socket.on('placeBid', ({ amount }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.current) return cb && cb({ error: '진행중인 경매가 없습니다.' });
    const team = findTeamBySocket(room, socket.id);
    if (!team) return cb && cb({ error: '팀장만 입찰할 수 있습니다.' });
    if (room.current.foldedTeamIds.includes(team.id)) {
      return cb && cb({ error: '이번 선수는 입찰을 포기했습니다.' });
    }
    const bid = Number(amount);
    if (!Number.isFinite(bid) || bid <= room.current.currentBid) {
      return cb && cb({ error: '현재 입찰가보다 높은 금액을 입력하세요.' });
    }
    if (bid > team.remainingPoints) {
      return cb && cb({ error: '보유 포인트를 초과했습니다.' });
    }
    if (team.members.length >= room.maxTeamSize) {
      return cb && cb({ error: `이미 최대 인원(${room.maxTeamSize}명)에 도달했습니다.` });
    }
    if (room.current.currentTeamId === team.id) {
      return cb && cb({ error: '이미 최고 입찰자입니다.' });
    }
    room.current.currentBid = bid;
    room.current.currentTeamId = team.id;
    onNewBid(room);
    broadcast(room);
    cb && cb({ ok: true });
  });

  // 상위 입찰자가 아닌 팀장이 이번 선수에 대해 입찰을 포기 (포커의 '다이'처럼 이번 판만 이탈)
  socket.on('foldBid', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.current) return cb && cb({ error: '진행중인 경매가 없습니다.' });
    const team = findTeamBySocket(room, socket.id);
    if (!team) return cb && cb({ error: '팀장만 포기할 수 있습니다.' });
    if (room.current.currentTeamId === team.id) {
      return cb && cb({ error: '현재 최고 입찰자는 포기할 수 없습니다.' });
    }
    if (!room.current.foldedTeamIds.includes(team.id)) {
      room.current.foldedTeamIds.push(team.id);
    }
    broadcast(room);
    cb && cb({ ok: true });
  });

  // 입찰 액션 사운드 큐(체크/쿼터/하프/다이)를 방 전체에 방송 (게임 상태는 변경하지 않음)
  socket.on('voiceCue', ({ action }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ error: '방을 찾을 수 없습니다.' });
    const team = findTeamBySocket(room, socket.id);
    if (!team) return cb && cb({ error: '팀장만 가능합니다.' });
    if (!['check', 'quarter', 'harp', 'die'].includes(action)) {
      return cb && cb({ error: '잘못된 액션입니다.' });
    }
    io.to(room.code).emit('voiceCue', { teamId: team.id, action });
    cb && cb({ ok: true });
  });

  socket.on('nextPlayer', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    if (room.current) finalizeCurrent(room);
    advanceToNext(room, true);
    cb && cb({ ok: true });
  });

  // 유찰된 선수들만 모아 다시 경매 진행 (전체 순서를 다 돌고 난 뒤에도 호출 가능)
  socket.on('requeueUnsold', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    const unsold = room.pool.filter((p) => p.status === 'unsold');
    if (unsold.length === 0) return cb && cb({ error: '유찰된 선수가 없습니다.' });
    unsold.forEach((p) => {
      p.status = 'pending';
    });
    const ids = unsold.map((p) => p.id);
    room.order = room.poolOrder === 'random' ? shuffle(ids) : ids;
    room.auctionIndex = -1;
    room.phase = 'bidding';
    advanceToNext(room, true);
    cb && cb({ ok: true });
  });

  // ---- BGM (YouTube 재생목록, 방장만 제어) ----
  socket.on('bgmAddTrack', ({ url, title }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    const videoId = parseYoutubeId(url);
    if (!videoId) return cb && cb({ error: '유효한 유튜브 링크(또는 영상 ID)가 아닙니다.' });
    room.bgm.playlist.push({ id: genId(), videoId, title: (title || '').trim() || videoId });
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('bgmRemoveTrack', ({ id }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    room.bgm.playlist = room.bgm.playlist.filter((t) => t.id !== id);
    if (room.bgm.currentTrackId === id) {
      room.bgm.currentTrackId = null;
      room.bgm.isPlaying = false;
      room.bgm.position = 0;
      room.bgm.updatedAt = Date.now();
    }
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('bgmSelect', ({ id }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    const track = room.bgm.playlist.find((t) => t.id === id);
    if (!track) return cb && cb({ error: '존재하지 않는 트랙입니다.' });
    room.bgm.currentTrackId = id;
    room.bgm.isPlaying = true;
    room.bgm.position = 0;
    room.bgm.updatedAt = Date.now();
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('bgmPlayPause', ({ isPlaying }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostSocketId) return cb && cb({ error: '권한이 없습니다.' });
    if (!room.bgm.currentTrackId) return cb && cb({ error: '선택된 트랙이 없습니다.' });
    if (room.bgm.isPlaying && !isPlaying) {
      room.bgm.position += (Date.now() - room.bgm.updatedAt) / 1000;
    }
    room.bgm.isPlaying = !!isPlaying;
    room.bgm.updatedAt = Date.now();
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostSocketId === socket.id) room.hostSocketId = null;
    const team = findTeamBySocket(room, socket.id);
    if (team) team.leaderSocketId = null;
    if (room.spectators.has(socket.id)) room.spectators.delete(socket.id);
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행중: http://localhost:${PORT}`));
