import * as events from '../src/eventStore.js';
import {
  getCurrentUser, searchAdminPlayers, signInOrganizerWithGoogle, signOutOrganizer,
} from '../src/firebaseStore.js';
import { listCourts } from '../src/courtStore.js';
import { initCourtsUI } from './courts-ui.js';

const $ = (id) => document.getElementById(id);
const ui = {
  alert: $('eventAdminAlert'), loading: $('eventLoading'), loadingMessage: $('eventLoadingMessage'),
  auth: $('eventAuth'), app: $('eventApp'), signOut: $('eventSignOut'),
  list: $('eventList'), empty: $('eventEmpty'), detail: $('eventDetail'),
  createDialog: $('createEventDialog'), createForm: $('createEventForm'),
  participantDialog: $('addEventPlayersDialog'), participantForms: $('eventParticipantForms'),
};
let listedEvents = [];
let selectedId = null;
let detail = null;
let courts = [];
let loadSequence = 0;
let participantStates = [];
const READ_TIMEOUT = 25_000;

function element(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}
function button(label, action, id, style = 'button-outline') {
  const control = element('button', `button button-small ${style}`, label);
  control.type = 'button';
  control.dataset.action = action;
  control.dataset.id = id;
  return control;
}
function formatDate(value) {
  if (!value) return 'Date not set';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'long', day: 'numeric', year: 'numeric',
  }).format(date);
}
function dateInManila() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (name) => parts.find((item) => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function label(value) { return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function showAlert(message, kind = 'error') {
  ui.alert.textContent = message;
  ui.alert.classList.toggle('success', kind === 'success');
  ui.alert.hidden = false;
  ui.alert.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function clearAlert() { ui.alert.hidden = true; ui.alert.textContent = ''; }
function readWithTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Firebase is taking too long. Check your connection and retry.')), READ_TIMEOUT); }),
  ]).finally(() => clearTimeout(timer));
}
function emptyNote(message) { return element('p', 'panel-empty', message); }
function signupUrl(event) { return event.signupUrl || `${location.origin}/event?token=${encodeURIComponent(event.id)}`; }

async function copyCurrentLink() {
  if (!detail) return;
  try {
    await navigator.clipboard.writeText(signupUrl(detail.event));
    showAlert('Event signup link copied.', 'success');
  } catch {
    showAlert(`Copy this signup link: ${signupUrl(detail.event)}`);
  }
}

function showAuth(message = '') {
  ui.loading.hidden = true;
  ui.app.hidden = true;
  ui.auth.hidden = false;
  ui.signOut.hidden = false;
  if (message) showAlert(message);
}
function showApp() {
  ui.loading.hidden = true;
  ui.auth.hidden = true;
  ui.app.hidden = false;
  ui.signOut.hidden = false;
}

function renderEventList() {
  ui.list.replaceChildren();
  if (!listedEvents.length) {
    ui.list.append(emptyNote('No events yet. Create one to open signups.'));
    return;
  }
  for (const event of listedEvents) {
    const item = button('', 'select-event', event.id, 'button-outline');
    item.className = `event-admin-list-item${event.id === selectedId ? ' selected' : ''}`;
    const top = element('span', 'event-admin-list-top');
    top.append(element('strong', '', event.title), element('span', 'badge badge-blue', label(event.status)));
    item.append(top, element('small', '', `${formatDate(event.date)} · ${event.startTime || '09:00'}`),
      element('small', '', `${event.approvedCount || 0}/${event.capacity} players · ${label(event.kind)}`));
    ui.list.append(item);
  }
}

async function refreshList(preferredId = selectedId) {
  const result = await readWithTimeout(events.listEvents());
  listedEvents = result.events || [];
  selectedId = listedEvents.some((item) => item.id === preferredId) ? preferredId : listedEvents[0]?.id || null;
  renderEventList();
  if (selectedId) await loadEvent(selectedId);
  else {
    detail = null;
    ui.empty.hidden = false;
    ui.detail.hidden = true;
    courtUI.dispose();
  }
}

