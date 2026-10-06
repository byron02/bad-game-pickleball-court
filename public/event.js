import { getPublicEvent, submitEventSignup, watchMyEventSignup } from '../src/eventStore.js';
import { searchPlayers } from '../src/firebaseStore.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token')?.trim();
const ui = {
  alert: $('eventAlert'), title: $('eventTitle'), kind: $('eventKind'), description: $('eventDescription'),
  facts: $('eventFacts'), capacityCard: $('eventCapacityCard'), approved: $('eventApprovedCount'),
  capacity: $('eventCapacity'), fill: $('eventCapacityFill'), capacityNote: $('eventCapacityNote'),
  state: $('eventState'), missingLink: $('eventMissingLink'), closed: $('eventSignupClosed'),
  form: $('eventSignupForm'), participantForms: $('eventParticipantForms'), signupMode: $('eventSignupMode'),
  joinIndividual: $('eventJoinIndividual'), joinTeam: $('eventJoinTeam'), teamHelp: $('eventTeamHelp'), teamName: $('eventTeamName'),
  teamNameLabel: $('eventTeamNameLabel'), submit: $('eventSubmit'), signupIntro: $('eventSignupIntro'),
  signupStatus: $('eventSignupStatus'), statusTitle: $('eventStatusTitle'), statusCopy: $('eventStatusCopy'),
  records: $('eventPublicRecords'), roster: $('eventRoster'), rosterCount: $('eventRosterTabCount'),
  standings: $('eventStandings'), matches: $('eventMatches'), refresh: $('eventRefresh'),
};

let currentEvent = null;
let participantStates = [];
let signupCount = 1;
let ownRequest = null;
let lastStatus = null;

