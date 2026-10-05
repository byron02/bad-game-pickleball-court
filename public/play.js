import {
  getPublicSession, getPublicAuthUid, watchPublicRoster,
  playerCheckIn, playerSitOut, playerResume, playerLeaveToday,
  requestPartner, cancelPartnerRequest, approvePartnerRequest,
  declinePartnerRequest, clearMyPartner,
} from '../src/firebaseStore.js';
import { watchPublicPlayBoard } from '../src/courtStore.js';

const token = new URLSearchParams(location.search).get('token')?.trim();
if (token) {
  document.querySelector('.brand').href = `/play?token=${encodeURIComponent(token)}`;
  const signup = document.getElementById('signupLink');
  if (signup) signup.href = `/join?token=${encodeURIComponent(token)}`;
}

const $ = (id) => document.getElementById(id);
const ui = {
  alert: $('pageAlert'),
  missing: $('missingLinkPanel'),
  desk: $('deskPanel'),
  sessionDate: $('sessionDate'),
  sessionState: $('sessionState'),
  myBoard: $('myBoard'),
  boardTitle: $('boardTitle'),
  boardDetail: $('boardDetail'),
  inbound: $('inboundRequests'),
  search: $('rosterSearch'),
  results: $('rosterResults'),
  selected: $('selectedPanel'),
  selectedAvatar: $('selectedAvatar'),
  selectedName: $('selectedName'),
  selectedMeta: $('selectedMeta'),
  selectedNote: $('selectedNote'),
  selectedActions: $('selectedActions'),
  checkIn: $('checkInButton'),
  sitOut: $('sitOutButton'),
  resume: $('resumeButton'),
  leave: $('leaveButton'),
  pairPanel: $('pairPanel'),
  pairStatus: $('pairStatus'),
  pairSearch: $('pairSearch'),
  pairCandidates: $('pairCandidates'),
  pairActions: $('pairActions'),
};

let session = null;
let myUid = null;
let roster = [];
let selectedId = null;
let board = null;
let stopRoster = null;
let stopBoard = null;