async function loadEvent(eventId) {
  const request = ++loadSequence;
  selectedId = eventId;
  renderEventList();
  ui.empty.hidden = true;
  ui.detail.hidden = false;
  $('eventMatches').replaceChildren(emptyNote('Loading matches…'));
  try {
    const [snapshot, courtResult] = await Promise.all([
      readWithTimeout(events.getAdminEvent(eventId)),
      readWithTimeout(listCourts()),
    ]);
    if (request !== loadSequence) return;
    detail = snapshot;
    courts = courtResult.courts || [];
    history.replaceState(null, '', `/events-admin?id=${encodeURIComponent(eventId)}`);
    renderDetail();
    await courtUI.refresh(snapshot.event.kind === 'open_play' ? eventId : null);
  } catch (cause) {
    if (request !== loadSequence) return;
    showAlert(cause.message || 'Could not load this event.');
    ui.empty.hidden = false;
    ui.detail.hidden = true;
  }
}

function participantText(registration) {
  const players = registration.players || [];
  return players.map((player) => player.name || 'Player').join(' + ') || 'Player';
}
function participantMeta(registration) {
  const skills = (registration.players || []).map((player) => label(player.skillLevel)).filter(Boolean);
  return [registration.teamName || '', ...skills].filter(Boolean).join(' · ');
}
function registrationRow(registration) {
  const row = element('article', 'entry-row event-admin-registration');
  const body = element('div', 'entry-body');
  const top = element('div', 'entry-top');
  top.append(element('strong', '', participantText(registration)));
  const tone = registration.status === 'confirmed' ? 'green' : registration.status === 'waitlisted' ? 'amber' : 'blue';
  top.append(element('span', `badge badge-${tone}`, label(registration.status)));
  body.append(top, element('p', 'entry-meta', participantMeta(registration)));
  const actions = element('div', 'entry-actions');
  if (registration.status === 'pending') {
    actions.append(button('Approve', 'approve', registration.id, 'button-primary'),
      button('Reject', 'reject', registration.id, 'button-danger-outline'));
  } else if (registration.status === 'confirmed') {
    actions.append(button(registration.checkedIn ? 'Check out' : 'Check in',
      registration.checkedIn ? 'check-out' : 'check-in', registration.id));
    actions.append(button('Remove', 'remove', registration.id, 'button-danger-outline'));
  } else if (registration.status === 'waitlisted') {
    actions.append(button('Remove', 'remove', registration.id, 'button-danger-outline'));
  }
  body.append(actions);
  row.append(body);
  return row;
}
function renderRegistrationList(id, registrations, message) {
  const list = $(id);
  list.replaceChildren(...(registrations.length ? registrations.map(registrationRow) : [emptyNote(message)]));
}

function renderTeams() {
  const event = detail.event;
  const isDoubles = event.discipline === 'doubles';
  const canEdit = event.status === 'registration';
  $('eventTeamControls').hidden = !isDoubles || event.teamMode === 'rotating';
  $('drawEventTeams').hidden = event.teamMode !== 'draw_once';
  $('drawEventTeams').disabled = !canEdit;
  $('saveEventTeam').disabled = !canEdit;
  $('eventTeamControls').querySelector('.event-admin-team-form').hidden = !isDoubles || event.teamMode === 'rotating';
  const players = (detail.registrations || []).filter((registration) => registration.status === 'confirmed')
    .flatMap((registration) => registration.players || []).filter((player) => player.playerId);
  const teams = detail.teams || [];
  const assigned = new Set(teams.flatMap((team) => team.playerIds || []));
  const unpaired = players.filter((player) => !assigned.has(player.playerId));
  $('saveEventTeam').disabled = !canEdit || unpaired.length < 2;
  for (const field of [$('teamPlayerOne'), $('teamPlayerTwo')]) {
    const selected = field.value;
    field.replaceChildren(new Option('Choose player', ''));
    for (const player of unpaired) field.append(new Option(player.name, player.playerId));
    field.value = unpaired.some((player) => player.playerId === selected) ? selected : '';
  }
  const area = $('eventTeams');
  area.replaceChildren();
  const nameOf = (id) => players.find((player) => player.playerId === id)?.name || 'Player';
  if (!teams.length) area.append(element('p', 'field-help', 'No teams saved yet.'));
  else for (const team of teams) {
    area.append(element('div', 'event-admin-team-row', `${team.name || 'Team'} · ${(team.playerIds || []).map(nameOf).join(' + ')}`));
  }
}

