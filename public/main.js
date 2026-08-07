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
let selectedMode = 'blind';
document.querySelectorAll('#modeToggle .mode-option').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('#modeToggle .mode-option').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedMode = btn.dataset.mode;
  };
});

// ---------- 스위치형 선택 그룹 (티어/포지션) ----------
function initSwitchGroups() {
  document.querySelectorAll('.switch-group').forEach((group) => {
    group.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        group.dataset.value = btn.dataset.value;
        group.querySelectorAll('button').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      };
    });
  });
}
initSwitchGroups();

function resetSwitchGroup(id) {
  const group = $(id);
  group.dataset.value = '';
  group.querySelectorAll('button').forEach((b, i) => b.classList.toggle('selected', i === 0));
}

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
    tier: $('draftPlayerTier').dataset.value,
    mainPosition: $('draftPlayerMainPos').dataset.value,
    subPosition: $('draftPlayerSubPos').dataset.value,
    comment: $('draftPlayerComment').value.trim(),
  });
  renderDraftPoolList();
  $('draftPlayerName').value = '';
  resetSwitchGroup('draftPlayerTier');
  resetSwitchGroup('draftPlayerMainPos');
  resetSwitchGroup('draftPlayerSubPos');
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
  const bgmUrl = $('createBgmUrl').value.trim();

  armAutoplayGesture();
  socket.emit(
    'createRoom',
    { teams, poolOrder, timerSettings, mode: selectedMode, maxTeamSize, initialPlayers: draftPool, bgmUrl },
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
  armAutoplayGesture();
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
  armAutoplayGesture();
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
  $('bgmBar').classList.remove('hidden');
  $('bgmHostPlayPause').classList.toggle('hidden', myRole !== 'host');
  $('bgmToggleHostPanel').classList.toggle('hidden', myRole !== 'host');
  if (myRole !== 'host') $('bgmHostPanel').classList.add('hidden');
  render();
  applyBgmState(latestState && latestState.bgm);
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
  applyBgmState(state.bgm);
});

// 팀별 보이스 큐 (1번팀 다인 / 2번팀 민상 / 3번팀 아라 / 4번팀 하준, 5번째 팀부터는 합성음으로 대체)
const TEAM_VOICES = ['dain', 'minsang', 'ara', 'hajun'];
socket.on('voiceCue', ({ teamId, action }) => {
  // 직접입력 입찰의 공통 알림음은 팀 구분 없이 항상 합성 띵 사운드
  if (action === 'ding') {
    playDing();
    return;
  }
  const idx = latestState ? latestState.teams.findIndex((t) => t.id === teamId) : -1;
  const voice = TEAM_VOICES[idx];
  if (voice) {
    const audio = new Audio(`audio/${voice}-${action}.mp3`);
    audio.play().catch(() => {});
  } else {
    const fallback = { check: playCheckSound, quarter: playDdadangSound, harp: playHalfSound, die: playDieSound };
    (fallback[action] || (() => {}))();
  }
});

