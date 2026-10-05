import {
  getAdminDashboard, watchAdminDashboard, signInOrganizerWithGoogle,
  signOutOrganizer, approveEntry, rejectEntry, removeEntry, checkInEntry, checkOutEntry,
  reservePlayer, updatePlayer, updateSession, resetSession,
} from '../src/firebaseStore.js';
import { initCourtsUI } from './courts-ui.js';

const $ = (id) => document.getElementById(id);
const ui = {
  alert: $('adminAlert'), loading: $('loadingPanel'), loadingMessage: $('loadingMessage'),
  reloadPage: $('reloadPageButton'), auth: $('authPanel'), dashboard: $('dashboard'),
  googleSignIn: $('googleSignInButton'), signOut: $('signOutButton'),
  sessionDate: $('sessionDateInput'), capacityInput: $('capacityInput'), settingsForm: $('settingsForm'),
  confirmed: $('adminConfirmed'), capacity: $('adminCapacity'), fill: $('adminCapacityFill'), availability: $('adminAvailability'),
  dateLabel: $('adminDateLabel'), checkedIn: $('checkedInMetric'), pending: $('pendingMetric'), waitlist: $('waitlistMetric'), open: $('openMetric'),
  pendingCount: $('pendingCountLabel'), pendingList: $('pendingList'), confirmedList: $('confirmedList'),
  waitlistCount: $('waitlistCountLabel'), waitlistList: $('waitlistList'),
  directorySearch: $('directorySearch'), directoryList: $('directoryList'), shareLink: $('shareLinkText'),
  copyLink: $('copyLinkButton'), copyLinkSecondary: $('copyLinkSecondary'), refresh: $('refreshButton'),
  reset: $('resetButton'), resetDialog: $('resetDialog'), resetForm: $('resetForm'), resetConfirm: $('resetConfirm'), cancelReset: $('cancelReset'),
};

let session = null;
let entries = [];
let players = [];
let selectedDate = null;
let unsubscribeDashboard = null;
let activeShareLink = '';

function showAlert(message, type = 'error') {
  ui.alert.textContent = message;
  ui.alert.classList.toggle('success', type === 'success');
  ui.alert.hidden = false;
}

function clearAlert() {
  ui.alert.hidden = true;
  ui.alert.textContent = '';
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
  container.replaceChildren();
  if (!items.length) {
    container.append(node('p', 'panel-empty', emptyMessage));
    return;
  }
  for (const entry of items) container.append(renderEntry(entry, kind));
}

function renderDirectory() {
  const search = ui.directorySearch.value.trim().toLowerCase();
  const available = players.filter((player) => {
    const text = `${player.name || ''} ${player.skillLevel || ''} ${player.division || ''}`.toLowerCase();
    return player.active && text.includes(search);
  }).slice(0, 40);
  const activePlayerIds = new Set(entries.filter((entry) =>
    ['pending', 'confirmed', 'waitlisted'].includes(entry.status)).map((entry) => entry.playerId));
  ui.directoryList.replaceChildren();
  if (!available.length) {
    ui.directoryList.append(node('p', 'panel-empty', players.length ? 'No matching player found.' : 'No approved players in the directory yet.'));
    return;
  }
  for (const player of available) {
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
}

function renderDashboard(data) {
  if (!data?.session) return;
  session = data.session;
  entries = Array.isArray(data.entries) ? data.entries : [];
  players = Array.isArray(data.players) ? data.players : [];
  selectedDate = session.date;
  if (document.activeElement !== ui.sessionDate) ui.sessionDate.value = session.date || '';
  if (document.activeElement !== ui.capacityInput) ui.capacityInput.value = String(session.capacity ?? 32);

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
  const snapshot = await getAdminDashboard(date);
  ui.loading.hidden = true;
  ui.auth.hidden = true;
  ui.dashboard.hidden = false;
  ui.signOut.hidden = false;
  renderDashboard(snapshot);
  await courtUI.refresh(session.id);
  unsubscribeDashboard?.();
  unsubscribeDashboard = await watchAdminDashboard((next) => renderDashboard(next), date);
  clearAlert();
}

function showAuth() {
  unsubscribeDashboard?.();
  unsubscribeDashboard = null;
  ui.loading.hidden = true;
  ui.auth.hidden = false;
  ui.dashboard.hidden = true;
  ui.signOut.hidden = true;
}

async function refreshDashboard() {
  const data = await getAdminDashboard(selectedDate);
  renderDashboard(data);
  await courtUI.refresh(session.id);
}

const courtUI = initCourtsUI({
  getSession: () => session,
  getEntries: () => entries,
  showAlert,
  refreshRoster: async () => renderDashboard(await getAdminDashboard(selectedDate)),
});

async function runEntryAction(action, entryId, button) {
  if (!session) return;
  const operations = {
    approve: approveEntry, reject: rejectEntry, remove: removeEntry,
    'check-in': checkInEntry, 'check-out': checkOutEntry,
  };
  const fn = operations[action];
  if (!fn) return;
  if (action === 'remove') {
    const name = entries.find((entry) => entry.id === entryId)?.name || 'this player';
    if (!confirm(`Remove ${name} from this session? A waitlisted player may be promoted.`)) return;
  }
  button.disabled = true;
  try {
    await fn(session.id, entryId);
    await refreshDashboard();
    showAlert('Session updated.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
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
    const player = players.find((item) => item.id === button.dataset.id);
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
    showAlert('Player added to today’s roster.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
    button.disabled = false;
  }
});
ui.directorySearch.addEventListener('input', renderDirectory);
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
    showAlert('Player profile updated.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
  } finally {
    save.disabled = false;
  }
});

ui.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ui.settingsForm.reportValidity()) return;
  const date = ui.sessionDate.value;
  const capacity = Number(ui.capacityInput.value);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 512) return showAlert('Enter a player limit from 1 to 512.');
  const button = ui.settingsForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    if (date !== selectedDate) {
      const data = await getAdminDashboard(date);
      await updateSession(data.session.id, { capacity });
      await beginDashboard(date);
    } else {
      await updateSession(session.id, { capacity });
      await refreshDashboard();
    }
    showAlert('Session settings saved.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
  } finally {
    button.disabled = false;
  }
});

async function copyLink() {
  if (!activeShareLink) return;
  try {
    await navigator.clipboard.writeText(activeShareLink);
    showAlert('Signup link copied. Paste it into your group chat.', 'success');
  } catch {
    showAlert('Clipboard access failed. Select and copy the link shown in Session settings.');
  }
}
ui.copyLink.addEventListener('click', copyLink);
ui.copyLinkSecondary.addEventListener('click', copyLink);
ui.refresh.addEventListener('click', async () => {
  ui.refresh.disabled = true;
  try {
    await refreshDashboard();
    showAlert('Dashboard refreshed.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
  } finally {
    ui.refresh.disabled = false;
  }
});

ui.reset.addEventListener('click', () => {
  ui.resetConfirm.value = '';
  ui.resetDialog.showModal();
  ui.resetConfirm.focus();
});
ui.cancelReset.addEventListener('click', () => ui.resetDialog.close());
ui.resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (ui.resetConfirm.value.trim() !== 'RESET') return showAlert('Type RESET exactly to confirm.');
  const button = $('confirmReset');
  button.disabled = true;
  try {
    await resetSession(selectedDate);
    ui.resetDialog.close();
    await beginDashboard(selectedDate);
    showAlert('Today’s signups were reset. Share the new link for this session.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
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
  showAuth();
  if (!String(error?.code || '').includes('auth-required')) showAlert(friendlyError(error));
} finally {
  clearTimeout(slowLoading);
}