function showAlert(message) {
  ui.alert.textContent = message;
  ui.alert.hidden = false;
  ui.alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearAlert() {
  ui.alert.hidden = true;
  ui.alert.textContent = '';
}

function formatDate(value) {
  if (!value) return 'Open play';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
}

function initials(name) {
  return String(name || '').split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
}

function isMine(entry) {
  return Boolean(entry && myUid && (entry.id === myUid || entry.ownerUid === myUid));
}

function myEntry() {
  return roster.find((entry) => isMine(entry)) || null;
}

function nameForPlayerId(playerId) {
  return roster.find((entry) => entry.playerId === playerId)?.name || 'Player';
}

function statusLabel(entry) {
  if (!entry) return 'Unknown';
  if (entry.sittingOut) return 'Sitting out';
  if (entry.checkedIn) return 'Checked in · waiting to play';
  return 'Reserved · not checked in';
}

function renderBoard() {
  const mine = myEntry();
  if (!mine?.playerId) {
    ui.myBoard.hidden = true;
    return;
  }
  ui.myBoard.hidden = false;
  const assignment = board?.assignment;
  if (mine.sittingOut) {
    ui.boardTitle.textContent = 'Sitting out';
    ui.boardDetail.textContent = 'You stay reserved, but draws skip you until you resume.';
    return;
  }
  if (!mine.checkedIn) {
    ui.boardTitle.textContent = 'Not checked in yet';
    ui.boardDetail.textContent = 'Check in on this phone when you arrive so courts can include you.';
    return;
  }
  if (assignment?.kind === 'playing') {
    ui.boardTitle.textContent = `Playing now · ${assignment.courtName}`;
    ui.boardDetail.textContent = `${assignment.labels.sideA} vs ${assignment.labels.sideB}`;
    return;
  }
  if (assignment?.kind === 'next') {
    ui.boardTitle.textContent = `Up next · ${assignment.courtName}`;
    ui.boardDetail.textContent = `${assignment.labels.sideA} vs ${assignment.labels.sideB}`;
    return;
  }
  ui.boardTitle.textContent = 'Waiting for a court draw';
  ui.boardDetail.textContent = mine.partnerPlayerId
    ? `Locked with ${nameForPlayerId(mine.partnerPlayerId)}. You’ll stay together when a court draws you.`
    : 'You’re in the pool as a solo until a partner request is approved.';
}

function renderInbound() {
  const mine = myEntry();
  ui.inbound.replaceChildren();
  if (!mine?.playerId) {
    ui.inbound.hidden = true;
    return;
  }
  const requests = roster.filter((entry) =>
    entry.partnerRequestToPlayerId === mine.playerId && !entry.partnerPlayerId);
  if (!requests.length) {
    ui.inbound.hidden = true;
    return;
  }
  ui.inbound.hidden = false;
  const heading = document.createElement('span');
  heading.className = 'label-overline';
  heading.textContent = 'Pair requests';
  ui.inbound.append(heading);
  for (const entry of requests) {
    const row = document.createElement('div');
    row.className = 'play-inbound-row';
    const copy = document.createElement('p');
    copy.textContent = `${entry.name} wants to pair with you. Until you approve, you both stay solo for draws.`;
    const actions = document.createElement('div');
    actions.className = 'play-actions play-actions-inline';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'button button-primary';
    approve.textContent = 'Approve pair';
    approve.addEventListener('click', () => runPairAction('approve', entry.id, approve));
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'button button-outline';
    decline.textContent = 'Keep solo';
    decline.addEventListener('click', () => runPairAction('decline', entry.id, decline));
    actions.append(approve, decline);
    row.append(copy, actions);
    ui.inbound.append(row);
  }
}

function renderResults() {
  const search = ui.search.value.trim().toLowerCase();
  ui.results.replaceChildren();
  const matches = roster.filter((entry) => {
    if (!search) return true;
    return String(entry.name || '').toLowerCase().includes(search);
  });
  if (!matches.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = search ? 'No confirmed player matches that name.' : 'No confirmed players yet.';
    ui.results.append(note);
    return;
  }
  for (const entry of matches.slice(0, 20)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `person-option${selectedId === entry.id ? ' selected' : ''}`;
    button.dataset.id = entry.id;
    const mark = document.createElement('span');
    mark.className = 'avatar';
    mark.textContent = initials(entry.name);
    const info = document.createElement('div');
    info.className = 'person-info';
    const name = document.createElement('strong');
    name.textContent = entry.name || 'Player';
    const meta = document.createElement('small');
    const bits = [statusLabel(entry)];
    if (isMine(entry)) bits.push('You');
    if (entry.partnerPlayerId) bits.push(`with ${nameForPlayerId(entry.partnerPlayerId)}`);
    else if (entry.partnerRequestToPlayerId) bits.push('pair requested');
    meta.textContent = bits.join(' · ');
    info.append(name, meta);
    button.append(mark, info);
    button.addEventListener('click', () => selectEntry(entry.id));
    ui.results.append(button);
  }
}

function renderPairPanel(entry) {
  ui.pairActions.replaceChildren();
  ui.pairCandidates.replaceChildren();
  if (!entry || !isMine(entry)) {
    ui.pairPanel.hidden = true;
    return;
  }
  if (!entry.playerId) {
    ui.pairPanel.hidden = false;
    ui.pairStatus.textContent = 'Pairing unlocks after the organizer confirms your player profile.';
    ui.pairSearch.hidden = true;
    return;
  }
  ui.pairPanel.hidden = false;
  ui.pairSearch.hidden = false;

  if (entry.partnerPlayerId) {
    ui.pairStatus.textContent = `Locked with ${nameForPlayerId(entry.partnerPlayerId)}. Draws keep you on the same side.`;
    ui.pairSearch.hidden = true;
    const unpair = document.createElement('button');
    unpair.type = 'button';
    unpair.className = 'button button-outline button-wide';
    unpair.textContent = 'Unpair · play solo';
    unpair.addEventListener('click', () => runPairAction('unpair', null, unpair));
    ui.pairActions.append(unpair);
    return;
  }

  if (entry.partnerRequestToPlayerId) {
    ui.pairStatus.textContent = `Waiting for ${nameForPlayerId(entry.partnerRequestToPlayerId)} to approve. Until then you both stay solo.`;
    ui.pairSearch.hidden = true;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button button-outline button-wide';
    cancel.textContent = 'Cancel request';
    cancel.addEventListener('click', () => runPairAction('cancel', null, cancel));
    ui.pairActions.append(cancel);
    return;
  }

  ui.pairStatus.textContent = 'Pick someone confirmed today. They must approve before the draw locks you together.';
  const search = ui.pairSearch.value.trim().toLowerCase();
  const candidates = roster.filter((item) => {
    if (!item.playerId || item.id === entry.id) return false;
    if (item.partnerPlayerId || item.sittingOut) return false;
    if (!search) return true;
    return String(item.name || '').toLowerCase().includes(search);
  }).slice(0, 12);

  if (!candidates.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = search ? 'No available partner matches that name.' : 'No other unpaired players available right now.';
    ui.pairCandidates.append(note);
    return;
  }

  for (const candidate of candidates) {
    const row = document.createElement('div');
    row.className = 'play-pair-row';
    const info = document.createElement('div');
    info.className = 'person-info';
    const name = document.createElement('strong');
    name.textContent = candidate.name || 'Player';
    const meta = document.createElement('small');
    meta.textContent = statusLabel(candidate);
    info.append(name, meta);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-primary button-small';
    button.textContent = 'Request pair';
    button.addEventListener('click', () => runPairAction('request', candidate.playerId, button));
    row.append(info, button);
    ui.pairCandidates.append(row);
  }
}

function selectEntry(entryId) {
  selectedId = entryId;
  const entry = roster.find((item) => item.id === entryId);
  renderResults();
  if (!entry) {
    ui.selected.hidden = true;
    return;
  }
  ui.selected.hidden = false;
  ui.selectedAvatar.textContent = initials(entry.name);
  ui.selectedName.textContent = entry.name || 'Player';
  ui.selectedMeta.textContent = statusLabel(entry);
  const mine = isMine(entry);
  ui.selectedActions.hidden = !mine;
  if (mine) {
    ui.selectedNote.textContent = 'This is your spot on this phone. Nobody else can sit you out or pair from the player desk.';
    ui.checkIn.hidden = entry.checkedIn && !entry.sittingOut;
    ui.sitOut.hidden = !entry.checkedIn || entry.sittingOut;
    ui.resume.hidden = !entry.sittingOut;
    ui.leave.hidden = false;
    ui.checkIn.textContent = entry.sittingOut ? 'Check in & resume' : 'Check in';
  } else {
    ui.selectedNote.textContent = 'Only the phone that signed up this player can change their status. Ask them to open the player desk link on their phone.';
  }
  renderPairPanel(entry);
}

async function runAction(action, button) {
  if (!session || !selectedId || !isMine(roster.find((item) => item.id === selectedId))) {
    return showAlert('Select your own name to manage attendance.');
  }
  clearAlert();
  const old = button.textContent;
  button.disabled = true;
  try {
    if (action === 'check-in') await playerCheckIn(session.id);
    if (action === 'sit-out') await playerSitOut(session.id);
    if (action === 'resume') await playerResume(session.id);
    if (action === 'leave') {
      if (!confirm('Leave for today? This frees your confirmed spot.')) return;
      await playerLeaveToday(session.id);
      selectedId = null;
      ui.selected.hidden = true;
      showAlert('You left today’s session.');
    }
  } catch (error) {
    showAlert(error.message || 'Could not update your status.');
  } finally {
    button.textContent = old;
    button.disabled = false;
  }
}

async function runPairAction(action, target, button) {
  if (!session || !myEntry()) return showAlert('Select your own name to manage pairing.');
  clearAlert();
  const old = button?.textContent;
  if (button) button.disabled = true;
  try {
    if (action === 'request') await requestPartner(session.id, target);
    if (action === 'cancel') await cancelPartnerRequest(session.id);
    if (action === 'approve') await approvePartnerRequest(session.id, target);
    if (action === 'decline') await declinePartnerRequest(session.id, target);
    if (action === 'unpair') await clearMyPartner(session.id);
    ui.pairSearch.value = '';
  } catch (error) {
    showAlert(error.message || 'Could not update pairing.');
  } finally {
    if (button && old != null) {
      button.textContent = old;
      button.disabled = false;
    }
  }
}

function refreshAll() {
  renderResults();
  renderInbound();
  renderBoard();
  if (selectedId) selectEntry(selectedId);
  else {
    const mine = myEntry();
    if (mine) selectEntry(mine.id);
  }
}

ui.search.addEventListener('input', renderResults);
ui.pairSearch.addEventListener('input', () => {
  const mine = myEntry();
  if (mine && selectedId === mine.id) renderPairPanel(mine);
});
ui.checkIn.addEventListener('click', (event) => runAction('check-in', event.currentTarget));
ui.sitOut.addEventListener('click', (event) => runAction('sit-out', event.currentTarget));
ui.resume.addEventListener('click', (event) => runAction('resume', event.currentTarget));
ui.leave.addEventListener('click', (event) => runAction('leave', event.currentTarget));

if (!token) {
  ui.missing.hidden = false;
  ui.desk.hidden = true;
} else {
  try {
    myUid = await getPublicAuthUid();
    const { session: next } = await getPublicSession(token);
    session = next;
    ui.desk.hidden = false;
    ui.sessionDate.textContent = formatDate(session.date);
    ui.sessionState.textContent = session.open ? 'Open' : 'Closed';
    ui.sessionState.className = `badge badge-${session.open ? 'green' : 'red'}`;
    stopRoster = await watchPublicRoster(session.id, (entries, error) => {
      if (error) {
        showAlert(error.message || 'Could not load the roster.');
        return;
      }
      roster = entries;
      const mine = myEntry();
      stopBoard?.();
      stopBoard = mine?.playerId
        ? watchPublicPlayBoard(session.id, mine.playerId, (nextBoard, boardError) => {
          if (boardError) return;
          board = nextBoard;
          renderBoard();
        })
        : null;
      refreshAll();
    });
  } catch (error) {
    ui.desk.hidden = true;
    ui.missing.hidden = false;
    showAlert(error.message || 'This player desk link is invalid or closed.');
  }
}

window.addEventListener('beforeunload', () => {
  stopRoster?.();
  stopBoard?.();
});