// ---------- POOL MANAGEMENT (host, setup phase) ----------
$('addPoolBtn').onclick = () => {
  $('addPoolError').textContent = '';
  const player = {
    name: $('playerName').value.trim(),
    tier: $('playerTier').dataset.value,
    mainPosition: $('playerMainPos').dataset.value,
    subPosition: $('playerSubPos').dataset.value,
    comment: $('playerComment').value.trim(),
  };
  socket.emit('addPoolPlayer', player, (res) => {
    if (res && res.error) {
      $('addPoolError').textContent = res.error;
      return;
    }
    $('playerName').value = '';
    resetSwitchGroup('playerTier');
    resetSwitchGroup('playerMainPos');
    resetSwitchGroup('playerSubPos');
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
// cueAction 미지정 시 기본 'ding'(직접입력 입찰용 공통 알림음), 빠른입찰은 각 액션명을 넘겨서
// 팀 보이스 사운드만 재생되고 별도 띵 소리가 겹치지 않게 한다.
function submitBid(amount, cueAction) {
  $('bidError').textContent = '';
  socket.emit('placeBid', { amount }, (res) => {
    if (res && res.error) {
      $('bidError').textContent = res.error;
      return;
    }
    $('bidAmount').value = '';
    socket.emit('voiceCue', { action: cueAction || 'ding' }, () => {});
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
// 성공하면 팀별 보이스 큐를 방 전체에 방송해서 다같이 같은 소리를 듣는다
const QUICK_BID_ACTION = { 1: 'check', 10: 'quarter', 100: 'harp' };
document.querySelectorAll('#quickBidRow .chip-quick').forEach((btn) => {
  btn.onclick = () => {
    const cur = latestState && latestState.current ? latestState.current.currentBid : 0;
    const delta = Number(btn.dataset.quick);
    submitBid(cur + delta, QUICK_BID_ACTION[delta]);
  };
});

// 입찰 포기 (최고 입찰자가 아닐 때만 가능, 포커의 '다이' 사운드)
$('foldBidBtn').onclick = () => {
  socket.emit('foldBid', {}, (res) => {
    if (res && res.error) {
      $('bidError').textContent = res.error;
      return;
    }
    socket.emit('voiceCue', { action: 'die' }, () => {});
  });
};

$('nextPlayerBtn').onclick = () => socket.emit('nextPlayer', {});

// ---------- RENDER ----------
function render() {
  if (!latestState) return;
  const s = latestState;

  renderBgmPlaylist(s);

  if (s.phase === 'setup') {
    showView('setup');
    $('setupRoomCode').textContent = `#${s.code}`;
    renderRosterList('poolList', s, { allowDelete: true });
    renderTeams($('setupTeams'), s, null);
    $('startAuctionBtn').style.display = myRole === 'host' ? 'block' : 'none';
    document.querySelector('#view-setup .player-form').style.display = myRole === 'host' ? 'block' : 'none';
  } else if (s.phase === 'bidding') {
    showView('auction');
    renderAuction(s);
  } else if (s.phase === 'finished') {
    showView('finished');
    renderTeams($('finalTeams'), s, null);
    const hasUnsold = s.roster.some((p) => p.status === 'unsold');
    $('requeueUnsoldBtn').classList.toggle('hidden', !(myRole === 'host' && hasUnsold));
  }
}

$('requeueUnsoldBtn').onclick = () => {
  socket.emit('requeueUnsold', {}, (res) => {
    if (res && res.error) alert(res.error);
  });
};

function playerMetaText(p) {
  const parts = [];
  if (p.tier) parts.push(p.tier);
  const pos = [p.mainPosition, p.subPosition].filter(Boolean).join('/');
  if (pos) parts.push(pos);
  if (p.comment) parts.push(`"${p.comment}"`);
  return parts.join(' · ');
}

// 경매 목록(누가 있는지)은 블라인드 모드에서도 항상 전체 공개 (숨겨지는 건 뽑히는 "순서"뿐)
function renderRosterList(ulId, s, { allowDelete } = {}) {
  const ul = $(ulId);
  ul.innerHTML = '';
  s.roster.forEach((p) => {
    const li = document.createElement('li');
    li.className = p.status;
    const meta = playerMetaText(p);
    let label = `${escapeHtml(p.name)}${meta ? ` <span class="meta-inline">${escapeHtml(meta)}</span>` : ''}`;
    if (p.status === 'sold') label += ` <span class="meta-inline">→ ${escapeHtml(p.soldTo || '')} (${p.price}P)</span>`;
    if (p.status === 'unsold') label += ' <span class="meta-inline">(유찰)</span>';
    if (p.status === 'active') label += ' <span class="meta-inline">(경매중)</span>';
    li.innerHTML = `<span>${label}</span>`;
    if (allowDelete && myRole === 'host' && p.status === 'pending') {
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
      div.style.outlineColor = t.color;
      div.style.boxShadow = `0 0 16px ${t.color}66`;
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

  // 현재 진행 카드 테두리도 최고 입찰팀 색상으로 통일
  const currentCard = document.querySelector('.current-card');
  currentCard.style.setProperty('--lead-color', leadColor || 'var(--gold)');
  currentCard.classList.toggle('has-leader', !!leadColor);

  // 빠른 입찰 버튼은 이미 입찰이 존재할 때만 노출
  $('quickBidRow').classList.toggle('hidden', !(cur && cur.currentBid > 0));

  // 입찰 포기: 최고 입찰자가 아니고 아직 포기하지 않은 팀장에게만 노출
  const iAmTopBidder = cur && cur.currentTeamId === myTeamId;
  const iAlreadyFolded = cur && cur.foldedTeamIds && cur.foldedTeamIds.includes(myTeamId);
  $('foldBidBtn').classList.toggle('hidden', myRole !== 'leader' || !cur || iAmTopBidder || iAlreadyFolded);
  $('bidAmount').disabled = !!iAlreadyFolded;
  $('placeBidBtn').disabled = !!iAlreadyFolded;

  renderTeams($('auctionTeams'), s, cur ? cur.currentTeamId : null);
  renderPendingList(s);
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
  // 호스트 컨트롤은 낙찰 직후(cur가 null인 순간)에도 계속 보여야 "다음 선수" 진행이 가능하다
  $('hostControls').classList.toggle('hidden', myRole !== 'host');

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

// 경매 목록: 아직 순서가 안 온(대기중) 선수만 닉네임 텍스트로 표시
function renderPendingList(s) {
  const container = $('rosterListAuction');
  container.innerHTML = '';
  s.roster
    .filter((p) => p.status === 'pending')
    .forEach((p) => {
      const span = document.createElement('span');
      span.className = 'name-plain';
      span.textContent = p.name === null ? '🔒 비공개' : p.name;
      container.appendChild(span);
    });
}

// 경매 순서: 이미 진행된(경매중/낙찰/유찰) 선수만 닉네임 텍스트로, 진행 순서대로 표시
function renderQueue(s) {
  const container = $('poolQueue');
  container.innerHTML = '';
  s.order.forEach((id) => {
    const p = s.pool.find((pp) => pp.id === id);
    if (!p || p.status === 'pending') return;
    const span = document.createElement('span');
    span.className = 'name-plain';
    if (p.status === 'active') span.classList.add('name-active');
    else if (p.status === 'unsold') span.classList.add('name-unsold');
    else span.classList.add('name-sold');
    span.textContent = p.name === null ? '🔒 비공개' : p.name;
    container.appendChild(span);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ================== BGM (YouTube) ==================
let ytPlayer = null;
let ytApiReady = false;
let ytLoadedVideoId = null;
let pendingBgmState = null;
let soundOn = false;
let autoplayGestureArmed = false;

// 방 생성/입장 버튼 클릭 자체가 사용자 제스처이므로, 그 직후 도착하는 BGM 상태는
// 음소거 없이 바로 재생을 시도한다 (브라우저 자동재생 정책 우회).
function armAutoplayGesture() {
  autoplayGestureArmed = true;
  ensureDingAudioCtx();
}

window.onYouTubeIframeAPIReady = () => {
  ytApiReady = true;
  ytPlayer = new YT.Player('ytPlayerContainer', {
    height: '100%',
    width: '100%',
    playerVars: { autoplay: 0, controls: 1, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => {
        ytPlayer.setVolume(Number($('bgmVolume').value));
        ytPlayer.mute();
        if (pendingBgmState) applyBgmState(pendingBgmState);
      },
    },
  });
};

function applyBgmState(bgm) {
  if (!bgm) return;
  if (!ytApiReady || !ytPlayer || typeof ytPlayer.loadVideoById !== 'function') {
    pendingBgmState = bgm;
    return;
  }

  // 자동재생 시도는 입장 직후 첫 상태 수신 시점에 딱 한 번만 소진한다.
  // (그 시점에 곡이 없으면 그냥 소진하고 끝 — 나중에 방장이 곡을 추가/변경해도 다시 켜지지 않음)
  if (autoplayGestureArmed) {
    autoplayGestureArmed = false;
    const track = bgm.playlist.find((t) => t.id === bgm.currentTrackId);
    if (track && bgm.isPlaying) {
      soundOn = true;
      ytPlayer.unMute();
      $('bgmSoundBtn').textContent = '🔊 소리 끄기';
    }
  }

  const track = bgm.playlist.find((t) => t.id === bgm.currentTrackId);
  if (!track) {
    $('bgmNowPlaying').textContent = '선택된 트랙 없음';
    return;
  }
  $('bgmNowPlaying').textContent = (bgm.isPlaying ? '▶ ' : '⏸ ') + track.title;

  const elapsed = bgm.isPlaying ? (Date.now() - bgm.updatedAt) / 1000 : 0;
  const targetPos = Math.max(0, bgm.position + elapsed);

  if (ytLoadedVideoId !== track.videoId) {
    ytLoadedVideoId = track.videoId;
    ytPlayer.loadVideoById({ videoId: track.videoId, startSeconds: targetPos });
    if (!bgm.isPlaying) setTimeout(() => ytPlayer.pauseVideo(), 300);
    return;
  }

  try {
    const drift = Math.abs((ytPlayer.getCurrentTime() || 0) - targetPos);
    if (drift > 2) ytPlayer.seekTo(targetPos, true);
  } catch (e) {}

  if (bgm.isPlaying) ytPlayer.playVideo();
  else ytPlayer.pauseVideo();
}

$('bgmSoundBtn').onclick = () => {
  soundOn = !soundOn;
  if (!ytPlayer) return;
  if (soundOn) {
    ytPlayer.unMute();
    ytPlayer.playVideo();
    $('bgmSoundBtn').textContent = '🔊 소리 끄기';
  } else {
    ytPlayer.mute();
    $('bgmSoundBtn').textContent = '🔇 소리 켜기';
  }
};

$('bgmVolume').oninput = () => {
  if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(Number($('bgmVolume').value));
};

$('bgmToggleHostPanel').onclick = () => {
  $('bgmHostPanel').classList.toggle('hidden');
};

$('bgmAddBtn').onclick = () => {
  $('bgmError').textContent = '';
  const url = $('bgmUrlInput').value.trim();
  const title = $('bgmTitleInput').value.trim();
  socket.emit('bgmAddTrack', { url, title }, (res) => {
    if (res && res.error) {
      $('bgmError').textContent = res.error;
      return;
    }
    $('bgmUrlInput').value = '';
    $('bgmTitleInput').value = '';
  });
};

$('bgmHostPlayPause').onclick = () => {
  const bgm = latestState && latestState.bgm;
  if (!bgm || !bgm.currentTrackId) return;
  socket.emit('bgmPlayPause', { isPlaying: !bgm.isPlaying }, () => {});
};

function renderBgmPlaylist(s) {
  const ul = $('bgmPlaylist');
  if (!s.bgm) return;
  ul.innerHTML = '';
  s.bgm.playlist.forEach((t) => {
    const li = document.createElement('li');
    if (t.id === s.bgm.currentTrackId) li.classList.add('bgm-active');
    li.innerHTML = `<span>${escapeHtml(t.title)}</span>`;
    if (myRole === 'host') {
      const selectBtn = document.createElement('button');
      selectBtn.className = 'bgm-track-select';
      selectBtn.textContent = '재생';
      selectBtn.onclick = () => socket.emit('bgmSelect', { id: t.id }, () => {});
      li.appendChild(selectBtn);

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '삭제';
      removeBtn.onclick = () => socket.emit('bgmRemoveTrack', { id: t.id }, () => {});
      li.appendChild(removeBtn);
    }
    ul.appendChild(li);
  });
}

// ================== 입찰 효과음 (합성 "띵" 소리, 파일 불필요) ==================
let dingAudioCtx = null;
function ensureDingAudioCtx() {
  if (!dingAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    dingAudioCtx = new Ctx();
  }
  if (dingAudioCtx.state === 'suspended') dingAudioCtx.resume();
  return dingAudioCtx;
}
// 페이지 첫 클릭에서 오디오 컨텍스트를 미리 깨워둬야 이후 소켓 이벤트로 인한
// (사용자 제스처 없는) 재생 시도가 브라우저 자동재생 정책에 막히지 않는다.
document.addEventListener('click', () => ensureDingAudioCtx(), { once: true });

function playDing() {
  const ctx = ensureDingAudioCtx();
  const now = ctx.currentTime;
  // 신나는 상승 아르페지오 (C6-E6-G6-C7) + 밝은 트라이앵글 파형
  const notes = [1046.5, 1318.5, 1568.0, 2093.0];
  notes.forEach((freq, i) => {
    const t0 = now + i * 0.06;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  });
}

// 포커 칩/액션 사운드 (모두 합성음, 파일 불필요)

// 체크(+1): 짧고 가벼운 탁 소리
function playCheckSound() {
  const ctx = ensureDingAudioCtx();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(1800, now);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.08);
}

// 따당(+10): 칩 두 개가 부딪히는 듯한 두 번의 탁탁 소리
function playDdadangSound() {
  const ctx = ensureDingAudioCtx();
  const now = ctx.currentTime;
  [0, 0.09].forEach((offset, i) => {
    const t0 = now + offset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(i === 0 ? 1400 : 1700, t0);
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.28, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.1);
  });
}

// 하프(+100): 묵직하게 깔리는 저음 + 짧은 상승 스윕으로 임팩트 강조
function playHalfSound() {
  const ctx = ensureDingAudioCtx();
  const now = ctx.currentTime;

  const thud = ctx.createOscillator();
  const thudGain = ctx.createGain();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(160, now);
  thud.frequency.exponentialRampToValueAtTime(60, now + 0.25);
  thudGain.gain.setValueAtTime(0.001, now);
  thudGain.gain.exponentialRampToValueAtTime(0.4, now + 0.02);
  thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  thud.connect(thudGain).connect(ctx.destination);
  thud.start(now);
  thud.stop(now + 0.35);

  const sweep = ctx.createOscillator();
  const sweepGain = ctx.createGain();
  sweep.type = 'sawtooth';
  sweep.frequency.setValueAtTime(300, now + 0.05);
  sweep.frequency.exponentialRampToValueAtTime(900, now + 0.2);
  sweepGain.gain.setValueAtTime(0.0001, now + 0.05);
  sweepGain.gain.exponentialRampToValueAtTime(0.15, now + 0.12);
  sweepGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
  sweep.connect(sweepGain).connect(ctx.destination);
  sweep.start(now + 0.05);
  sweep.stop(now + 0.25);
}

// 다이(포기): 아래로 처지는 두 음, 트롬본 "womp womp" 느낌
function playDieSound() {
  const ctx = ensureDingAudioCtx();
  const now = ctx.currentTime;
  [[330, now], [220, now + 0.16]].forEach(([freq, t0]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.75, t0 + 0.18);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.2);
  });
}

