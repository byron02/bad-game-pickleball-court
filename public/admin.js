import {
  getAdminDashboard, watchAdminDashboard, signInOrganizerWithGoogle,
  signOutOrganizer, approveEntry, rejectEntry, removeEntry, checkInEntry, checkOutEntry,
  reservePlayer, updatePlayer, updateSession, resetSession, setEntryPartner,
  createAndReservePlayer,
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
  waitlistCount: $('waitlistCountLabel'), waitlistList: $('waitlistList'), waitlistBlock: $('waitlistBlock'),
  todayCount: $('todayCountLabel'), todaySpotsNote: $('todaySpotsNote'),
  todayPlayersList: $('todayPlayersList'), todayWaitlistList: $('todayWaitlistList'),
  todayWaitlistCount: $('todayWaitlistCountLabel'), gotoPlayers: $('gotoPlayersButton'),
  rosterSearch: $('rosterSearch'), rosterFillList: $('rosterFillList'), fillSpotsNote: $('fillSpotsNote'),
  confirmedPager: $('confirmedPager'), fillPager: $('fillPager'), waitlistPager: $('waitlistPager'),
  directoryPager: $('directoryPager'),
  directorySearch: $('directorySearch'), directoryList: $('directoryList'), shareLink: $('shareLinkText'),
  copyLink: $('copyLinkButton'), copyLinkSecondary: $('copyLinkSecondary'), refresh: $('refreshButton'),
  reset: $('resetButton'), resetDialog: $('resetDialog'), resetForm: $('resetForm'), resetConfirm: $('resetConfirm'), cancelReset: $('cancelReset'),
  navPendingPill: $('navPendingPill'), mobilePendingPill: $('mobilePendingPill'),
};

let session = null;
let entries = [];
let players = [];
let selectedDate = null;
let unsubscribeDashboard = null;
let activeShareLink = '';
let currentView = 'overview';
const pendingSkillByEntry = new Map();
const pendingNameByEntry = new Map();
const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced'];
const VIEWS = ['overview', 'requests', 'roster', 'directory', 'courts'];
const PAGE_SIZE = 12;
const listPages = { confirmed: 1, waitlist: 1, fill: 1, directory: 1 };

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
  if (code.includes('failed-precondition') || code.includes('aborted')) {
    return 'Someone else updated the session at the same time. Tap Refresh, then try again.';
  }
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

function nameInput(entryId, current) {
  const label = node('label', 'entry-skill');
  label.append(node('span', '', 'Correct name'));
  const input = document.createElement('input');
  input.className = 'input entry-skill-select';
  input.type = 'text';
  input.maxLength = 60;
  input.required = true;
  input.dataset.nameFor = entryId;
  input.setAttribute('aria-label', 'Correct player name');
  input.value = pendingNameByEntry.get(entryId) || current || '';
  input.addEventListener('input', () => {
    pendingNameByEntry.set(entryId, input.value);
  });
  label.append(input);
  return label;
}

function skillSelect(entryId, current) {
  const label = node('label', 'entry-skill');
  label.append(node('span', '', 'Set skill level'));
  const select = document.createElement('select');
  select.className = 'input entry-skill-select';
  select.dataset.skillFor = entryId;
  select.setAttribute('aria-label', 'Set skill level');
  const selected = pendingSkillByEntry.get(entryId) || current || 'beginner';
  for (const level of SKILL_LEVELS) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level.charAt(0).toUpperCase() + level.slice(1);
    if (level === selected) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    pendingSkillByEntry.set(entryId, select.value);
  });
  label.append(select);
  return label;
}

function showView(name, { updateHash = true } = {}) {
  const view = VIEWS.includes(name) ? name : 'overview';
  currentView = view;
  document.querySelectorAll('.admin-view').forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });
  document.querySelectorAll('.web-nav a[data-view], .mobile-nav button[data-view]').forEach((item) => {
    item.classList.toggle('current', item.dataset.view === view);
  });
  if (updateHash) {
    const nextHash = `#${view}`;
    if (location.hash !== nextHash) history.replaceState(null, '', nextHash);
  }
  window.scrollTo(0, 0);
}

function syncPendingBadges(count) {
  for (const pill of [ui.navPendingPill, ui.mobilePendingPill]) {
    if (!pill) continue;
    pill.textContent = String(count);
    pill.hidden = count < 1;
  }
}

