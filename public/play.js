import {
  getPublicPlaySession, getPublicAuthUid, watchPublicRoster,
  playerCheckIn, playerSitOut, playerResume, playerLeaveToday,
  requestPartner, cancelPartnerRequest, approvePartnerRequest,
  declinePartnerRequest, clearMyPartner, setPlayPin, unlockPlayPin,
} from '../src/firebaseStore.js';
import { watchPublicPlayBoard } from '../src/courtStore.js';

const token = new URLSearchParams(location.search).get('token')?.trim() || null;

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
  rosterPicker: $('rosterPicker'),
  search: $('rosterSearch'),
  results: $('rosterResults'),
  selected: $('selectedPanel'),
  selectedAvatar: $('selectedAvatar'),
  selectedName: $('selectedName'),
  selectedMeta: $('selectedMeta'),
  selectedNote: $('selectedNote'),
  changeName: $('changeNameButton'),
  deskTabs: $('deskTabs'),
  statusTab: $('statusTabButton'),
  pairTab: $('pairTabButton'),
  statusView: $('statusView'),
  pinDialog: $('pinDialog'),
  pinForm: $('pinForm'),
  pinAvatar: $('pinAvatar'),
  pinPlayerName: $('pinPlayerName'),
  pinTitle: $('pinTitle'),
  pinHelp: $('pinHelp'),
  pinAlert: $('pinAlert'),
  pinInput: $('pinInput'),
  pinConfirm: $('pinConfirmInput'),
  pinConfirmLabel: $('pinConfirmLabel'),
  pinCancel: $('pinCancelButton'),
  pinSubmit: $('pinSubmitButton'),
  selectedActions: $('selectedActions'),
  checkIn: $('checkInButton'),
  sitOut: $('sitOutButton'),
  resume: $('resumeButton'),
  leave: $('leaveButton'),
  pairPanel: $('pairPanel'),
  pairStatus: $('pairStatus'),
  pairSearchLabel: $('pairSearchLabel'),
  pairSearchField: $('pairSearchField'),
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
let alertTimer = null;
let deskView = 'status';

function showAlert(message) {
  ui.alert.textContent = message;
  ui.alert.hidden = false;
  ui.alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => clearAlert(), 4000);
}

function clearAlert() {
  clearTimeout(alertTimer);
  alertTimer = null;
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

function controlsEntry(entry) {
  if (!entry || !myUid) return false;
  if (entry.playClaimUid === myUid) return true;
  if (entry.hasPlayPin !== true && entry.ownerUid === myUid && entry.id === myUid) return true;
  return false;
}

function myEntry() {
  return roster.find((entry) => controlsEntry(entry)) || null;
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
    ui.boardDetail.textContent = 'Check in when you arrive so courts can include you.';
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
    if (controlsEntry(entry)) bits.push('Unlocked');
    else if (entry.hasPlayPin) bits.push('PIN protected');
    if (entry.partnerPlayerId) bits.push(`with ${nameForPlayerId(entry.partnerPlayerId)}`);
    else if (entry.partnerRequestToPlayerId) bits.push('pair requested');
    meta.textContent = bits.join(' · ');
    info.append(name, meta);
    button.append(mark, info);
    button.addEventListener('click', () => selectEntry(entry.id));
    ui.results.append(button);
  }
}

function showPinAlert(message) {
  ui.pinAlert.textContent = message;
  ui.pinAlert.hidden = false;
}

function clearPinAlert() {
  ui.pinAlert.hidden = true;
  ui.pinAlert.textContent = '';
}

function openPinModal(entry) {
  if (!entry || !ui.pinDialog) return;
  clearPinAlert();
  ui.pinAvatar.textContent = initials(entry.name);
  ui.pinPlayerName.textContent = entry.name || 'Player';
  ui.pinInput.value = '';
  ui.pinConfirm.value = '';
  if (entry.hasPlayPin) {
    ui.pinTitle.textContent = 'Enter your 4-digit PIN';
    ui.pinHelp.textContent = 'Unlock check-in, sit out, and pairing on this phone. Forgot it? Ask an organizer to clear your PIN.';
    ui.pinConfirmLabel.hidden = true;
    ui.pinConfirm.hidden = true;
    ui.pinConfirm.required = false;
    ui.pinSubmit.textContent = 'Unlock';
  } else {
    ui.pinTitle.textContent = 'Create a 4-digit PIN';
    ui.pinHelp.textContent = 'Pin this name so only you can manage it from any phone. You’ll enter this PIN next time.';
    ui.pinConfirmLabel.hidden = false;
    ui.pinConfirm.hidden = false;
    ui.pinConfirm.required = true;
    ui.pinSubmit.textContent = 'Save PIN';
  }
  if (!ui.pinDialog.open) ui.pinDialog.showModal();
  queueMicrotask(() => ui.pinInput.focus());
}

