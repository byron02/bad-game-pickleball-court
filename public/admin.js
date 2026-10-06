import {
  getAdminDashboard, watchAdminDashboard, signInOrganizerWithGoogle,
  signOutOrganizer, approveEntry, rejectEntry, removeEntry, checkInEntry, checkOutEntry,
  reservePlayer, createAndReservePlayer, updatePlayer, updateSession, resetSession, searchAdminPlayers,
} from '../src/firebaseStore.js';
import { initCourtsUI } from './courts-ui.js';

const $ = (id) => document.getElementById(id);
const ui = {
  alert: $('adminAlert'), loading: $('loadingPanel'), loadingMessage: $('loadingMessage'),
  reloadPage: $('reloadPageButton'), auth: $('authPanel'), dashboard: $('dashboard'),
  googleSignIn: $('googleSignInButton'), signOut: $('signOutButton'),
  sessionDate: $('sessionDateInput'), capacityInput: $('capacityInput'), settingsForm: $('settingsForm'),
  dashboardTitle: $('dashboardTitle'), settingsTitle: $('settingsTitle'),
  confirmed: $('adminConfirmed'), capacity: $('adminCapacity'), fill: $('adminCapacityFill'), availability: $('adminAvailability'),
  dateLabel: $('adminDateLabel'), checkedIn: $('checkedInMetric'), pending: $('pendingMetric'), waitlist: $('waitlistMetric'), open: $('openMetric'),
  pendingCount: $('pendingCountLabel'), pendingList: $('pendingList'), confirmedList: $('confirmedList'),
  waitlistCount: $('waitlistCountLabel'), waitlistList: $('waitlistList'),
  directorySearch: $('directorySearch'), directorySearchStatus: $('directorySearchStatus'), directoryList: $('directoryList'), shareLink: $('shareLinkText'),
  addPlayerButton: $('addPlayerButton'), addPlayerDialog: $('addPlayerDialog'), addPlayerForm: $('addPlayerForm'),
  addPlayerName: $('addPlayerName'), addPlayerSkill: $('addPlayerSkill'), addPlayerDivision: $('addPlayerDivision'),
  addPlayerPhoto: $('addPlayerPhoto'), addPlayerPhotoPreview: $('addPlayerPhotoPreview'), saveAddPlayer: $('saveAddPlayer'),
  copyLink: $('copyLinkButton'), copyLinkSecondary: $('copyLinkSecondary'), refresh: $('refreshButton'),
  reset: $('resetButton'), resetDialog: $('resetDialog'), resetForm: $('resetForm'), resetConfirm: $('resetConfirm'), cancelReset: $('cancelReset'),
  resetTitle: $('resetTitle'), resetDescription: $('resetDescription'),
};

let session = null;
let entries = [];
let directoryPlayers = [];
let directoryHasMore = false;
let directorySearchTimer = null;
let directorySearchSequence = 0;
let selectedDate = null;
let unsubscribeDashboard = null;
let activeShareLink = '';
let viewRequest = 0;
let activeView = 0;
let capacityDirty = false;
const DASHBOARD_LOAD_TIMEOUT_MS = 25000;

function withDashboardTimeout(operation) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const failure = new Error('Connecting to Firebase took too long. Check your connection and reload the page.');
        failure.code = 'dashboard-timeout';
        reject(failure);
      }, DASHBOARD_LOAD_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}
let addPhotoPreviewUrl = null;

function showAlert(message, type = 'error', anchor = null) {
  for (const status of document.querySelectorAll('.context-status')) status.remove();
  const dialog = document.querySelector('dialog[open]');
  const panel = dialog || anchor?.closest('.panel');
  if (panel) {
    const status = node('p', 'context-status', message);
    status.classList.toggle('success', type === 'success');
    status.setAttribute('role', type === 'success' ? 'status' : 'alert');
    const insertionPoint = dialog ? panel.querySelector('.dialog-actions') : panel.querySelector('.panel-head');
    if (dialog) insertionPoint?.before(status);
    else insertionPoint?.after(status);
    if (!insertionPoint) panel.append(status);
  }
  ui.alert.textContent = message;
  ui.alert.classList.toggle('success', type === 'success');
  ui.alert.setAttribute('role', panel ? 'presentation' : type === 'success' ? 'status' : 'alert');
  ui.alert.setAttribute('aria-hidden', String(Boolean(panel)));
  ui.alert.hidden = Boolean(panel);
}