function matchSideNames(match, index) {
  const ids = match.sidePlayerIds?.[index] ||
    (Array.isArray(match.sides?.[index]) ? match.sides[index] : []);
  const players = (detail.registrations || []).flatMap((registration) => registration.players || []);
  const playerName = (id) => players.find((player) => player.playerId === id)?.name ||
    detail.entries?.find((entry) => entry.playerId === id)?.name || id;
  if (ids.length) return ids.map(playerName).join(' + ');
  const entrantId = match.sides?.[index];
  if (typeof entrantId === 'string') {
    const team = detail.teams?.find((item) => item.id === entrantId);
    if (team) return team.name || (team.playerIds || []).map(playerName).join(' + ');
    return playerName(entrantId);
  }
  return 'To be decided';
}
function scoreText(match) {
  return (match.score?.games || []).map((game) => `${game.a}–${game.b}`).join(', ');
}
function scoreForm(match) {
  const form = element('form', 'event-admin-score-form');
  form.dataset.matchId = match.id;
  form.dataset.kind = match.status === 'completed' ? 'correct' : 'record';
  const count = Number(detail.event.bestOf) === 3 ? 3 : 1;
  const games = match.score?.games || [];
  for (let index = 0; index < count; index += 1) {
    const row = element('div', 'event-admin-score-row');
    row.append(element('span', '', `Game ${index + 1}`));
    for (const side of ['a', 'b']) {
      const field = element('input', 'input');
      field.type = 'number';
      field.min = '0';
      field.max = '99';
      field.step = '1';
      field.inputMode = 'numeric';
      field.setAttribute('aria-label', `Game ${index + 1}, side ${side.toUpperCase()} points`);
      field.dataset.side = side;
      field.value = games[index]?.[side] ?? '';
      row.append(field);
    }
    form.append(row);
  }
  const submit = element('button', 'button button-primary button-small', match.status === 'completed' ? 'Correct score' : 'Record result');
  submit.type = 'submit';
  form.append(submit);
  return form;
}
function renderMatches() {
  const area = $('eventMatches');
  area.replaceChildren();
  const matches = detail.matches || [];
  if (!matches.length) return area.append(emptyNote('No matches yet. Start the schedule after players are ready.'));
  let lastRound = null;
  for (const match of matches) {
    const round = match.round === 'final' ? 'Final' : `Round ${match.round || 1}`;
    if (round !== lastRound) {
      area.append(element('h3', 'event-admin-round-label', round));
      lastRound = round;
    }
    const card = element('article', 'event-admin-match-card');
    const meta = element('div', 'event-admin-match-meta');
    meta.append(element('strong', '', `Match ${match.slot || match.id}`),
      element('span', `badge badge-${match.status === 'completed' ? 'green' : match.status === 'active' ? 'blue' : 'neutral'}`, label(match.status)));
    card.append(meta);
    if (match.poolId) card.append(element('small', 'event-admin-pool', `Pool ${match.poolId}`));
    const sides = element('div', 'event-admin-match-sides');
    const a = element('div', match.winnerSide === 'A' ? 'winner' : '', `A · ${matchSideNames(match, 0)}`);
    const b = element('div', match.winnerSide === 'B' ? 'winner' : '', `B · ${matchSideNames(match, 1)}`);
    sides.append(a, b);
    card.append(sides);
    if (match.score?.games?.length) card.append(element('p', 'event-admin-saved-score', `Score: ${scoreText(match)}`));
    if (match.status !== 'bye' && match.status !== 'completed') {
      const courtField = element('select', 'input event-admin-court-select');
      courtField.dataset.matchId = match.id;
      courtField.setAttribute('aria-label', `Court for ${match.id}`);
      courtField.append(new Option('Choose a court', ''));
      for (const court of courts) courtField.append(new Option(court.name, court.id));
      courtField.value = match.courtId || '';
      card.append(courtField);
    } else if (match.courtName) card.append(element('small', 'event-admin-court-name', match.courtName));
    if (match.status === 'ready' || match.status === 'pending') {
      const start = button('Start match', 'start-match', match.id, 'button-outline');
      start.disabled = match.status !== 'ready';
      card.append(start);
    }
    if (match.status === 'active' || match.status === 'completed') card.append(scoreForm(match));
    if (match.status === 'active') card.append(button('Cancel match', 'cancel-match', match.id, 'button-danger-outline'));
    area.append(card);
  }
}

