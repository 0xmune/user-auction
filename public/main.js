const socket = io();

let myRole = null; // host | leader | spectator
let myTeamId = null;
let roomCode = null;
let latestState = null;
let timerInterval = null;

const $ = (id) => document.getElementById(id);

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`view-${name}`).classList.remove('hidden');
}

// ---------- NAVIGATION ----------
$('gotoCreateBtn').onclick = () => showView('create');
$('gotoJoinBtn').onclick = () => showView('join-choice');
$('gotoLeaderJoinBtn').onclick = () => showView('leader-join');
$('gotoSpectatorJoinBtn').onclick = () => showView('spectator-join');
document.querySelectorAll('.back-btn').forEach((btn) => {
  btn.onclick = () => showView(btn.dataset.back);
});

// ---------- HOME: team rows ----------
let teamCount = 2;
function renderTeamRows() {
  const container = $('teamRows');
  container.innerHTML = '';
  for (let i = 0; i < teamCount; i++) {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.innerHTML = `
      <input type="text" placeholder="팀 이름 ${i + 1}" data-role="teamName" />
      <input type="text" placeholder="팀장 닉네임 ${i + 1}" data-role="leaderNick" />
      <input type="number" placeholder="포인트" value="1000" min="0" data-role="teamPoints" />
    `;
    container.appendChild(row);
  }
}
renderTeamRows();

$('addTeamBtn').onclick = () => {
  if (teamCount >= 8) return;
  teamCount++;
  renderTeamRows();
};
$('removeTeamBtn').onclick = () => {
  if (teamCount <= 2) return;
  teamCount--;
  renderTeamRows();
};

// ---------- MODE TOGGLE ----------
let selectedMode = 'open';
document.querySelectorAll('#modeToggle .mode-option').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('#modeToggle .mode-option').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedMode = btn.dataset.mode;
  };
});

// ---------- CREATE ROOM: 경매 목록 미리 구성 (방 생성 전, 클라이언트 로컬 초안) ----------
let draftPool = [];