function showAlert(message) {
  ui.alert.textContent = message;
  ui.alert.hidden = false;
  ui.alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearAlert() {
  ui.alert.hidden = true;
  ui.alert.textContent = '';
}

function formattedDate(value, time) {
  if (!value) return 'Date to be announced';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const result = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  return time ? `${result} · ${time}` : result;
}

function titleCase(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fact(text) {
  const item = document.createElement('span');
  item.className = 'event-fact';
  item.textContent = text;
  ui.facts.append(item);
}

function isFixedTeam(event) {
  return event.discipline === 'doubles' && event.teamMode === 'fixed';
}

function displayPrize(prize) {
  if (!prize) return '';
  if (typeof prize === 'string') return prize;
  if (typeof prize.description === 'string' && prize.description.trim()) return prize.description.trim();
  if (prize.amount != null) return `Prize: ${prize.amount}${prize.currency ? ` ${prize.currency}` : ''}`;
  return '';
}

function setEvent(event) {
  const formWasSet = participantStates.length > 0;
  currentEvent = event;
  document.title = `${event.title || 'Game event'} · Bad Game Pickleball Courts`;
  ui.kind.textContent = event.kind === 'tournament' ? 'Bad Game · Tournament' : 'Bad Game · Open play event';
  ui.title.textContent = event.title || 'Game event';
  ui.description.textContent = formattedDate(event.date, event.startTime);
  ui.facts.replaceChildren();
  fact(event.kind === 'tournament' ? 'Tournament' : 'Open play');
  if (event.discipline) fact(titleCase(event.discipline));
  if (event.format) fact(titleCase(event.format));
  if (event.teamMode === 'fixed') fact('Fixed teams');
  if (event.teamMode === 'draw_once') fact('Teams drawn by organizer');
  if (event.teamMode === 'rotating') fact('Rotating partners');
  if (event.scoreTarget) fact(`Play to ${event.scoreTarget}`);
  if (event.bestOf) fact(`Best of ${event.bestOf}`);
  const prize = displayPrize(event.prize);
  if (prize) fact(prize);
  if (Array.isArray(event.champions) && event.champions.length) {
    fact(`Champion${event.champions.length > 1 ? 's' : ''}: ${event.champions.map((item) => item.name).filter(Boolean).join(' & ')}`);
  }

  const approved = Number(event.approvedCount || 0);
  const capacity = Number(event.capacity || 0);
  const remaining = Math.max(0, capacity - approved);
  ui.capacityCard.hidden = false;
  ui.approved.textContent = String(approved);
  ui.capacity.textContent = String(capacity);
  ui.fill.style.width = `${capacity ? Math.min(100, Math.round(100 * approved / capacity)) : 0}%`;
  ui.capacityNote.textContent = event.open === false
    ? 'Signups are closed.'
    : remaining > 0
      ? `${remaining} ${remaining === 1 ? 'spot' : 'spots'} available after approval${event.waitlistCount ? ` · ${event.waitlistCount} waiting` : ''}`
      : `Spots full · join the waitlist${event.waitlistCount ? ` (${event.waitlistCount} waiting)` : ''}`;
  ui.state.textContent = event.open === false ? 'Closed' : remaining > 0 ? 'Open' : 'Waitlist open';
  ui.state.className = `badge badge-${event.open === false ? 'red' : remaining > 0 ? 'green' : 'amber'}`;
  ui.signupIntro.textContent = isFixedTeam(event)
    ? 'Request a spot for yourself, or enter both doubles partners in one request. The organizer reviews each request.'
    : 'Choose an existing player profile or make a new one. The organizer reviews each request.';
  ui.closed.hidden = event.open !== false || Boolean(ownRequest);
  ui.form.hidden = event.open === false || Boolean(ownRequest);
  if (!formWasSet) {
    const fixedTeam = isFixedTeam(event);
    createParticipantForms(fixedTeam ? 2 : 1);
    ui.signupMode.hidden = !fixedTeam;
    setSignupMode(false);
  }
}

function avatar(player) {
  const node = document.createElement('span');
  node.className = 'avatar';
  const source = player?.photoData || player?.photoUrl;
  if (typeof source === 'string' && (/^data:image\/(?:jpeg|png|webp);base64,/i.test(source) || /^https:\/\//i.test(source))) {
    const image = document.createElement('img');
    image.src = source;
    image.alt = '';
    node.append(image);
  } else {
    node.textContent = String(player?.name || '?').split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
  }
  return node;
}

function createParticipantForms(count) {
  ui.participantForms.replaceChildren();
  participantStates = [];
  for (let index = 0; index < count; index += 1) {
    const section = document.createElement('section');
    section.className = 'event-participant';
    section.innerHTML = `
      <div class="event-participant-head"><h3>${count === 2 ? `Partner ${index + 1}` : 'Player'}</h3><span>Choose a profile</span></div>
      <div class="event-choice-switch" role="group" aria-label="Partner ${index + 1} profile type">
        <button class="event-choice active" type="button" data-kind="existing" aria-pressed="true">I've played here</button>
        <button class="event-choice" type="button" data-kind="new" aria-pressed="false">I'm new</button>
      </div>
      <div class="event-existing-fields">
        <label class="field-label" for="eventSearch${index}">Find player profile</label>
        <input id="eventSearch${index}" class="input event-player-search" type="search" autocomplete="off" maxlength="60" placeholder="Search first or last name">
        <div class="event-search-results" aria-live="polite"><p class="empty-note">Type at least two letters to search.</p></div>
        <div class="selected-player event-selected" hidden></div>
      </div>
      <div class="event-new-fields" hidden>
        <label class="field-label" for="eventName${index}">Full name</label>
        <input id="eventName${index}" class="input event-new-name" type="text" autocomplete="name" minlength="2" maxlength="60" placeholder="e.g. Maria Santos">
        <label class="field-label" for="eventSkill${index}">Skill level</label>
        <select id="eventSkill${index}" class="input event-new-skill">
          <option value="">Select your level</option><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
        </select>
        <label class="field-label" for="eventDivision${index}">Division eligibility <span class="optional">optional</span></label>
        <select id="eventDivision${index}" class="input event-new-division"><option value="unspecified">Prefer not to specify</option><option value="woman">Woman</option><option value="man">Man</option></select>
        <label class="field-label" for="eventPhoto${index}">Photo <span class="optional">optional</span></label>
        <input id="eventPhoto${index}" class="event-new-photo" type="file" accept="image/jpeg,image/png,image/webp">
        <p class="field-help">JPG, PNG, or WebP. Max 5 MB.</p>
      </div>`;
    const state = {
      section, mode: 'existing', selected: null, sequence: 0, timer: null,
      existing: section.querySelector('.event-existing-fields'), newer: section.querySelector('.event-new-fields'),
      search: section.querySelector('.event-player-search'), results: section.querySelector('.event-search-results'),
      selectedLabel: section.querySelector('.event-selected'), name: section.querySelector('.event-new-name'),
      skill: section.querySelector('.event-new-skill'), division: section.querySelector('.event-new-division'),
      photo: section.querySelector('.event-new-photo'),
    };
    section.querySelectorAll('.event-choice').forEach((button) => button.addEventListener('click', () => {
      state.mode = button.dataset.kind;
      state.existing.hidden = state.mode !== 'existing';
      state.newer.hidden = state.mode !== 'new';
      section.querySelectorAll('.event-choice').forEach((choice) => {
        const active = choice === button;
        choice.classList.toggle('active', active);
        choice.setAttribute('aria-pressed', String(active));
      });
    }));
    state.search.addEventListener('input', () => {
      clearTimeout(state.timer);
      state.sequence += 1;
      state.selected = null;
      state.selectedLabel.hidden = true;
      const term = state.search.value.trim();
      if (term.length < 2) return renderSearchResults(state, [], 'Type at least two letters to search.');
      renderSearchResults(state, [], 'Searching…');
      const sequence = state.sequence;
      state.timer = setTimeout(async () => {
        try {
          const { players = [] } = await searchPlayers(term);
          if (sequence === state.sequence) renderSearchResults(state, players);
        } catch (cause) {
          if (sequence === state.sequence) renderSearchResults(state, [], cause.message || 'Search unavailable. Try again.');
        }
      }, 250);
    });
    ui.participantForms.append(section);
    participantStates.push(state);
  }
}

function setSignupMode(asTeam) {
  signupCount = asTeam && participantStates.length === 2 ? 2 : 1;
  if (participantStates[1]) participantStates[1].section.hidden = signupCount !== 2;
  const firstHeading = participantStates[0]?.section.querySelector('.event-participant-head h3');
  if (firstHeading) firstHeading.textContent = signupCount === 2 ? 'Partner 1' : 'Player';
  ui.teamName.hidden = signupCount !== 2;
  ui.teamNameLabel.hidden = signupCount !== 2;
  ui.teamHelp.hidden = signupCount !== 2;
  ui.joinIndividual.classList.toggle('active', signupCount === 1);
  ui.joinIndividual.setAttribute('aria-pressed', String(signupCount === 1));
  ui.joinTeam.classList.toggle('active', signupCount === 2);
  ui.joinTeam.setAttribute('aria-pressed', String(signupCount === 2));
}

ui.joinIndividual.addEventListener('click', () => setSignupMode(false));
ui.joinTeam.addEventListener('click', () => setSignupMode(true));

function renderSearchResults(state, players, message = '') {
  state.results.replaceChildren();
  if (!players.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = message || 'No player found. Choose “I’m new” if this is your first event.';
    state.results.append(note);
    return;
  }
  for (const player of players) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'person-option';
    button.append(avatar(player));
    const label = document.createElement('span');
    label.className = 'person-info';
    const name = document.createElement('strong');
    name.textContent = player.name || 'Player';
    const skill = document.createElement('small');
    skill.textContent = player.skillLevel || 'Player';
    label.append(name, skill);
    button.append(label);
    button.addEventListener('click', () => {
      state.selected = player;
      state.selectedLabel.textContent = `Selected: ${player.name} · ${titleCase(player.skillLevel)}`;
      state.selectedLabel.hidden = false;
      state.results.querySelectorAll('button').forEach((option) => option.classList.toggle('selected', option === button));
    });
    state.results.append(button);
  }
}

async function compressPhoto(file) {
  if (!file) return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const quality of [.78, .65, .52, .4, .3]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= 115_000) return data;
  }
  throw new Error('This photo is too detailed to upload. Try a smaller photo.');
}