function renderStandings() {
  const area = $('eventStandings');
  area.replaceChildren();
  if (!(detail.standings || []).length) return area.append(emptyNote('Standings appear after players are confirmed.'));
  const table = element('table', 'event-admin-table');
  const head = element('thead');
  const header = element('tr');
  for (const text of ['#', 'Player', 'W', 'L', '+/−']) header.append(element('th', '', text));
  head.append(header);
  const body = element('tbody');
  for (const row of detail.standings) {
    const tr = element('tr');
    for (const value of [row.rank, row.name || row.id, row.wins || 0, row.losses || 0, row.pointDiff ?? row.pointDifference ?? 0]) {
      tr.append(element('td', '', String(value)));
    }
    body.append(tr);
  }
  table.append(head, body);
  area.append(table);
}
function renderAudit() {
  const area = $('eventActivity');
  if (!area) return;
  area.replaceChildren();
  const audit = detail.audit || [];
  if (!audit.length) return area.append(emptyNote('Activity will appear as the event progresses.'));
  for (const entry of audit.slice(0, 30)) {
    const row = element('div', 'event-admin-activity-row');
    const at = entry.at?.toDate?.() || (entry.at ? new Date(entry.at) : null);
    row.append(element('strong', '', label(entry.action)),
      element('span', '', at && !Number.isNaN(at.getTime()) ? at.toLocaleString() : ''));
    area.append(row);
  }
}

function renderDetail() {
  if (!detail) return;
  const event = detail.event;
  const registrations = detail.registrations || [];
  const pending = registrations.filter((item) => item.status === 'pending');
  const confirmed = registrations.filter((item) => item.status === 'confirmed');
  const waiting = registrations.filter((item) => item.status === 'waitlisted');
  const confirmedCount = confirmed.reduce((total, item) => total + (item.players?.length || 1), 0);
  const checkedInCount = confirmed.filter((item) => item.checkedIn).reduce((total, item) => total + (item.players?.length || 1), 0);
  $('eventTitle').textContent = event.title;
  $('eventType').textContent = `${label(event.kind)} · ${label(event.discipline)}`;
  $('eventDate').textContent = `${formatDate(event.date)} at ${event.startTime || '09:00'}`;
  $('eventStatus').textContent = label(event.status);
  $('eventStatus').className = `badge badge-${event.status === 'completed' ? 'green' : 'blue'}`;
  $('eventConfirmed').textContent = `${confirmedCount}/${event.capacity}`;
  $('eventCheckedIn').textContent = String(checkedInCount);
  $('eventPending').textContent = String(pending.length);
  $('eventWaitlisted').textContent = String(waiting.reduce((total, item) => total + (item.players?.length || 1), 0));
  $('eventShareUrl').textContent = signupUrl(event);
  const champions = (event.champions || []).map((champion) => {
    if (typeof champion === 'object' && champion !== null) return champion.name || champion.playerId;
    return registrations.flatMap((registration) => registration.players || [])
      .find((player) => player.playerId === champion)?.name || champion;
  });
  $('eventPrize').textContent = [
    champions.length ? `Winner${champions.length > 1 ? 's' : ''}: ${champions.join(' + ')}` : '',
    event.prize ? `Prize: ${event.prize}` : 'No prize recorded.',
  ].filter(Boolean).join(' · ');
  $('addEventPlayerButton').disabled = !event.open;
  renderRegistrationList('eventPendingList', pending, 'No requests waiting for review.');
  renderRegistrationList('eventConfirmedList', confirmed, 'No confirmed players yet.');
  renderRegistrationList('eventWaitlistList', waiting, 'The waitlist is empty.');
  const tournament = event.kind === 'tournament';
  $('eventTournamentControls').hidden = !tournament;
  $('eventTournamentResults').hidden = !tournament;
  $('eventOpenPlayCourts').hidden = tournament;
  if (tournament) {
    $('eventFormatDescription').textContent = `${label(event.format)} · ${label(event.teamMode)} teams · ${event.scoreTarget} points · best of ${event.bestOf}`;
    $('startEventSchedule').disabled = event.status !== 'registration';
    $('advanceEventRound').disabled = event.status !== 'in_progress';
    $('finishEvent').disabled = event.status !== 'in_progress';
    renderTeams();
    renderMatches();
    renderStandings();
  } else {
    $('startOpenEvent').hidden = event.status !== 'registration';
    $('finishOpenEvent').hidden = event.status !== 'in_progress';
  }
  renderAudit();
}