function renderDraftPoolList() {
  const ul = $('draftPoolList');
  ul.innerHTML = '';
  draftPool.forEach((p, i) => {
    const li = document.createElement('li');
    const meta = playerMetaText(p);
    li.innerHTML = `<span>${escapeHtml(p.name)}${meta ? ` <span class="meta-inline">${escapeHtml(meta)}</span>` : ''}</span>`;
    const btn = document.createElement('button');
    btn.textContent = '삭제';
    btn.onclick = () => {
      draftPool.splice(i, 1);
      renderDraftPoolList();
    };
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

$('draftAddPoolBtn').onclick = () => {
  $('draftAddPoolError').textContent = '';
  const name = $('draftPlayerName').value.trim();
  if (!name) {
    $('draftAddPoolError').textContent = '닉네임을 입력하세요.';
    return;
  }
  draftPool.push({
    name,
    tier: $('draftPlayerTier').value,
    mainPosition: $('draftPlayerMainPos').value,
    subPosition: $('draftPlayerSubPos').value,
    comment: $('draftPlayerComment').value.trim(),
  });
  renderDraftPoolList();
  $('draftPlayerName').value = '';
  $('draftPlayerTier').value = '';
  $('draftPlayerMainPos').value = '';
  $('draftPlayerSubPos').value = '';
  $('draftPlayerComment').value = '';
  $('draftPlayerName').focus();
};

// ---------- CREATE ROOM ----------
$('createRoomBtn').onclick = () => {
  $('createError').textContent = '';
  const poolOrder = $('poolOrder').value;
  const rows = [...document.querySelectorAll('#teamRows .team-row')];
  const teams = rows.map((r) => ({
    name: r.querySelector('[data-role="teamName"]').value.trim(),
    leaderNickname: r.querySelector('[data-role="leaderNick"]').value.trim(),
    points: Number(r.querySelector('[data-role="teamPoints"]').value) || 0,
  }));
  const timerSettings = {
    totalSeconds: Number($('timerTotal').value) || 60,
    antiSnipeThreshold: Number($('timerThreshold').value) || 10,
    antiSnipeReset: Number($('timerReset').value) || 10,
  };
  const maxTeamSize = Number($('maxTeamSize').value) || 5;

  socket.emit(
    'createRoom',
    { teams, poolOrder, timerSettings, mode: selectedMode, maxTeamSize, initialPlayers: draftPool },
    (res) => {
      if (res.error) {
        $('createError').textContent = res.error;
        return;
      }
      myRole = 'host';
      roomCode = res.code;
      latestState = res.room;
      draftPool = [];
      renderDraftPoolList();
      enterRoomUI();
    }
  );
};

// ---------- JOIN ROOM (leader) ----------
$('leaderJoinBtn').onclick = () => {
  $('leaderJoinError').textContent = '';
  const code = $('leaderJoinCode').value.trim();
  const nickname = $('leaderJoinNickname').value.trim();
  socket.emit('joinRoom', { code, nickname, intent: 'leader' }, (res) => {
    if (res.error) {
      $('leaderJoinError').textContent = res.error;
      return;
    }
    myRole = res.role;
    myTeamId = res.teamId || null;
    roomCode = code;
    latestState = res.room;
    enterRoomUI();
  });
};

// ---------- JOIN ROOM (spectator) ----------
$('spectatorJoinBtn').onclick = () => {
  $('spectatorJoinError').textContent = '';
  const code = $('spectatorJoinCode').value.trim();
  const nickname = $('spectatorJoinNickname').value.trim();
  socket.emit('joinRoom', { code, nickname, intent: 'spectator' }, (res) => {
    if (res.error) {
      $('spectatorJoinError').textContent = res.error;
      return;
    }
    myRole = res.role;
    myTeamId = null;
    roomCode = code;
    latestState = res.room;
    enterRoomUI();
  });
};

function enterRoomUI() {
  $('roomBadge').textContent = `방 코드: ${roomCode} (${roleLabel()})`;
  $('roomBadge').classList.remove('hidden');
  render();
}

function roleLabel() {
  if (myRole === 'host') return '방장';
  if (myRole === 'leader') return '팀장';
  return '관전';
}

// ---------- SOCKET STATE ----------
socket.on('state', (state) => {
  if (roomCode && state.code !== roomCode) return;
  latestState = state;
  render();
});

// ---------- POOL MANAGEMENT (host, setup phase) ----------
$('addPoolBtn').onclick = () => {
  $('addPoolError').textContent = '';
  const player = {
    name: $('playerName').value.trim(),
    tier: $('playerTier').value,
    mainPosition: $('playerMainPos').value,
    subPosition: $('playerSubPos').value,
    comment: $('playerComment').value.trim(),
  };
  socket.emit('addPoolPlayer', player, (res) => {
    if (res && res.error) {
      $('addPoolError').textContent = res.error;
      return;
    }
    $('playerName').value = '';
    $('playerTier').value = '';
    $('playerMainPos').value = '';
    $('playerSubPos').value = '';
    $('playerComment').value = '';
    $('playerName').focus();
  });
};

$('startAuctionBtn').onclick = () => {
  socket.emit('startAuction', {}, (res) => {
    if (res && res.error) alert(res.error);
  });
};

// ---------- BIDDING ----------
function submitBid(amount) {
  $('bidError').textContent = '';
  socket.emit('placeBid', { amount }, (res) => {
    if (res && res.error) $('bidError').textContent = res.error;
    else $('bidAmount').value = '';
  });
}

$('placeBidBtn').onclick = () => {
  const amount = Number($('bidAmount').value);
  if (!Number.isFinite(amount) || amount <= 0) {
    $('bidError').textContent = '입찰 금액을 입력하세요.';
    return;
  }
  submitBid(amount);
};

// 직접입력 보조: 입력창 값에 +1/+10/+100을 더하거나 초기화
document.querySelectorAll('#leaderControls .bid-adjust .chip').forEach((btn) => {
  btn.onclick = () => {
    const key = btn.dataset.adjust;
    const cur = latestState && latestState.current ? latestState.current.currentBid : 0;
    if (key === 'reset') {
      $('bidAmount').value = '';
      return;
    }
    const delta = Number(key);
    const base = Number($('bidAmount').value) || cur;
    $('bidAmount').value = base + delta;
  };
});

// 빠른 입찰: 현재 최고 입찰가에 +1/+10/+100 하여 즉시 입찰
document.querySelectorAll('#quickBidRow .chip-quick').forEach((btn) => {
  btn.onclick = () => {
    const cur = latestState && latestState.current ? latestState.current.currentBid : 0;
    const delta = Number(btn.dataset.quick);
    submitBid(cur + delta);
  };
});

$('nextPlayerBtn').onclick = () => socket.emit('nextPlayer', {});

// ---------- RENDER ----------
function render() {
  if (!latestState) return;
  const s = latestState;

  if (s.phase === 'setup') {
    showView('setup');
    $('setupRoomCode').textContent = `#${s.code}`;
    renderPoolList(s);
    renderTeams($('setupTeams'), s, null);
    $('startAuctionBtn').style.display = myRole === 'host' ? 'block' : 'none';
    document.querySelector('.player-form').style.display = myRole === 'host' ? 'block' : 'none';
  } else if (s.phase === 'bidding') {
    showView('auction');
    renderAuction(s);
  } else if (s.phase === 'finished') {
    showView('finished');
    renderTeams($('finalTeams'), s, null);
  }
}

function playerMetaText(p) {
  const parts = [];
  if (p.tier) parts.push(p.tier);
  const pos = [p.mainPosition, p.subPosition].filter(Boolean).join('/');
  if (pos) parts.push(pos);
  if (p.comment) parts.push(`"${p.comment}"`);
  return parts.join(' · ');
}

function renderPoolList(s) {
  const ul = $('poolList');
  ul.innerHTML = '';
  s.pool.forEach((p) => {
    const li = document.createElement('li');
    if (p.name === null) {
      li.textContent = '🔒 비공개 (블라인드)';
      li.classList.add('blind-hidden');
    } else {
      const meta = playerMetaText(p);
      li.innerHTML = `<span>${escapeHtml(p.name)}${meta ? ` <span class="meta-inline">${escapeHtml(meta)}</span>` : ''}</span>`;
    }
    if (myRole === 'host') {
      const btn = document.createElement('button');
      btn.textContent = '삭제';
      btn.onclick = () => socket.emit('removePoolPlayer', { id: p.id });
      li.appendChild(btn);
    }
    ul.appendChild(li);
  });
}

function renderTeams(container, s, leadingTeamId) {
  container.innerHTML = '';
  s.teams.forEach((t) => {
    const div = document.createElement('div');
    div.className = 'team-card' + (t.id === leadingTeamId ? ' leading' : '');
    div.style.borderTopColor = t.color;
    if (t.id === leadingTeamId) {
      div.style.boxShadow = `0 0 0 1px ${t.color}, 0 0 16px ${t.color}66`;
      div.style.borderColor = t.color;
    }
    const membersHtml = t.members
      .map((m) => {
        const pos = [m.mainPosition, m.subPosition].filter(Boolean).join('/');
        const label = [m.tier, pos].filter(Boolean).join(' ');
        return `<li><span>${escapeHtml(m.name)}${label ? ` <span class="meta-inline">${escapeHtml(label)}</span>` : ''}</span><span>${m.price}P</span></li>`;
      })
      .join('');
    const roster = s.maxTeamSize ? `${t.members.length}/${s.maxTeamSize}` : `${t.members.length}`;
    div.innerHTML = `
      <h3 style="color:${t.color}">${escapeHtml(t.name)}</h3>
      <div class="leader">팀장: ${escapeHtml(t.leaderNickname)} ${t.leaderConnected ? '🟢' : '⚪'}</div>
      <div class="points">${t.remainingPoints} / ${t.points} P <span class="roster-count">${roster}명</span></div>
      <ul>${membersHtml}</ul>
    `;
    container.appendChild(div);
  });
}

function renderAuction(s) {
  const total = s.order.length;
  const idx = s.auctionIndex + 1;
  $('progressLabel').textContent = total ? `${idx} / ${total}` : '';

  const cur = s.current;
  $('currentPlayerName').textContent = cur ? cur.player.name : '- 대기중 -';
  $('currentPlayerMeta').textContent = cur ? playerMetaText(cur.player) : '';
  $('currentBid').textContent = cur ? cur.currentBid : 0;
  $('currentTeam').textContent = cur && cur.currentTeamName ? cur.currentTeamName : '-';

  const leadColor = cur && cur.currentTeamColor ? cur.currentTeamColor : null;
  $('currentBid').style.color = leadColor || '';
  $('currentTeam').style.color = leadColor || '';

  // 빠른 입찰 버튼은 이미 입찰이 존재할 때만 노출
  $('quickBidRow').classList.toggle('hidden', !(cur && cur.currentBid > 0));

  renderTeams($('auctionTeams'), s, cur ? cur.currentTeamId : null);
  renderQueue(s);

  // timer
  clearInterval(timerInterval);
  if (cur && cur.deadline) {
    updateTimer(cur.deadline, leadColor);
    timerInterval = setInterval(() => updateTimer(cur.deadline, leadColor), 250);
  } else {
    $('timer').textContent = '--:--';
    $('timer').classList.remove('timer-warn');
  }

  // controls visibility
  $('leaderControls').classList.toggle('hidden', myRole !== 'leader' || !cur);
  $('hostControls').classList.toggle('hidden', myRole !== 'host' || !cur);

  if (myRole === 'leader') {
    const myTeam = s.teams.find((t) => t.id === myTeamId);
    if (myTeam) $('myPoints').textContent = myTeam.remainingPoints;
  }
}

function updateTimer(deadline, leadColor) {
  const remainingMs = Math.max(0, deadline - Date.now());
  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const ss = (totalSec % 60).toString().padStart(2, '0');
  const timerEl = $('timer');
  timerEl.textContent = `${mm}:${ss}`;

  const threshold = latestState && latestState.timer ? latestState.timer.antiSnipeThreshold : 10;
  const warn = totalSec <= threshold;
  timerEl.classList.toggle('timer-warn', warn);

  if (warn) {
    timerEl.style.color = '';
    timerEl.style.borderColor = '';
  } else if (leadColor) {
    timerEl.style.color = leadColor;
    timerEl.style.borderColor = leadColor;
  } else {
    timerEl.style.color = '';
    timerEl.style.borderColor = '';
  }
}

function renderQueue(s) {
  const ul = $('poolQueue');
  ul.innerHTML = '';
  s.order.forEach((id) => {
    const p = s.pool.find((pp) => pp.id === id);
    if (!p) return;
    const li = document.createElement('li');
    li.className = p.status;
    let label = p.name === null ? '🔒 비공개' : p.name;
    if (p.name === null) li.classList.add('blind-hidden');
    else {
      const meta = playerMetaText(p);
      if (meta) label += ` (${meta})`;
    }
    if (p.status === 'sold') label += ` → ${p.soldTo || ''} (${p.price}P)`;
    if (p.status === 'unsold') label += ' (유찰)';
    if (p.status === 'active') label += ' (경매중)';
    li.textContent = label;
    ul.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