function partnerName(entry) {
  if (!entry?.partnerPlayerId) return null;
  return entries.find((item) => item.playerId === entry.partnerPlayerId)?.name || 'Partner';
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
  if (kind === 'confirmed' && entry.partnerPlayerId) {
    top.append(statusBadge(`With ${partnerName(entry)}`, 'amber'));
  }
  body.append(top);
  if (kind === 'pending') {
    body.append(nameInput(entry.id, entry.name));
    body.append(skillSelect(entry.id, entry.skillLevel));
    const details = [];
    if (entry.division && entry.division !== 'unspecified') details.push(entry.division);
    details.push('Fix name or skill if needed, then approve');
    body.append(node('div', 'entry-meta', details.join(' · ')));
  } else {
    const details = [entry.skillLevel || 'Skill not set'];
    if (entry.division && entry.division !== 'unspecified') details.push(entry.division);
    if (kind === 'confirmed' && entry.partnerPlayerId) details.push(`Locked doubles with ${partnerName(entry)}`);
    body.append(node('div', 'entry-meta', details.join(' · ')));
  }
  const actions = node('div', 'entry-actions');
  if (kind === 'pending') {
    actions.append(actionButton('Approve', 'approve', entry.id, 'button-primary'));
    actions.append(actionButton('Reject', 'reject', entry.id, 'button-outline'));
  } else if (kind === 'confirmed') {
    actions.append(actionButton(entry.checkedIn ? 'Check out' : 'Check in', entry.checkedIn ? 'check-out' : 'check-in', entry.id, entry.checkedIn ? 'button-outline' : 'button-primary'));
    if (entry.playerId) {
      actions.append(actionButton(entry.partnerPlayerId ? 'Change pair' : 'Pair doubles', 'pair', entry.id, 'button-outline'));
      if (entry.partnerPlayerId) actions.append(actionButton('Unpair', 'unpair', entry.id, 'button-quiet'));
      actions.append(actionButton('Edit', 'edit-entry-player', entry.playerId, 'button-quiet'));
    }
    actions.append(actionButton('Remove', 'remove', entry.id, 'button-quiet'));
  } else if (kind === 'waitlist') {
    actions.append(actionButton('Remove', 'remove', entry.id, 'button-quiet'));
  }
  body.append(actions);
  row.append(body);
  return row;
}

function pageSlice(items, key, size = PAGE_SIZE) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const page = Math.min(Math.max(1, Number(listPages[key]) || 1), pages);
  listPages[key] = page;
  const start = (page - 1) * size;
  return {
    page,
    pages,
    total,
    start: total ? start + 1 : 0,
    end: Math.min(start + size, total),
    items: items.slice(start, start + size),
  };
}

function renderPager(pager, key, info) {
  if (!pager) return;
  if (!info.total || info.pages <= 1) {
    pager.hidden = true;
    pager.replaceChildren();
    return;
  }
  pager.hidden = false;
  pager.replaceChildren();
  const meta = node('span', 'list-pager-meta', `Showing ${info.start}–${info.end} of ${info.total}`);
  const actions = node('div', 'list-pager-actions');
  const prev = actionButton('Previous', 'page-prev', key, 'button-outline');
  prev.disabled = info.page <= 1;
  const label = node('span', 'list-pager-page', `Page ${info.page} / ${info.pages}`);
  const next = actionButton('Next', 'page-next', key, 'button-outline');
  next.disabled = info.page >= info.pages;
  actions.append(prev, label, next);
  pager.append(meta, actions);
}

function renderList(container, items, kind, emptyMessage, options = {}) {
  const active = document.activeElement;
  const focusedSkillId = kind === 'pending' && active?.matches?.('select[data-skill-for]')
    ? active.dataset.skillFor
    : null;
  const focusedNameId = kind === 'pending' && active?.matches?.('input[data-name-for]')
    ? active.dataset.nameFor
    : null;
  container.replaceChildren();
  const pageKey = options.pageKey || null;
  const pager = options.pager || null;
  const pageable = pageKey ? pageSlice(items, pageKey) : { items, total: items.length, pages: 1, page: 1, start: items.length ? 1 : 0, end: items.length };
  if (!items.length) {
    if (pager) {
      pager.hidden = true;
      pager.replaceChildren();
    }
    container.append(node('p', 'panel-empty', emptyMessage));
    return;
  }
  for (const entry of pageable.items) container.append(renderEntry(entry, kind));
  if (pageKey) renderPager(pager, pageKey, pageable);
  if (focusedNameId) {
    container.querySelector(`input[data-name-for="${CSS.escape(focusedNameId)}"]`)?.focus();
  } else if (focusedSkillId) {
    container.querySelector(`select[data-skill-for="${CSS.escape(focusedSkillId)}"]`)?.focus();
  }
}