const courtUI = initCourtsUI({
  getSession: () => detail?.event.kind === 'open_play' ? { id: detail.event.id } : null,
  getEntries: () => detail?.entries || [],
  showAlert,
  refreshRoster: async () => { if (selectedId) await loadEvent(selectedId); },
});

async function runMutation(control, action, success) {
  control.disabled = true;
  try {
    await action();
    if (selectedId) {
      await refreshList(selectedId);
    }
    showAlert(success, 'success');
  } catch (cause) {
    showAlert(cause.message || 'Could not update this event.');
  } finally {
    control.disabled = false;
  }
}

ui.list.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action="select-event"]');
  if (control) loadEvent(control.dataset.id);
});
for (const id of ['eventPendingList', 'eventConfirmedList', 'eventWaitlistList']) {
  $(id).addEventListener('click', (event) => {
    const control = event.target.closest('button[data-action]');
    if (!control || !selectedId) return;
    const registrationId = control.dataset.id;
    const action = control.dataset.action;
    const selected = detail.registrations.find((item) => item.id === registrationId);
    if (action === 'reject' && !confirm(`Reject ${participantText(selected)}?`)) return;
    if (action === 'remove' && !confirm(`Remove ${participantText(selected)}? A waitlisted team may be promoted.`)) return;
    const operations = {
      approve: () => events.approveEventSignup(selectedId, registrationId),
      reject: () => events.rejectEventSignup(selectedId, registrationId),
      'check-in': () => events.checkInEventSignup(selectedId, registrationId, true),
      'check-out': () => events.checkInEventSignup(selectedId, registrationId, false),
      remove: () => events.removeEventSignup(selectedId, registrationId),
    };
    runMutation(control, operations[action], 'Event roster updated.');
  });
}

function updateCreateFields() {
  const tournament = $('newEventKind').value === 'tournament';
  const singles = $('newEventDiscipline').value === 'singles';
  const rotating = $('newEventTeamMode').value === 'rotating' && !singles;
  if (rotating) $('newEventFormat').value = 'round_robin';
  $('newEventTournamentFields').hidden = !tournament;
  $('newEventTeamMode').previousElementSibling.hidden = singles;
  $('newEventTeamMode').hidden = singles;
  $('newEventFormat').querySelector('[value="single_elimination"]').disabled = rotating;
  const roundRobin = $('newEventFormat').value === 'round_robin';
  $('newEventRoundRobinFields').hidden = !roundRobin;
  $('newEventRounds').hidden = !rotating || !roundRobin;
  $('newEventRounds').previousElementSibling.hidden = !rotating || !roundRobin;
  const over32 = Number($('newEventCapacity').value) > 32;
  if (over32 && roundRobin) $('newEventRoundRobinMode').value = 'pools';
  $('newEventRoundRobinMode').querySelector('[value="full"]').disabled = over32;
  $('newEventPoolSize').disabled = !roundRobin || $('newEventRoundRobinMode').value !== 'pools';
}