async function signupPlayers() {
  const players = [];
  for (const [index, state] of participantStates.slice(0, signupCount).entries()) {
    if (state.mode === 'existing') {
      if (!state.selected) throw new Error(`Select ${signupCount === 2 ? `partner ${index + 1}` : 'your player'} profile.`);
      players.push({ playerId: state.selected.id });
    } else {
      if (state.name.value.trim().length < 2 || !state.skill.value) {
        (state.name.value.trim().length < 2 ? state.name : state.skill).focus();
        throw new Error(`Enter ${signupCount === 2 ? `partner ${index + 1}` : 'your'} name and skill level.`);
      }
      players.push({
        name: state.name.value.trim().replace(/\s+/g, ' '),
        skillLevel: state.skill.value,
        division: state.division.value,
        ...(state.photo.files?.[0] ? { photoData: await compressPhoto(state.photo.files[0]) } : {}),
      });
    }
  }
  if (players.length === 2) {
    const first = players[0];
    const second = players[1];
    if (first.playerId && first.playerId === second.playerId) throw new Error('Choose two different partners.');
    if (first.name && second.name && first.name.toLowerCase() === second.name.toLowerCase()) throw new Error('Enter two different partner names.');
  }
  return players;
}

function showOwnRequest(request) {
  ownRequest = request;
  const status = request?.status || request?.registration?.status || 'pending';
  const team = (request?.players?.length || signupCount) === 2;
  ui.form.hidden = true;
  ui.closed.hidden = true;
  ui.signupStatus.hidden = false;
  if (status === 'confirmed') {
    ui.statusTitle.textContent = team ? 'Your team is confirmed' : 'Your spot is confirmed';
    ui.statusCopy.textContent = team ? 'Both partners are confirmed. Check in with the organizer when you arrive.' : 'Your reservation is confirmed. Check in with the organizer when you arrive.';
  } else if (status === 'waitlisted' || status === 'waitlist') {
    ui.statusTitle.textContent = team ? 'Your team is on the waitlist' : 'You’re on the waitlist';
    ui.statusCopy.textContent = team ? 'Both partners are approved and will move in together when two spots open.' : 'Your request is approved. The organizer will move you in when a spot opens.';
  } else if (['rejected', 'removed', 'cancelled'].includes(status)) {
    ui.statusTitle.textContent = 'Request closed';
    ui.statusCopy.textContent = 'Please contact the organizer if you think this was a mistake.';
  } else {
    ui.statusTitle.textContent = 'Request sent!';
    ui.statusCopy.textContent = 'The organizer is reviewing your request. Approved players receive a spot or a place on the waitlist.';
  }
  if (lastStatus !== status) ui.statusTitle.focus({ preventScroll: true });
  lastStatus = status;
}

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentEvent) return;
  clearAlert();
  const label = ui.submit.innerHTML;
  ui.submit.disabled = true;
  ui.submit.textContent = 'Sending request…';
  try {
    const players = await signupPlayers();
    const response = await submitEventSignup({ eventId: currentEvent.id, players, ...(players.length === 2 && ui.teamName.value.trim() ? { teamName: ui.teamName.value.trim() } : {}) });
    showOwnRequest(response?.registration || response?.entry || response || { status: 'pending' });
    // The request is saved even if this optional count refresh cannot load.
    await refreshEvent(false).catch(() => {});
  } catch (cause) {
    showAlert(cause.message || 'Could not send your request. Please try again.');
  } finally {
    ui.submit.disabled = false;
    ui.submit.innerHTML = label;
  }
});