function renderTodaySide(confirmed, waitlist, openSpots) {
  if (!ui.todayPlayersList) return;
  if (ui.todayCount) ui.todayCount.textContent = String(confirmed.length);
  if (ui.todayWaitlistCount) ui.todayWaitlistCount.textContent = String(waitlist.length);
  if (ui.todaySpotsNote) {
    ui.todaySpotsNote.textContent = openSpots > 0
      ? `${openSpots} open ${openSpots === 1 ? 'spot' : 'spots'} · approve a signup or add from Players`
      : 'Confirmed spots are full · new approvals go to the waitlist';
  }
  renderList(ui.todayPlayersList, confirmed, 'confirmed', 'No reserved players yet today.');
  if (ui.todayWaitlistList) {
    renderList(ui.todayWaitlistList, waitlist, 'waitlist', 'Waitlist is empty.');
  }
}

function rosteredPlayerIds() {
  return new Set(entries.filter((entry) =>
    ['pending', 'confirmed', 'waitlisted'].includes(entry.status)).map((entry) => entry.playerId));
}

function renderFillList() {
  if (!ui.rosterFillList) return;
  const search = ui.rosterSearch?.value.trim().toLowerCase() || '';
  const openSpots = Math.max(0, Number(session?.spotsLeft ?? 0));
  const activePlayerIds = rosteredPlayerIds();
  const available = players.filter((player) => {
    if (!player.active || activePlayerIds.has(player.id)) return false;
    const text = `${player.name || ''} ${player.skillLevel || ''} ${player.division || ''}`.toLowerCase();
    return text.includes(search);
  });
  if (ui.fillSpotsNote) {
    ui.fillSpotsNote.textContent = openSpots > 0
      ? `${openSpots} open confirmed ${openSpots === 1 ? 'spot' : 'spots'}. Search someone who is not reserved yet, then add them or add and check in.`
      : 'Confirmed spots are full. You can still reserve players to the waitlist.';
  }
  ui.rosterFillList.replaceChildren();
  const pageable = pageSlice(available, 'fill');
  if (!available.length) {
    renderPager(ui.fillPager, 'fill', pageable);
    ui.rosterFillList.append(node('p', 'panel-empty',
      players.length
        ? (search ? 'No matching free players.' : 'Every approved player is already on today’s list.')
        : 'No approved players in the directory yet.'));
    return;
  }
  for (const player of pageable.items) {
    const row = node('div', 'fill-row');
    const head = node('div', 'fill-row-head');
    head.append(avatar(player));
    const info = node('div', 'person-info');
    info.append(node('strong', '', player.name || 'Unnamed player'));
    info.append(node('small', '', [player.skillLevel, player.division && player.division !== 'unspecified' ? player.division : ''].filter(Boolean).join(' · ') || 'Player'));
    info.append(node('small', 'player-record', recordLabel(player)));
    head.append(info);
    row.append(head);
    const actions = node('div', 'fill-row-actions');
    if (openSpots > 0) {
      actions.append(actionButton('Add & check in', 'reserve-checkin', player.id, 'button-primary'));
      actions.append(actionButton('Reserve', 'reserve', player.id, 'button-outline'));
    } else {
      actions.append(actionButton('Waitlist', 'reserve', player.id, 'button-primary'));
    }
    row.append(actions);
    ui.rosterFillList.append(row);
  }
  renderPager(ui.fillPager, 'fill', pageable);
}