for (const id of ['newEventKind', 'newEventDiscipline', 'newEventTeamMode', 'newEventFormat', 'newEventRoundRobinMode', 'newEventCapacity']) {
  $(id).addEventListener('change', updateCreateFields);
}
$('createEventButton').addEventListener('click', () => {
  clearAlert();
  ui.createForm.reset();
  $('newEventDate').value = dateInManila();
  $('newEventTime').value = '09:00';
  $('newEventCapacity').value = '32';
  updateCreateFields();
  ui.createDialog.showModal();
});
$('cancelCreateEvent').addEventListener('click', () => ui.createDialog.close());
ui.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('submitCreateEvent');
  submit.disabled = true;
  const settings = {
    title: $('newEventTitle').value.trim(), date: $('newEventDate').value,
    startTime: $('newEventTime').value, kind: $('newEventKind').value,
    capacity: Number($('newEventCapacity').value),
    discipline: $('newEventDiscipline').value,
    format: $('newEventFormat').value,
    teamMode: $('newEventDiscipline').value === 'singles' ? 'fixed' : $('newEventTeamMode').value,
    roundRobinMode: $('newEventRoundRobinMode').value,
    poolSize: Number($('newEventPoolSize').value), rounds: Number($('newEventRounds').value),
    scoreTarget: Number($('newEventScoreTarget').value), bestOf: Number($('newEventBestOf').value),
    prize: $('newEventPrize').value.trim(),
  };
  try {
    const result = await events.createEvent(settings);
    ui.createDialog.close();
    await refreshList(result.event.id);
    showAlert('Event created. Share its signup link with your players.', 'success');
  } catch (cause) {
    showAlert(cause.message || 'Could not create the event.');
  } finally {
    submit.disabled = false;
  }
});

async function compressPlayerPhoto(file) {
  if (!file) return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('Choose a JPG, PNG, or WebP photo smaller than 5 MB.');
  }
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
  throw new Error('This photo is too detailed. Try a smaller photo.');
}

function participantForm(index) {
  const section = element('section', 'event-admin-participant');
  section.innerHTML = `<h3>Player ${index + 1}</h3><label class="field-label" for="eventSource${index}">Choose player</label><select id="eventSource${index}" class="input"><option value="existing">Existing player</option><option value="new">New player</option></select><div class="event-admin-existing"><label class="field-label" for="eventSearch${index}">Search the player database</label><input id="eventSearch${index}" class="input" type="search" autocomplete="off" placeholder="Search by name"><div class="event-admin-search-results"></div><p class="event-admin-selected field-help">No player selected</p></div><div class="event-admin-new" hidden><label class="field-label" for="eventName${index}">Full name</label><input id="eventName${index}" class="input" minlength="2" maxlength="60" placeholder="Player name"><label class="field-label" for="eventSkill${index}">Skill level</label><select id="eventSkill${index}" class="input"><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select><label class="field-label" for="eventDivision${index}">Division eligibility</label><select id="eventDivision${index}" class="input"><option value="unspecified">Open play</option><option value="woman">Woman</option><option value="man">Man</option></select><label class="field-label" for="eventPhoto${index}">Photo (optional)</label><input id="eventPhoto${index}" type="file" accept="image/jpeg,image/png,image/webp"></div>`;
  const source = section.querySelector('select');
  const existing = section.querySelector('.event-admin-existing');
  const fresh = section.querySelector('.event-admin-new');
  const search = section.querySelector('input[type="search"]');
  const results = section.querySelector('.event-admin-search-results');
  const selected = section.querySelector('.event-admin-selected');
  const state = { section, source, selectedPlayer: null, timer: null, request: 0 };
  source.addEventListener('change', () => {
    existing.hidden = source.value !== 'existing';
    fresh.hidden = source.value !== 'new';
  });
  async function findPlayers() {
    const request = ++state.request;
    results.replaceChildren(emptyNote('Searching players…'));
    try {
      const response = await searchAdminPlayers(search.value);
      if (request !== state.request) return;
      results.replaceChildren();
      if (!response.players?.length) return results.append(emptyNote('No matching players. Choose New player above.'));
      for (const player of response.players) {
        const pick = element('button', 'event-admin-search-result');
        pick.type = 'button';
        pick.textContent = `${player.name} · ${label(player.skillLevel)}`;
        pick.addEventListener('click', () => {
          state.selectedPlayer = player;
          selected.textContent = `Selected: ${player.name}`;
          search.value = player.name;
          results.replaceChildren();
        });
        results.append(pick);
      }
    } catch (cause) {
      if (request === state.request) results.replaceChildren(emptyNote(cause.message || 'Search failed.'));
    }
  }
  search.addEventListener('input', () => {
    state.selectedPlayer = null;
    selected.textContent = 'No player selected';
    clearTimeout(state.timer);
    state.timer = setTimeout(findPlayers, 250);
  });
  findPlayers();
  return state;
}