function clearAlert() {
  ui.alert.hidden = true;
  ui.alert.textContent = '';
  for (const status of document.querySelectorAll('.context-status')) status.remove();
}

function friendlyError(error) {
  const code = error?.code || '';
  if (code === 'organizer-not-approved') return error.message;
  if (code.includes('permission-denied')) return 'The database denied this action. Refresh the page and try again.';
  if (code.includes('wrong-password') || code.includes('invalid-credential')) return 'Email or password was not accepted.';
  if (code.includes('network')) return 'Network error. Check your connection and try again.';
  return error?.message || 'Something went wrong. Please try again.';
}

function formatDate(value) {
  if (!value) return 'Today';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

function initials(name) {
  return String(name || '').split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
}

function photoSource(value) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(?:jpeg|png|webp);base64,/i.test(value)) return value;
  if (/^https:\/\//i.test(value)) return value;
  return null;
}

async function compressPlayerPhoto(file) {
  if (!file) return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.');
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  for (const quality of [.78, .65, .52, .4, .3]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= 115_000) return data;
  }
  throw new Error('This photo is too detailed to upload. Try a smaller photo.');
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function avatar(person) {
  const el = node('span', 'avatar');
  const source = photoSource(person.photoData || person.photoUrl);
  if (source) {
    const img = document.createElement('img');
    img.src = source;
    img.alt = '';
    el.append(img);
  } else {
    el.textContent = initials(person.name);
  }
  return el;
}