function renderDirectory() {
  const search = ui.directorySearch.value.trim().toLowerCase();
  const available = players.filter((player) => {
    const text = `${player.name || ''} ${player.skillLevel || ''} ${player.division || ''}`.toLowerCase();
    return player.active && text.includes(search);
  });
  const activePlayerIds = rosteredPlayerIds();
  ui.directoryList.replaceChildren();
  const pageable = pageSlice(available, 'directory');
  if (!available.length) {
    renderPager(ui.directoryPager, 'directory', pageable);
    ui.directoryList.append(node('p', 'panel-empty', players.length ? 'No matching player found.' : 'No approved players in the directory yet.'));
    return;
  }
  for (const player of pageable.items) {
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
  renderPager(ui.directoryPager, 'directory', pageable);
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
  const pendingIds = new Set(pending.map((entry) => entry.id));
  for (const entryId of [...pendingSkillByEntry.keys()]) {
    if (!pendingIds.has(entryId)) pendingSkillByEntry.delete(entryId);
  }
  for (const entryId of [...pendingNameByEntry.keys()]) {
    if (!pendingIds.has(entryId)) pendingNameByEntry.delete(entryId);
  }
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
  if (ui.waitlistCount) ui.waitlistCount.textContent = String(waitlistCount);
  if (ui.waitlistBlock) ui.waitlistBlock.hidden = waitlist.length === 0;
  syncPendingBadges(pendingCount);
  renderList(ui.pendingList, pending, 'pending', 'No signup requests to review.');
  renderList(ui.confirmedList, confirmed, 'confirmed', 'No reserved players yet. Share the signup link or add a known player.', {
    pageKey: 'confirmed', pager: ui.confirmedPager,
  });
  if (ui.waitlistList) {
    renderList(ui.waitlistList, waitlist, 'waitlist', 'No players on the waitlist.', {
      pageKey: 'waitlist', pager: ui.waitlistPager,
    });
  }
  renderTodaySide(confirmed, waitlist, open);
  renderFillList();
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
  const hashView = location.hash.replace(/^#/, '');
  const pendingCount = snapshot.entries.filter((entry) => entry.status === 'pending').length;
  showView(VIEWS.includes(hashView) ? hashView : (pendingCount > 0 ? 'requests' : 'overview'));
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
  if (action === 'edit-entry-player') {
    openPlayerEditor(button.dataset.id);
    return;
  }
  if (action === 'pair') {
    openPartnerDialog(entryId);
    return;
  }
  if (action === 'unpair') {
    button.disabled = true;
    try {
      await setEntryPartner(session.id, entryId, null);
      await refreshDashboard();
      showAlert('Doubles pair cleared.', 'success');
    } catch (error) {
      showAlert(friendlyError(error));
    } finally {
      button.disabled = false;
    }
    return;
  }
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
    if (action === 'approve') {
      const skillSelect = button.closest('.entry-row')?.querySelector('select[data-skill-for]');
      const nameField = button.closest('.entry-row')?.querySelector('input[data-name-for]');
      const skillLevel = skillSelect?.value || pendingSkillByEntry.get(entryId);
      const name = (nameField?.value || pendingNameByEntry.get(entryId) || '').trim();
      if (nameField && nameField.value.trim().length < 2) {
        showAlert('Enter a name with at least 2 characters before approving.');
        nameField.focus();
        return;
      }
      await approveEntry(session.id, entryId, {
        ...(skillLevel ? { skillLevel } : {}),
        ...(name ? { name } : {}),
      });
      pendingSkillByEntry.delete(entryId);
      pendingNameByEntry.delete(entryId);
    } else {
      await fn(session.id, entryId);
    }
    await refreshDashboard();
    showAlert('Session updated.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
  } finally {
    button.disabled = false;
  }
}

function openPartnerDialog(entryId) {
  const entry = entries.find((item) => item.id === entryId);
  if (!entry?.playerId) return showAlert('Only saved player profiles can be paired.');
  const select = $('partnerPlayerInput');
  select.replaceChildren();
  const candidates = entries.filter((item) =>
    item.status === 'confirmed' && item.playerId && item.playerId !== entry.playerId);
  if (!candidates.length) return showAlert('Need another confirmed player to pair with.');
  for (const candidate of candidates) {
    const option = node('option', '', candidate.partnerPlayerId && candidate.partnerPlayerId !== entry.playerId
      ? `${candidate.name} (currently paired)`
      : candidate.name);
    option.value = candidate.playerId;
    if (candidate.playerId === entry.partnerPlayerId) option.selected = true;
    select.append(option);
  }
  $('partnerEntryInput').value = entryId;
  $('partnerDialogTitle').textContent = `Pair ${entry.name}`;
  $('partnerDialog').showModal();
}

$('cancelPartner')?.addEventListener('click', () => $('partnerDialog')?.close());
$('partnerForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!session) return;
  const save = $('savePartner');
  save.disabled = true;
  try {
    await setEntryPartner(session.id, $('partnerEntryInput').value, $('partnerPlayerInput').value);
    $('partnerDialog').close();
    await refreshDashboard();
    showAlert('Doubles partners locked for today’s draws.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
  } finally {
    save.disabled = false;
  }
});

for (const list of [ui.pendingList, ui.confirmedList, ui.waitlistList, ui.todayPlayersList, ui.todayWaitlistList]) {
  list?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) runEntryAction(button.dataset.action, button.dataset.id, button);
  });
}
function openPlayerEditor(playerId) {
  const player = players.find((item) => item.id === playerId);
  if (!player) return showAlert('Player profile not found.');
  $('playerDialogTitle').textContent = `Edit ${player.name}`;
  $('playerIdInput').value = player.id;
  $('playerNameInput').value = player.name || '';
  $('playerSkillInput').value = player.skillLevel || 'intermediate';
  $('playerDivisionInput').value = player.division || 'unspecified';
  $('playerDialog').showModal();
  $('playerNameInput').focus();
}