$('addEventPlayerButton').addEventListener('click', () => {
  if (!detail) return;
  const fixedDouble = detail.event.discipline === 'doubles' && detail.event.teamMode === 'fixed';
  $('addEventModeLabel').hidden = !fixedDouble;
  $('addEventMode').hidden = !fixedDouble;
  $('addEventMode').value = fixedDouble ? 'team' : 'individual';
  rebuildParticipantForms();
  ui.participantDialog.showModal();
});
function rebuildParticipantForms() {
  const fixedDouble = detail?.event.discipline === 'doubles' && detail.event.teamMode === 'fixed';
  const count = fixedDouble && $('addEventMode').value === 'team' ? 2 : 1;
  ui.participantForms.replaceChildren();
  participantStates = [];
  for (let index = 0; index < count; index += 1) {
    const state = participantForm(index);
    participantStates.push(state);
    ui.participantForms.append(state.section);
  }
  $('addEventPlayersTitle').textContent = count === 2 ? 'Add a doubles team' : 'Add a player';
  $('addEventTeamName').previousElementSibling.hidden = !fixedDouble;
  $('addEventTeamName').hidden = count !== 2;
  $('addEventTeamName').previousElementSibling.hidden = count !== 2;
  $('addEventTeamName').value = '';
}
$('addEventMode').addEventListener('change', rebuildParticipantForms);
$('cancelAddEventPlayers').addEventListener('click', () => ui.participantDialog.close());
$('addEventPlayersForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedId) return;
  const control = $('submitAddEventPlayers');
  control.disabled = true;
  try {
    const players = [];
    for (const state of participantStates) {
      if (state.source.value === 'existing') {
        if (!state.selectedPlayer) throw new Error('Select each existing player from the search results.');
        players.push({ playerId: state.selectedPlayer.id });
      } else {
        const section = state.section;
        players.push({
          name: section.querySelector('input[id^="eventName"]').value.trim(),
          skillLevel: section.querySelector('select[id^="eventSkill"]').value,
          division: section.querySelector('select[id^="eventDivision"]').value,
          photoData: await compressPlayerPhoto(section.querySelector('input[type="file"]').files?.[0]),
        });
      }
    }
    const ids = players.map((player) => player.playerId).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error('Choose two different players.');
    await events.addEventPlayers(selectedId, players, $('addEventTeamName').value.trim());
    ui.participantDialog.close();
    await refreshList(selectedId);
    showAlert('Player registration added to this event.', 'success');
  } catch (cause) {
    showAlert(cause.message || 'Could not add players.');
  } finally {
    control.disabled = false;
  }
});