function actionButton(label, action, id, style = 'button-outline') {
  const button = node('button', `button button-small ${style}`, label);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

function statusBadge(label, kind) {
  return node('span', `badge badge-${kind}`, label);
}

function recordLabel(player) {
  const wins = Number(player.wins || 0);
  const losses = Number(player.losses || 0);
  return `${wins} ${wins === 1 ? 'win' : 'wins'} · ${losses} ${losses === 1 ? 'loss' : 'losses'}`;
}

function renderEntry(entry, kind) {
  const row = node('article', 'entry-row');
  row.append(avatar(entry));
  const body = node('div', 'entry-body');
  const top = node('div', 'entry-top');
  top.append(node('strong', '', entry.name || 'Unnamed player'));
  if (kind === 'pending') top.append(statusBadge(entry.playerId ? 'Existing player claim' : 'New profile', entry.playerId ? 'blue' : 'amber'));
  if (kind === 'confirmed') top.append(statusBadge(entry.checkedIn ? 'Checked in' : 'Reserved', entry.checkedIn ? 'green' : 'blue'));
  if (kind === 'waitlist') top.append(statusBadge('Waitlist', 'amber'));
  body.append(top);
  const details = [entry.skillLevel || 'Skill not set'];
  if (entry.division && entry.division !== 'unspecified') details.push(entry.division);
  if (kind === 'pending') details.push('Organizer review required');
  body.append(node('div', 'entry-meta', details.join(' · ')));
  const actions = node('div', 'entry-actions');
  if (kind === 'pending') {
    actions.append(actionButton('Approve', 'approve', entry.id, 'button-primary'));
    actions.append(actionButton('Reject', 'reject', entry.id, 'button-outline'));
  } else if (kind === 'confirmed') {
    actions.append(actionButton(entry.checkedIn ? 'Check out' : 'Check in', entry.checkedIn ? 'check-out' : 'check-in', entry.id, entry.checkedIn ? 'button-outline' : 'button-primary'));
    actions.append(actionButton('Remove', 'remove', entry.id, 'button-quiet'));
  } else if (kind === 'waitlist') {
    actions.append(actionButton('Remove', 'remove', entry.id, 'button-quiet'));
  }
  body.append(actions);
  row.append(body);
  return row;
}

function renderList(container, items, kind, emptyMessage) {
  const focused = container.contains(document.activeElement) ? {
    action: document.activeElement.dataset?.action,
    id: document.activeElement.dataset?.id,
  } : null;
  container.replaceChildren();
  if (!items.length) {
    container.append(node('p', 'panel-empty', emptyMessage));
  } else {
    for (const entry of items) container.append(renderEntry(entry, kind));
  }
  if (focused) {
    const replacement = [...container.querySelectorAll('button[data-action]')]
      .find((button) => button.dataset.action === focused.action && button.dataset.id === focused.id);
    (replacement || container).focus({ preventScroll: true });
  }
}

function renderDirectory() {
  const focused = ui.directoryList.contains(document.activeElement) ? {
    action: document.activeElement.dataset?.action,
    id: document.activeElement.dataset?.id,
  } : null;
  const activePlayerIds = new Set(entries.filter((entry) =>
    ['pending', 'confirmed', 'waitlisted', 'waitlist'].includes(entry.status)).map((entry) => entry.playerId));
  ui.directoryList.replaceChildren();
  if (!directoryPlayers.length) {
    const query = ui.directorySearch.value.trim();
    ui.directoryList.append(node('p', 'panel-empty', query.length === 1
      ? 'Type another letter to search.'
      : query ? 'No matching approved player found.' : 'No approved players in the directory yet.'));
    return;
  }
  for (const player of directoryPlayers) {
    const row = node('div', 'directory-row');
    row.append(avatar(player));
    const info = node('div', 'person-info');
    info.append(node('strong', '', player.name || 'Unnamed player'));
    info.append(node('small', '', [player.skillLevel, player.division && player.division !== 'unspecified' ? player.division : ''].filter(Boolean).join(' · ') || 'Player'));
    info.append(node('small', 'player-record', recordLabel(player)));
    row.append(info);
    const isActive = activePlayerIds.has(player.id);
    const button = actionButton(isActive ? 'Added' : 'Reserve', 'reserve', player.id, isActive ? 'button-outline' : 'button-primary');
    button.disabled = isActive;
    row.append(button);
    row.append(actionButton('Edit', 'edit-player', player.id, 'button-quiet'));
    ui.directoryList.append(row);
  }
  if (focused) {
    const replacement = [...ui.directoryList.querySelectorAll('button[data-action]')]
      .find((button) => button.dataset.action === focused.action && button.dataset.id === focused.id);
    (replacement || ui.directoryList).focus({ preventScroll: true });
  }
}

async function loadDirectory(query = ui.directorySearch.value.trim()) {
  const sequence = ++directorySearchSequence;
  const view = activeView;
  if (query.length === 1) {
    directoryPlayers = [];
    directoryHasMore = false;
    ui.directorySearchStatus.textContent = 'Type at least two letters, or clear the search to browse.';
    ui.directoryList.replaceChildren(node('p', 'panel-empty', 'Type another letter to search.'));
    return;
  }
  ui.directorySearchStatus.textContent = query ? 'Searching players…' : 'Loading players…';
  ui.directoryList.replaceChildren(node('p', 'panel-empty', 'Loading players…'));
  try {
    const result = await searchAdminPlayers(query);
    if (sequence !== directorySearchSequence || view !== activeView || ui.dashboard.hidden) return;
    directoryPlayers = Array.isArray(result.players) ? result.players : [];
    directoryHasMore = Boolean(result.hasMore);
    renderDirectory();
    ui.directorySearchStatus.textContent = directoryHasMore
      ? `Showing the first 40 ${query ? 'matches' : 'players'}. Type more letters to narrow the search.`
      : `${directoryPlayers.length} ${directoryPlayers.length === 1 ? 'player' : 'players'} found.`;
  } catch (error) {
    if (sequence !== directorySearchSequence || view !== activeView || ui.dashboard.hidden) return;
    directoryPlayers = [];
    directoryHasMore = false;
    ui.directoryList.replaceChildren(node('p', 'panel-empty', 'Player search could not load. Try again.'));
    ui.directorySearchStatus.textContent = 'Player search could not load.';
    showAlert(friendlyError(error), 'error', ui.directorySearch);
  }
}

function renderDashboard(data) {
  if (!data?.session) return;
  session = data.session;
  entries = Array.isArray(data.entries) ? data.entries : [];
  selectedDate = session.date;
  ui.dashboardTitle.textContent = formatDate(session.date);
  ui.settingsTitle.textContent = `Settings · ${formatDate(session.date)}`;
  if (document.activeElement !== ui.sessionDate) ui.sessionDate.value = session.date || '';
  if (!capacityDirty && document.activeElement !== ui.capacityInput) {
    ui.capacityInput.value = String(session.capacity ?? 32);
  }

  const pending = entries.filter((entry) => entry.status === 'pending');
  const confirmed = entries.filter((entry) => entry.status === 'confirmed');
  const waitlist = entries.filter((entry) => ['waitlist', 'waitlisted'].includes(entry.status));
  const confirmedCount = Number(session.confirmedCount ?? confirmed.length);
  const checkedInCount = Number(session.checkedInCount ?? confirmed.filter((entry) => entry.checkedIn).length);
  const pendingCount = Number(session.pendingCount ?? pending.length);
  const waitlistCount = Number(session.waitlistCount ?? waitlist.length);
  const capacity = Number(session.capacity ?? 32);
  const open = Number(session.spotsLeft ?? Math.max(0, capacity - confirmedCount));
  ui.confirmed.textContent = String(confirmedCount);
  ui.capacity.textContent = String(capacity);
  ui.fill.style.width = `${Math.min(100, Math.round(confirmedCount / Math.max(1, capacity) * 100))}%`;
  ui.availability.textContent = open > 0 ? `${open} ${open === 1 ? 'spot' : 'spots'} open for approval` : 'Confirmed spots full · approved players join the waitlist';
  ui.dateLabel.textContent = formatDate(session.date);
  ui.checkedIn.textContent = String(checkedInCount);
  ui.pending.textContent = String(pendingCount);
  ui.waitlist.textContent = String(waitlistCount);
  ui.open.textContent = String(open);
  ui.pendingCount.textContent = String(pendingCount);
  ui.waitlistCount.textContent = String(waitlistCount);
  renderList(ui.pendingList, pending, 'pending', 'No signup requests to review.');
  renderList(ui.confirmedList, confirmed, 'confirmed', 'No reserved players yet. Share the signup link or add a known player.');
  renderList(ui.waitlistList, waitlist, 'waitlist', 'No players on the waitlist.');
  renderDirectory();

  activeShareLink = session.signupUrl || `${location.origin}/join?token=${encodeURIComponent(session.shareToken || session.id)}`;
  ui.shareLink.textContent = activeShareLink;
  ui.copyLink.disabled = false;
  ui.copyLinkSecondary.disabled = false;
}

async function beginDashboard(date) {
  const request = ++viewRequest;
  const snapshot = await withDashboardTimeout(getAdminDashboard(date));
  if (request !== viewRequest) return;
  capacityDirty = false;
  unsubscribeDashboard?.();
  unsubscribeDashboard = null;
  activeView = request;
  ui.loading.hidden = true;
  ui.auth.hidden = true;
  ui.dashboard.hidden = false;
  ui.signOut.hidden = false;
  renderDashboard(snapshot);
  clearAlert();
  // Once the session is visible, a slow court query or listener must not hold
  // the entire dashboard on its loading screen.
  courtUI.refresh(snapshot.session.id).catch((error) => {
    if (request === viewRequest) showAlert(friendlyError(error));
  });
  loadDirectory();
  watchAdminDashboard((next) => {
    if (request !== activeView) return;
    if (next.error) {
      showAlert(friendlyError(next.error));
      return;
    }
    const previousSessionId = session?.id;
    renderDashboard(next);
    if (session?.id && previousSessionId !== session.id) {
      courtUI.refresh(session.id).catch((error) => showAlert(friendlyError(error)));
    }
  }, snapshot.session.date).then((stop) => {
    if (request !== viewRequest) stop();
    else unsubscribeDashboard = stop;
  }).catch((error) => {
    if (request === viewRequest) showAlert(`Live updates could not start: ${friendlyError(error)} Use Refresh to try again.`);
  });
}

function showAuth() {
  viewRequest += 1;
  activeView = 0;
  unsubscribeDashboard?.();
  unsubscribeDashboard = null;
  courtUI.dispose();
  session = null;
  entries = [];
  directoryPlayers = [];
  directorySearchSequence += 1;
  ui.loading.hidden = true;
  ui.auth.hidden = false;
  ui.dashboard.hidden = true;
  ui.signOut.hidden = true;
}

function showLoadingFailure(error) {
  showAuth();
  ui.loading.hidden = false;
  ui.auth.hidden = true;
  ui.loading.setAttribute('role', 'alert');
  ui.loading.querySelector('h1').textContent = 'Dashboard could not load';
  ui.loadingMessage.textContent = friendlyError(error);
  ui.reloadPage.hidden = false;
}

async function refreshDashboard() {
  const date = selectedDate;
  const request = activeView;
  const data = await getAdminDashboard(date);
  if (request !== activeView || date !== selectedDate) return;
  renderDashboard(data);
  await courtUI.refresh(session.id);
}

const courtUI = initCourtsUI({
  getSession: () => session,
  getEntries: () => entries,
  showAlert,
  refreshRoster: async () => {
    const date = selectedDate;
    const request = activeView;
    const data = await getAdminDashboard(date);
    if (request === activeView && date === selectedDate) renderDashboard(data);
  },
});

async function runEntryAction(action, entryId, button) {
  if (!session) return;
  const operations = {
    approve: approveEntry, reject: rejectEntry, remove: removeEntry,
    'check-in': checkInEntry, 'check-out': checkOutEntry,
  };
  const fn = operations[action];
  if (!fn) return;
  const panel = button.closest('.panel');
  if (action === 'remove') {
    const name = entries.find((entry) => entry.id === entryId)?.name || 'this player';
    if (!confirm(`Remove ${name} from this session? A waitlisted player may be promoted.`)) return;
  }
  button.disabled = true;
  try {
    await fn(session.id, entryId);
    await refreshDashboard();
    if (action === 'approve') await loadDirectory();
    showAlert('Session updated.', 'success', panel);
  } catch (error) {
    showAlert(friendlyError(error), 'error', panel);
  } finally {
    button.disabled = false;
  }
}

for (const list of [ui.pendingList, ui.confirmedList, ui.waitlistList]) {
  list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) runEntryAction(button.dataset.action, button.dataset.id, button);
  });
}
ui.directoryList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !session) return;
  if (button.dataset.action === 'edit-player') {
    const player = directoryPlayers.find((item) => item.id === button.dataset.id);
    if (!player) return;
    $('playerDialogTitle').textContent = `Edit ${player.name}`;
    $('playerIdInput').value = player.id;
    $('playerSkillInput').value = player.skillLevel;
    $('playerDivisionInput').value = player.division || 'unspecified';
    $('playerDialog').showModal();
    return;
  }
  if (button.dataset.action !== 'reserve') return;
  button.disabled = true;
  try {
    await reservePlayer(session.id, button.dataset.id);
    await refreshDashboard();
    showAlert('Player added to this session’s roster.', 'success', ui.directorySearch);
  } catch (error) {
    showAlert(friendlyError(error), 'error', ui.directorySearch);
    button.disabled = false;
  }
});
ui.directorySearch.addEventListener('input', () => {
  clearTimeout(directorySearchTimer);
  directorySearchSequence += 1;
  directoryPlayers = [];
  ui.directoryList.replaceChildren(node('p', 'panel-empty', 'Searching players…'));
  ui.directorySearchStatus.textContent = 'Searching players…';
  directorySearchTimer = setTimeout(() => loadDirectory(), 260);
});
ui.addPlayerButton.addEventListener('click', () => {
  if (!session) return showAlert('Open a session before adding a player.', 'error', ui.directorySearch);
  clearAlert();
  ui.addPlayerDialog.showModal();
});
$('cancelAddPlayer').addEventListener('click', () => ui.addPlayerDialog.close());
ui.addPlayerDialog.addEventListener('close', () => {
  ui.addPlayerForm.reset();
  if (addPhotoPreviewUrl) URL.revokeObjectURL(addPhotoPreviewUrl);
  addPhotoPreviewUrl = null;
  ui.addPlayerPhotoPreview.replaceChildren('+');
});
ui.addPlayerPhoto.addEventListener('change', () => {
  if (addPhotoPreviewUrl) URL.revokeObjectURL(addPhotoPreviewUrl);
  addPhotoPreviewUrl = null;
  ui.addPlayerPhotoPreview.replaceChildren('+');
  const file = ui.addPlayerPhoto.files?.[0];
  if (!file) return;
  addPhotoPreviewUrl = URL.createObjectURL(file);
  const preview = document.createElement('img');
  preview.src = addPhotoPreviewUrl;
  preview.alt = '';
  ui.addPlayerPhotoPreview.replaceChildren(preview);
});
ui.addPlayerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ui.addPlayerForm.reportValidity() || !session) return;
  ui.saveAddPlayer.disabled = true;
  ui.saveAddPlayer.textContent = 'Adding…';
  let result;
  try {
    const photoData = await compressPlayerPhoto(ui.addPlayerPhoto.files?.[0]);
    result = await createAndReservePlayer({
      sessionId: session.id,
      name: ui.addPlayerName.value.trim(),
      skillLevel: ui.addPlayerSkill.value,
      division: ui.addPlayerDivision.value,
      photoData,
    });
  } catch (error) {
    showAlert(friendlyError(error), 'error', ui.addPlayerDialog);
    return;
  } finally {
    ui.saveAddPlayer.disabled = false;
    ui.saveAddPlayer.textContent = 'Add to session';
  }
  ui.addPlayerDialog.close();
  ui.directorySearch.value = '';
  const status = result?.status || result?.entry?.status;
  showAlert(status === 'waitlisted' ? 'Player created and added to the waitlist.' : 'Player created and reserved for this session.', 'success', ui.directorySearch);
  refreshDashboard().catch((error) => showAlert(`Player added, but the roster could not refresh: ${friendlyError(error)}`, 'error', ui.directorySearch));
  loadDirectory('').catch((error) => showAlert(friendlyError(error), 'error', ui.directorySearch));
});
ui.capacityInput.addEventListener('input', () => { capacityDirty = true; });
$('cancelPlayer').addEventListener('click', () => $('playerDialog').close());
$('playerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const save = $('savePlayer');
  save.disabled = true;
  try {
    await updatePlayer($('playerIdInput').value, {
      skillLevel: $('playerSkillInput').value,
      division: $('playerDivisionInput').value,
    }, session?.id);
    $('playerDialog').close();
    await refreshDashboard();
    await loadDirectory();
    showAlert('Player profile updated.', 'success', ui.directorySearch);
  } catch (error) {
    showAlert(friendlyError(error), 'error', $('playerDialog'));
  } finally {
    save.disabled = false;
  }
});