ui.gotoPlayers?.addEventListener('click', () => showView('roster'));
ui.directoryList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !session) return;
  if (button.dataset.action === 'edit-player') {
    openPlayerEditor(button.dataset.id);
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
ui.rosterSearch?.addEventListener('input', () => {
  listPages.fill = 1;
  renderFillList();
});
ui.rosterFillList?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !session) return;
  if (!['reserve', 'reserve-checkin'].includes(button.dataset.action)) return;
  button.disabled = true;
  try {
    const checkIn = button.dataset.action === 'reserve-checkin';
    const result = await reservePlayer(session.id, button.dataset.id, { checkIn });
    await refreshDashboard();
    if (result.entry?.checkedIn) showAlert('Player added and checked in.', 'success');
    else if (result.entry?.status === 'waitlisted') showAlert('Player added to the waitlist.', 'success');
    else showAlert('Player reserved for today.', 'success');
  } catch (error) {
    showAlert(friendlyError(error));
    button.disabled = false;
  }
});
ui.directorySearch.addEventListener('input', () => {
  listPages.directory = 1;
  renderDirectory();
});

for (const pager of [ui.confirmedPager, ui.waitlistPager, ui.fillPager, ui.directoryPager]) {
  pager?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const key = button.dataset.id;
    if (!Object.prototype.hasOwnProperty.call(listPages, key)) return;
    if (button.dataset.action === 'page-prev') listPages[key] = Math.max(1, listPages[key] - 1);
    if (button.dataset.action === 'page-next') listPages[key] += 1;
    if (key === 'confirmed' || key === 'waitlist') renderDashboard({ session, entries, players });
    else if (key === 'fill') renderFillList();
    else if (key === 'directory') renderDirectory();
  });
}

$('cancelPlayer').addEventListener('click', () => $('playerDialog').close());
$('playerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const save = $('savePlayer');
  save.disabled = true;
  try {
    await updatePlayer($('playerIdInput').value, {
      name: $('playerNameInput').value,
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

function openAddPlayerDialog() {
  if (!session) return showAlert('Load today’s session first.');
  $('addPlayerNameInput').value = '';
  $('addPlayerSkillInput').value = 'intermediate';
  $('addPlayerDivisionInput').value = 'unspecified';
  $('addPlayerReserveInput').checked = true;
  $('addPlayerCheckInInput').checked = false;
  $('addPlayerDialog').showModal();
  $('addPlayerNameInput').focus();
}

$('addPlayerButton')?.addEventListener('click', openAddPlayerDialog);
$('addPlayerDirectoryButton')?.addEventListener('click', openAddPlayerDialog);
$('cancelAddPlayer')?.addEventListener('click', () => $('addPlayerDialog')?.close());
$('addPlayerReserveInput')?.addEventListener('change', () => {
  if (!$('addPlayerReserveInput').checked) $('addPlayerCheckInInput').checked = false;
});
$('addPlayerCheckInInput')?.addEventListener('change', () => {
  if ($('addPlayerCheckInInput').checked) $('addPlayerReserveInput').checked = true;
});
$('addPlayerForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('addPlayerForm').reportValidity() || !session) return;
  const save = $('saveAddPlayer');
  save.disabled = true;
  try {
    const result = await createAndReservePlayer(session.id, {
      name: $('addPlayerNameInput').value,
      skillLevel: $('addPlayerSkillInput').value,
      division: $('addPlayerDivisionInput').value,
      reserve: $('addPlayerReserveInput').checked,
      checkIn: $('addPlayerCheckInInput').checked,
    });
    $('addPlayerDialog').close();
    await refreshDashboard();
    if (result.entry?.checkedIn) showAlert('Player created and checked in.', 'success');
    else if (result.entry?.status === 'waitlisted') showAlert('Player created and waitlisted.', 'success');
    else if (result.entry) showAlert('Player created and reserved for today.', 'success');
    else showAlert('Player saved to the directory.', 'success');
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

document.querySelector('.web-nav')?.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-view]');
  if (!link) return;
  event.preventDefault();
  showView(link.dataset.view);
});
document.querySelector('.mobile-nav')?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  showView(button.dataset.view);
});
window.addEventListener('hashchange', () => {
  const hashView = location.hash.replace(/^#/, '');
  if (VIEWS.includes(hashView) && hashView !== currentView) showView(hashView, { updateHash: false });
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