$('saveEventTeam').addEventListener('click', (event) => {
  const ids = [$('teamPlayerOne').value, $('teamPlayerTwo').value];
  if (ids.some((value) => !value) || ids[0] === ids[1]) return showAlert('Choose two different players for the team.');
  runMutation(event.currentTarget,
    () => events.saveEventTeam(selectedId, { playerIds: ids, name: $('teamName').value.trim() }),
    'Team saved.');
});
$('drawEventTeams').addEventListener('click', (event) => {
  if (!confirm('Draw teams from the confirmed players now?')) return;
  runMutation(event.currentTarget, () => events.drawEventTeams(selectedId), 'Teams drawn.');
});
$('startEventSchedule').addEventListener('click', (event) => {
  if (!confirm('Start the tournament schedule using the confirmed players and teams?')) return;
  runMutation(event.currentTarget, () => events.startEventSchedule(selectedId), 'Tournament schedule started.');
});
$('advanceEventRound').addEventListener('click', (event) => {
  runMutation(event.currentTarget, () => events.advanceEventRound(selectedId), 'Next round generated.');
});
$('finishEvent').addEventListener('click', (event) => {
  if (!confirm('Finish this event and record the champion? Results will remain in the event history.')) return;
  runMutation(event.currentTarget, () => events.finishEvent(selectedId), 'Event finished and winners recorded.');
});
$('startOpenEvent').addEventListener('click', (event) => {
  runMutation(event.currentTarget, () => events.startEventSchedule(selectedId), 'Open play event started.');
});
$('finishOpenEvent').addEventListener('click', (event) => {
  if (!confirm('Finish this open-play event? Saved games will remain in the event history.')) return;
  runMutation(event.currentTarget, () => events.finishEvent(selectedId), 'Open play event finished.');
});
$('eventMatches').addEventListener('change', (event) => {
  const field = event.target.closest('select[data-match-id]');
  if (!field) return;
  const previous = detail.matches.find((match) => match.id === field.dataset.matchId)?.courtId || '';
  if (!field.value) { field.value = previous; return; }
  runMutation(field,
    () => events.assignEventMatchCourt(selectedId, field.dataset.matchId, field.value),
    'Court assigned.');
});
$('eventMatches').addEventListener('click', (event) => {
  const control = event.target.closest('button[data-action="start-match"], button[data-action="cancel-match"]');
  if (!control) return;
  if (control.dataset.action === 'cancel-match') {
    if (!confirm('Cancel this active match? No win or loss will be recorded.')) return;
    runMutation(control, () => events.cancelEventMatch(selectedId, control.dataset.id), 'Match cancelled; court and players released.');
  } else {
    runMutation(control, () => events.startEventMatch(selectedId, control.dataset.id), 'Match started.');
  }
});
$('eventMatches').addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-match-id]');
  if (!form) return;
  event.preventDefault();
  const games = [];
  for (const row of form.querySelectorAll('.event-admin-score-row')) {
    const a = row.querySelector('[data-side="a"]').value.trim();
    const b = row.querySelector('[data-side="b"]').value.trim();
    if (!a && !b) continue;
    if (!a || !b) return showAlert('Enter both sides of every played game.');
    games.push({ a: Number(a), b: Number(b) });
  }
  if (!games.length) return showAlert('Enter a match score first.');
  if (form.dataset.kind === 'correct' && !confirm('Correct this recorded score? The event record and player stats will be updated.')) return;
  const submit = form.querySelector('[type="submit"]');
  const operation = form.dataset.kind === 'correct' ? events.correctEventMatch : events.recordEventMatch;
  runMutation(submit, () => operation(selectedId, form.dataset.matchId, { games }),
    form.dataset.kind === 'correct' ? 'Score corrected.' : 'Result recorded.');
});

$('refreshEvents').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { await refreshList(); clearAlert(); }
  catch (cause) { showAlert(cause.message || 'Could not refresh events.'); }
  finally { event.currentTarget.disabled = false; }
});
for (const id of ['copyEventLink', 'copyEventLinkSecondary']) $(id).addEventListener('click', copyCurrentLink);
$('eventGoogleSignIn').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try {
    await signInOrganizerWithGoogle();
    clearAlert();
    showApp();
    await refreshList(new URLSearchParams(location.search).get('id'));
  } catch (cause) { showAlert(cause.message || 'Could not sign in.'); }
  finally { event.currentTarget.disabled = false; }
});
ui.signOut.addEventListener('click', async () => {
  await signOutOrganizer();
  detail = null;
  selectedId = null;
  courtUI.dispose();
  showAuth();
});

async function boot() {
  try {
    const user = await readWithTimeout(getCurrentUser());
    if (!user || user.isAnonymous) return showAuth();
    showApp();
    await refreshList(new URLSearchParams(location.search).get('id'));
  } catch (cause) {
    if (cause.code === 'auth-required' || cause.code === 'permission-denied') showAuth(cause.message);
    else {
      ui.loading.hidden = true;
      showAlert(cause.message || 'Could not load events.');
      $('eventReload').hidden = false;
    }
  }
}
boot();