ui.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ui.settingsForm.reportValidity()) return;
  const date = ui.sessionDate.value;
  const capacity = Number(ui.capacityInput.value);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 512) {
    return showAlert('Enter a player limit from 1 to 512.', 'error', ui.capacityInput);
  }
  const button = ui.settingsForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    if (date !== selectedDate) {
      const data = await getAdminDashboard(date);
      if (capacityDirty) await updateSession(data.session.id, { capacity });
      await beginDashboard(date);
    } else {
      if (capacityDirty || capacity !== session.capacity) await updateSession(session.id, { capacity });
      await refreshDashboard();
      capacityDirty = false;
    }
    showAlert('Session settings saved.', 'success', ui.settingsForm);
  } catch (error) {
    showAlert(friendlyError(error), 'error', ui.settingsForm);
  } finally {
    button.disabled = false;
  }
});

async function copyLink(button) {
  if (!activeShareLink) return;
  try {
    await navigator.clipboard.writeText(activeShareLink);
    showAlert('Signup link copied. Paste it into your group chat.', 'success', button);
  } catch {
    showAlert('Clipboard access failed. Select and copy the link shown in Session settings.', 'error', button);
  }
}
ui.copyLink.addEventListener('click', () => copyLink(ui.copyLink));
ui.copyLinkSecondary.addEventListener('click', () => copyLink(ui.copyLinkSecondary));
ui.refresh.addEventListener('click', async () => {
  ui.refresh.disabled = true;
  try {
    await refreshDashboard();
    showAlert('Dashboard refreshed.', 'success', ui.refresh);
  } catch (error) {
    showAlert(friendlyError(error), 'error', ui.refresh);
  } finally {
    ui.refresh.disabled = false;
  }
});