function emptyState(message) {
  const note = document.createElement('p');
  note.className = 'event-empty';
  note.textContent = message;
  return note;
}

function rosterLabel(registration) {
  const players = Array.isArray(registration.players) ? registration.players : [];
  return registration.teamName || players.map((player) => player.name).filter(Boolean).join(' & ') || 'Player';
}

function renderRoster(registrations = []) {
  ui.roster.replaceChildren();
  const visible = registrations.filter((item) => ['confirmed', 'waitlisted', 'waitlist'].includes(item.status));
  ui.rosterCount.textContent = visible.length ? String(visible.length) : '';
  if (!visible.length) return ui.roster.append(emptyState('No approved entrants yet. Check back after the organizer reviews signups.'));
  for (const registration of visible) {
    const row = document.createElement('div');
    row.className = 'event-roster-row';
    const people = document.createElement('div');
    people.className = 'event-roster-people';
    for (const player of registration.players || []) people.append(avatar(player));
    const info = document.createElement('div');
    info.className = 'event-roster-info';
    const name = document.createElement('strong');
    name.textContent = rosterLabel(registration);
    info.append(name);
    if (registration.teamName && (registration.players || []).length) {
      const memberNames = document.createElement('small');
      memberNames.textContent = registration.players.map((player) => player.name).join(' & ');
      info.append(memberNames);
    } else if (registration.players?.[0]?.skillLevel) {
      const skill = document.createElement('small');
      skill.textContent = titleCase(registration.players[0].skillLevel);
      info.append(skill);
    }
    const badge = document.createElement('span');
    badge.className = `badge badge-${registration.status === 'confirmed' ? 'green' : 'amber'}`;
    badge.textContent = registration.status === 'confirmed' ? registration.checkedIn ? 'Checked in' : 'Confirmed' : 'Waitlist';
    row.append(people, info, badge);
    ui.roster.append(row);
  }
}