function closePinModal() {
  if (ui.pinDialog?.open) ui.pinDialog.close();
  clearPinAlert();
}

function setRosterPickerVisible(visible) {
  if (ui.rosterPicker) ui.rosterPicker.hidden = !visible;
}

function setPairSearchVisible(visible) {
  if (ui.pairSearchLabel) ui.pairSearchLabel.hidden = !visible;
  if (ui.pairSearchField) ui.pairSearchField.hidden = !visible;
  if (ui.pairSearch) ui.pairSearch.hidden = !visible;
}

function clearDeskSelection() {
  selectedId = null;
  deskView = 'status';
  ui.selected.hidden = true;
  if (ui.deskTabs) ui.deskTabs.hidden = true;
  if (ui.statusView) ui.statusView.hidden = false;
  ui.pairPanel.hidden = true;
  setRosterPickerVisible(true);
  renderResults();
}

function setDeskView(view) {
  deskView = view === 'pair' ? 'pair' : 'status';
  ui.statusTab?.classList.toggle('active', deskView === 'status');
  ui.pairTab?.classList.toggle('active', deskView === 'pair');
  if (ui.statusView) ui.statusView.hidden = deskView !== 'status';
  if (ui.pairPanel) ui.pairPanel.hidden = deskView !== 'pair';
  if (ui.selectedNote) {
    if (deskView === 'pair') {
      ui.selectedNote.hidden = true;
      ui.selectedNote.textContent = '';
    } else {
      ui.selectedNote.hidden = false;
      ui.selectedNote.textContent = 'This name is unlocked on this phone. Check in, sit out, or leave from here.';
    }
  }
}

function selectEntry(entryId, { openPin = true, resetView = openPin } = {}) {
  selectedId = entryId;
  const entry = roster.find((item) => item.id === entryId);
  renderResults();
  if (!entry) {
    clearDeskSelection();
    closePinModal();
    return;
  }

  const unlocked = controlsEntry(entry);
  if (!unlocked) {
    ui.selected.hidden = true;
    ui.selectedActions.hidden = true;
    if (ui.deskTabs) ui.deskTabs.hidden = true;
    if (ui.statusView) ui.statusView.hidden = false;
    ui.pairPanel.hidden = true;
    setRosterPickerVisible(true);
    if (openPin) openPinModal(entry);
    return;
  }

  closePinModal();
  setRosterPickerVisible(false);
  ui.selected.hidden = false;
  ui.selectedAvatar.textContent = initials(entry.name);
  ui.selectedName.textContent = entry.name || 'Player';
  ui.selectedMeta.textContent = statusLabel(entry);
  ui.selectedActions.hidden = false;
  // Sitting out already means you were checked in — only show Resume, not Check in & resume.
  ui.checkIn.hidden = entry.checkedIn || entry.sittingOut;
  ui.sitOut.hidden = !entry.checkedIn || entry.sittingOut;
  ui.resume.hidden = !entry.sittingOut;
  ui.leave.hidden = false;
  ui.checkIn.textContent = 'Check in';
  if (ui.deskTabs) ui.deskTabs.hidden = false;
  if (resetView) deskView = 'status';
  setDeskView(deskView);
  renderPairPanel(entry);
}

async function submitPin(event) {
  event?.preventDefault?.();
  const entry = roster.find((item) => item.id === selectedId);
  if (!session || !entry) return showPinAlert('Select your name first.');
  clearPinAlert();
  const pin = ui.pinInput.value.trim();
  if (!/^\d{4}$/.test(pin)) return showPinAlert('Enter a 4-digit PIN.');
  if (!entry.hasPlayPin) {
    const confirmPin = ui.pinConfirm.value.trim();
    if (pin !== confirmPin) return showPinAlert('PIN confirmation does not match.');
  }
  const old = ui.pinSubmit.textContent;
  ui.pinSubmit.disabled = true;
  try {
    if (entry.hasPlayPin) await unlockPlayPin(session.id, entry.id, pin);
    else await setPlayPin(session.id, entry.id, pin);
    closePinModal();
    showAlert(entry.hasPlayPin ? 'Name unlocked on this phone.' : 'PIN saved. Your name is unlocked on this phone.');
  } catch (error) {
    showPinAlert(error.message || 'Could not unlock with that PIN.');
  } finally {
    ui.pinSubmit.textContent = old;
    ui.pinSubmit.disabled = false;
  }
}