ui.reset.addEventListener('click', () => {
  ui.resetConfirm.value = '';
  ui.resetTitle.textContent = 'Reset ' + formatDate(selectedDate) + ' signups?';
  ui.resetDescription.textContent = 'This clears requests, reservations, the waitlist, and check-ins for ' +
    formatDate(selectedDate) + '. Saved player profiles remain available.';
  ui.resetDialog.showModal();
  ui.resetConfirm.focus();
});
ui.cancelReset.addEventListener('click', () => ui.resetDialog.close());
ui.resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (ui.resetConfirm.value.trim() !== 'RESET') return showAlert('Type RESET exactly to confirm.', 'error', ui.resetConfirm);
  const button = $('confirmReset');
  button.disabled = true;
  try {
    await resetSession(selectedDate);
    ui.resetDialog.close();
    await beginDashboard(selectedDate);
    showAlert(formatDate(selectedDate) + ' signups were reset. Share the new link for this session.', 'success', ui.reset);
  } catch (error) {
    showAlert(friendlyError(error), 'error', ui.resetConfirm);
  } finally {
    button.disabled = false;
  }
});

ui.googleSignIn.addEventListener('click', async () => {
  ui.googleSignIn.disabled = true;
  clearAlert();
  try {
    await signInOrganizerWithGoogle();
    await beginDashboard();
  } catch (error) {
    showAlert(friendlyError(error));
  } finally {
    ui.googleSignIn.disabled = false;
  }
});
ui.reloadPage.addEventListener('click', () => location.reload());
ui.signOut.addEventListener('click', async () => {
  try {
    await signOutOrganizer();
    showAuth();
    clearAlert();
  } catch (error) {
    showAlert(friendlyError(error));
  }
});

const slowLoading = setTimeout(() => {
  if (!ui.loading.hidden) {
    ui.loadingMessage.textContent = 'Still connecting to Firebase. Reload this page if it does not finish.';
    ui.reloadPage.hidden = false;
  }
}, 12000);
try {
  await beginDashboard();
} catch (error) {
  if (String(error?.code || '').includes('auth-required')) {
    showAuth();
  } else if (error?.code === 'organizer-not-approved') {
    showAuth();
    showAlert(friendlyError(error));
  } else {
    showLoadingFailure(error);
  }
} finally {
  clearTimeout(slowLoading);
}