function renderStandings(standings = []) {
  ui.standings.replaceChildren();
  if (!standings.length) return ui.standings.append(emptyState('Standings will appear after matches are recorded.'));
  const wrap = document.createElement('div');
  wrap.className = 'event-table-wrap';
  const table = document.createElement('table');
  table.className = 'event-table';
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th scope="col">Rank</th><th scope="col">Entrant</th><th scope="col">W–L</th><th scope="col">Point diff.</th><th scope="col">Points</th></tr>';
  table.append(head);
  const body = document.createElement('tbody');
  for (const [index, row] of standings.entries()) {
    const tr = document.createElement('tr');
    const values = [row.rank ?? index + 1, row.name || 'Entrant', `${row.wins || 0}–${row.losses || 0}`, row.pointDiff ?? 0, row.pointsFor ?? 0];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  ui.standings.append(wrap);
}

function sideText(side, labels) {
  if (side == null) return 'To be decided';
  if (Array.isArray(side)) return side.map((item) => sideText(item, labels)).join(' & ');
  if (typeof side === 'string') return labels.get(side) || side;
  if (typeof side === 'object') {
    if (side.name) return side.name;
    if (side.teamName) return side.teamName;
    if (Array.isArray(side.players)) return side.players.map((player) => player.name || labels.get(player.id || player.playerId) || 'Player').join(' & ');
    if (side.id) return labels.get(side.id) || side.id;
  }
  return 'To be decided';
}

function scoreText(score) {
  const games = Array.isArray(score) ? score : Array.isArray(score?.games) ? score.games : [];
  if (games.length) return games.map((game) => `${game.a ?? game.sideA ?? '–'}–${game.b ?? game.sideB ?? '–'}`).join(', ');
  return '';
}

function renderMatches(matches = [], registrations = []) {
  ui.matches.replaceChildren();
  if (!matches.length) return ui.matches.append(emptyState('The organizer has not published a match schedule yet.'));
  const labels = new Map();
  for (const registration of registrations) {
    labels.set(registration.id, rosterLabel(registration));
    for (const player of registration.players || []) labels.set(player.id || player.playerId, player.name);
  }
  const stageOrder = { round_robin: 0, rotating_doubles: 0, knockout: 1, final: 2 };
  const sorted = [...matches].sort((a, b) =>
    (stageOrder[a.stage] ?? 3) - (stageOrder[b.stage] ?? 3) ||
    String(a.poolId || '').localeCompare(String(b.poolId || '')) ||
    Number(a.round || 0) - Number(b.round || 0) ||
    Number(a.slot || 0) - Number(b.slot || 0));
  let previousRound = '';
  for (const match of sorted) {
    const group = `${match.stage || ''}:${match.poolId || ''}:${match.round || 1}`;
    if (group !== previousRound) {
      const heading = document.createElement('h3');
      heading.className = 'event-round-label';
      const stage = match.stage === 'round_robin' ? 'Round robin' : match.stage === 'rotating_doubles' ? 'Rotating doubles' : match.stage === 'knockout' ? 'Knockout' : 'Matches';
      heading.textContent = `${stage}${match.poolId ? ` · Pool ${match.poolId}` : ''} · Round ${match.round || 1}`;
      ui.matches.append(heading);
      previousRound = group;
    }
    const item = document.createElement('article');
    item.className = 'event-match-card';
    const meta = document.createElement('div');
    meta.className = 'event-match-meta';
    const round = document.createElement('strong');
    round.textContent = `${match.stage === 'round_robin' ? 'Round robin' : match.stage === 'knockout' ? 'Knockout' : 'Round'} ${match.round || 1}${match.poolId ? ` · Pool ${match.poolId}` : ''}`;
    const court = document.createElement('span');
    court.textContent = match.courtName || titleCase(match.status || 'pending');
    meta.append(round, court);
    const sideA = match.sideA ?? match.sides?.[0] ?? match.sidePlayerIds?.[0];
    const sideB = match.sideB ?? match.sides?.[1] ?? match.sidePlayerIds?.[1];
    const matchup = document.createElement('div');
    matchup.className = 'event-matchup';
    const left = document.createElement('span');
    left.textContent = sideText(sideA, labels);
    const versus = document.createElement('small');
    versus.textContent = 'vs';
    const right = document.createElement('span');
    right.textContent = sideText(sideB, labels);
    if (match.winnerSide === 0 || match.winnerSide === 'A' || (match.winnerId && match.winnerId === (sideA?.id || sideA))) left.classList.add('winner');
    if (match.winnerSide === 1 || match.winnerSide === 'B' || (match.winnerId && match.winnerId === (sideB?.id || sideB))) right.classList.add('winner');
    matchup.append(left, versus, right);
    item.append(meta, matchup);
    const score = scoreText(match.score);
    if (score) {
      const result = document.createElement('p');
      result.className = 'event-score';
      result.textContent = `Score: ${score}`;
      item.append(result);
    }
    ui.matches.append(item);
  }
}

function setRecords(payload) {
  ui.records.hidden = false;
  renderRoster(payload.registrations || []);
  renderStandings(payload.standings || []);
  renderMatches(payload.matches || [], payload.registrations || []);
}

async function refreshEvent(showError = true) {
  if (!token) return;
  ui.refresh.disabled = true;
  try {
    const payload = await getPublicEvent(token);
    if (!payload?.event) throw new Error('This event link is unavailable. Ask the organizer for the current link.');
    setEvent(payload.event);
    setRecords(payload);
    if (showError) clearAlert();
  } catch (cause) {
    if (showError) showAlert(cause.message || 'Could not load this event. Please try again.');
    throw cause;
  } finally {
    ui.refresh.disabled = false;
  }
}

ui.refresh.addEventListener('click', () => { void refreshEvent().catch(() => {}); });
document.querySelectorAll('.event-record-tab').forEach((tab) => tab.addEventListener('click', () => {
  const view = tab.dataset.view;
  document.querySelectorAll('.event-record-tab').forEach((button) => {
    const active = button === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('eventRosterPanel').hidden = view !== 'roster';
  $('eventStandingsPanel').hidden = view !== 'standings';
  $('eventMatchesPanel').hidden = view !== 'matches';
}));

if (!token) {
  ui.title.textContent = 'Get the event link.';
  ui.description.textContent = 'The organizer shares a unique signup link for each event.';
  ui.kind.textContent = 'Bad Game · Game events';
  ui.missingLink.hidden = false;
} else {
  document.querySelector('.brand').href = `/event?token=${encodeURIComponent(token)}`;
  try {
    await refreshEvent();
    await watchMyEventSignup(currentEvent.id, (requestOrError) => {
      if (requestOrError instanceof Error) {
        showAlert(requestOrError.message || 'Could not check your signup status.');
      } else if (requestOrError) {
        showOwnRequest(requestOrError);
      }
    });
    setInterval(() => {
      if (!document.hidden) void refreshEvent(false).catch(() => {});
    }, 60_000);
  } catch {
    ui.title.textContent = 'Event unavailable';
    ui.description.textContent = 'Please check the link or ask the organizer for a new one.';
    ui.form.hidden = true;
    ui.closed.hidden = true;
  }
}