function renderPairPanel(entry) {
  ui.pairActions.replaceChildren();
  ui.pairCandidates.replaceChildren();
  if (!entry || !controlsEntry(entry)) return;

  if (!entry.playerId) {
    ui.pairStatus.textContent = 'Pairing unlocks after the organizer confirms your player profile.';
    setPairSearchVisible(false);
    return;
  }

  if (entry.partnerPlayerId) {
    ui.pairStatus.textContent = `Locked with ${nameForPlayerId(entry.partnerPlayerId)}. Draws keep you on the same side.`;
    setPairSearchVisible(false);
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
    setPairSearchVisible(false);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button button-outline button-wide';
    cancel.textContent = 'Cancel request';
    cancel.addEventListener('click', () => runPairAction('cancel', null, cancel));
    ui.pairActions.append(cancel);
    return;
  }

  setPairSearchVisible(true);
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

async function runAction(action, button) {
  const entry = roster.find((item) => item.id === selectedId);
  if (!session || !entry || !controlsEntry(entry)) {
    return showAlert('Unlock your name with a PIN first.');
  }
  clearAlert();
  const old = button.textContent;
  button.disabled = true;
  try {
    if (action === 'check-in') await playerCheckIn(session.id, entry.id);
    if (action === 'sit-out') await playerSitOut(session.id, entry.id);
    if (action === 'resume') await playerResume(session.id, entry.id);
    if (action === 'leave') {
      if (!confirm('Leave for today? This frees your confirmed spot.')) return;
      await playerLeaveToday(session.id, entry.id);
      clearDeskSelection();
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
  if (!session || !myEntry()) return showAlert('Unlock your name with a PIN first.');
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
  if (selectedId) selectEntry(selectedId, { openPin: false });
  else {
    const mine = myEntry();
    if (mine) selectEntry(mine.id, { openPin: false });
  }
}

ui.search.addEventListener('input', renderResults);
ui.pairSearch.addEventListener('input', () => {
  const mine = myEntry();
  if (mine && selectedId === mine.id) renderPairPanel(mine);
});
ui.changeName?.addEventListener('click', () => {
  closePinModal();
  clearDeskSelection();
  queueMicrotask(() => ui.search?.focus());
});
ui.statusTab?.addEventListener('click', () => setDeskView('status'));
ui.pairTab?.addEventListener('click', () => {
  setDeskView('pair');
  const entry = roster.find((item) => item.id === selectedId) || myEntry();
  if (entry) renderPairPanel(entry);
});
ui.pinForm?.addEventListener('submit', submitPin);
ui.pinCancel?.addEventListener('click', () => {
  closePinModal();
  clearDeskSelection();
});
ui.pinDialog?.addEventListener('cancel', () => {
  clearDeskSelection();
});
ui.checkIn.addEventListener('click', (event) => runAction('check-in', event.currentTarget));
ui.sitOut.addEventListener('click', (event) => runAction('sit-out', event.currentTarget));
ui.resume.addEventListener('click', (event) => runAction('resume', event.currentTarget));
ui.leave.addEventListener('click', (event) => runAction('leave', event.currentTarget));

function bindSessionLinks(sessionId) {
  const href = `/play?token=${encodeURIComponent(sessionId)}`;
  document.querySelector('.brand').href = href;
  const signup = document.getElementById('signupLink');
  if (signup) signup.href = `/join?token=${encodeURIComponent(sessionId)}`;
  if (!token) {
    history.replaceState(null, '', href);
  }
}

try {
  myUid = await getPublicAuthUid();
  const { session: next } = await getPublicPlaySession(token);
  session = next;
  bindSessionLinks(session.id);
  ui.missing.hidden = true;
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
  showAlert(error.message || 'Today’s player desk is not open yet.');
}

window.addEventListener('beforeunload', () => {
  stopRoster?.();
  stopBoard?.();
});
