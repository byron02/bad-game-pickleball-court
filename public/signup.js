import { getPublicSession, searchPlayers, submitSignup, watchMySignup } from '../src/firebaseStore.js';

const token = new URLSearchParams(location.search).get('token')?.trim();
if (token) document.querySelector('.brand').href = `/join?token=${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);
const elements = {
  alert: $('pageAlert'), sessionDate: $('sessionDate'), sessionState: $('sessionState'),
  confirmed: $('confirmedCount'), capacity: $('capacityCount'), fill: $('capacityFill'),
  capacityNote: $('capacityNote'), waitlistCount: $('waitlistCount'), joinBody: $('joinBody'),
  existingTab: $('existingTab'), newTab: $('newTab'), existingPanel: $('existingPanel'), newPanel: $('newPanel'),
  search: $('playerSearch'), results: $('searchResults'), selected: $('selectedPlayer'), existingSubmit: $('existingSubmit'),
  existingPhoto: $('existingPhoto'), existingPhotoPreview: $('existingPhotoPreview'),
  newForm: $('newPlayerForm'), newName: $('newName'), newSkill: $('newSkill'), newDivision: $('newDivision'), newPhoto: $('newPhoto'), photoPreview: $('photoPreview'),
  success: $('successPanel'), successTitle: $('successTitle'),
};

let currentSession = null;
let selectedPlayer = null;
let searchTimer = null;
let searchSequence = 0;
const photoPreviewUrls = new Map();

function showAlert(message) {
  elements.alert.textContent = message;
  elements.alert.hidden = false;
  elements.alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearAlert() {
  elements.alert.hidden = true;
  elements.alert.textContent = '';
}

function formatDate(value) {
  if (!value) return 'Open play';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date);
}

function setBadge(text, kind) {
  elements.sessionState.textContent = text;
  elements.sessionState.className = `badge badge-${kind}`;
}

function updateSession(session) {
  currentSession = session;
  const count = Number(session.confirmedCount ?? 0);
  const capacity = Number(session.capacity ?? 32);
  const spotsLeft = Number(session.spotsLeft ?? Math.max(0, capacity - count));
  const waitlist = Number(session.waitlistCount ?? 0);
  elements.sessionDate.textContent = formatDate(session.date);
  elements.confirmed.textContent = String(count);
  elements.capacity.textContent = String(capacity);
  elements.fill.style.width = `${Math.min(100, Math.round(count / Math.max(1, capacity) * 100))}%`;
  elements.capacityNote.textContent = spotsLeft > 0 ? `${spotsLeft} ${spotsLeft === 1 ? 'spot' : 'spots'} available after approval` : 'Confirmed spots full · join the waitlist';
  elements.waitlistCount.textContent = waitlist > 0 ? `${waitlist} on waitlist` : '';
  if (session.open === false) {
    setBadge('Closed', 'red');
    elements.joinBody.hidden = true;
    showAlert('Signups for this session are closed. Ask the organizer for the next open play link.');
  } else {
    setBadge(spotsLeft > 0 ? 'Open' : 'Waitlist open', spotsLeft > 0 ? 'green' : 'amber');
    elements.joinBody.hidden = !elements.success.hidden;
  }
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
}

function photoSource(value) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(?:jpeg|png|webp);base64,/i.test(value)) return value;
  if (/^https:\/\//i.test(value)) return value;
  return null;
}

function avatar(player) {
  const node = document.createElement('span');
  node.className = 'avatar';
  const source = photoSource(player.photoData || player.photoUrl);
  if (source) {
    const img = document.createElement('img');
    img.src = source;
    img.alt = '';
    node.append(img);
  } else {
    node.textContent = initials(player.name || '');
  }
  return node;
}

function renderResults(players, message = '') {
  elements.results.replaceChildren();
  if (!players.length) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = message || 'No player found. Use “I’m new” if this is your first visit.';
    elements.results.append(note);
    return;
  }
  for (const player of players) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `person-option${selectedPlayer?.id === player.id ? ' selected' : ''}`;
    option.append(avatar(player));
    const info = document.createElement('span');
    info.className = 'person-info';
    const name = document.createElement('strong');
    name.textContent = player.name;
    const skill = document.createElement('small');
    skill.textContent = player.skillLevel || 'Player';
    info.append(name, skill);
    option.append(info);
    option.addEventListener('click', () => {
      selectedPlayer = player;
      elements.selected.textContent = `Selected: ${player.name} · ${player.skillLevel || 'Player'}`;
      elements.selected.hidden = false;
      elements.existingSubmit.disabled = false;
      renderResults(players);
    });
    elements.results.append(option);
  }
}

async function performSearch() {
  const query = elements.search.value.trim();
  selectedPlayer = null;
  elements.selected.hidden = true;
  elements.existingSubmit.disabled = true;
  const sequence = ++searchSequence;
  if (query.length < 2) {
    renderResults([], 'Start typing at least two letters to search.');
    return;
  }
  renderResults([], 'Searching…');
  try {
    const { players = [] } = await searchPlayers(query);
    if (sequence === searchSequence) renderResults(players);
  } catch (error) {
    if (sequence === searchSequence) renderResults([], error.message || 'Search could not load. Try again.');
  }
}

function switchTab(kind) {
  const existing = kind === 'existing';
  elements.existingTab.classList.toggle('active', existing);
  elements.newTab.classList.toggle('active', !existing);
  elements.existingTab.setAttribute('aria-selected', String(existing));
  elements.newTab.setAttribute('aria-selected', String(!existing));
  elements.existingPanel.hidden = !existing;
  elements.newPanel.hidden = existing;
  clearAlert();
  (existing ? elements.search : elements.newName).focus();
}

function showSuccess(entry) {
  elements.joinBody.hidden = true;
  elements.success.hidden = false;
  const paragraph = elements.success.querySelector('p');
  if (entry?.status === 'waitlisted' || entry?.status === 'waitlist') {
    elements.successTitle.textContent = 'You’re on the waitlist';
    paragraph.textContent = 'You are on the waitlist. The organizer can confirm your spot when one opens.';
  } else if (entry?.status === 'confirmed') {
    elements.successTitle.textContent = 'Your spot is confirmed';
    paragraph.textContent = 'Your spot is confirmed. Please check in with the organizer when you arrive.';
  } else if (['rejected', 'removed', 'checked_out'].includes(entry?.status)) {
    elements.successTitle.textContent = 'Request closed';
    paragraph.textContent = 'The organizer did not confirm this signup. Please contact them if you think this was a mistake.';
  } else {
    elements.successTitle.textContent = 'Request sent!';
    paragraph.textContent = 'Your signup is awaiting organizer review. Once approved, you’ll have a confirmed spot or a place on the waitlist.';
  }
  elements.success.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function handleSignup(details, button) {
  clearAlert();
  if (!currentSession) return showAlert('The session is still loading. Please try again.');
  const oldText = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Sending request…';
  try {
    const { entry } = await submitSignup({ sessionId: currentSession.id, ...details });
    showSuccess(entry);
    try {
      const { session } = await getPublicSession(token);
      if (session) updateSession(session);
    } catch { /* The request was saved; counts can refresh on the next visit. */ }
  } catch (error) {
    showAlert(error.message || 'Could not send the request. Please try again.');
  } finally {
    button.innerHTML = oldText;
    button.disabled = button === elements.existingSubmit ? !selectedPlayer : false;
  }
}

async function compressPhoto(file) {
  if (!file) return null;
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.');

  const image = await createImageBitmap(file);
  const maxSide = 512;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  for (const quality of [.78, .65, .52, .4, .3]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    // Base64 expands binary size by about one third.
    if (data.length <= 115_000) return data;
  }
  throw new Error('This photo is too detailed to upload. Try a smaller photo.');
}

elements.existingTab.addEventListener('click', () => switchTab('existing'));
elements.newTab.addEventListener('click', () => switchTab('new'));
elements.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(performSearch, 260);
});
elements.existingSubmit.addEventListener('click', async () => {
  if (!selectedPlayer) return;
  elements.existingSubmit.disabled = true;
  elements.existingSubmit.textContent = 'Preparing photo…';
  try {
    const photoData = await compressPhoto(elements.existingPhoto.files?.[0]);
    await handleSignup({ playerId: selectedPlayer.id, ...(photoData ? { photoData } : {}) }, elements.existingSubmit);
  } catch (error) {
    showAlert(error.message || 'Could not prepare your photo.');
  } finally {
    elements.existingSubmit.disabled = !selectedPlayer;
    elements.existingSubmit.innerHTML = 'Request my spot <span aria-hidden="true">→</span>';
  }
});
function previewPhoto(input, preview) {
  input.addEventListener('change', () => {
    const oldUrl = photoPreviewUrls.get(input);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    const file = input.files?.[0];
    preview.replaceChildren();
    if (!file) {
      preview.textContent = '+';
      return;
    }
    const url = URL.createObjectURL(file);
    photoPreviewUrls.set(input, url);
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    preview.append(image);
  });
}
previewPhoto(elements.existingPhoto, elements.existingPhotoPreview);
previewPhoto(elements.newPhoto, elements.photoPreview);
elements.newForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!elements.newForm.reportValidity()) return;
  const name = elements.newName.value.trim().replace(/\s+/g, ' ');
  if (name.length < 2) return showAlert('Please enter your full name.');
  const button = elements.newForm.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = 'Preparing photo…';
  try {
    const photoData = await compressPhoto(elements.newPhoto.files?.[0]);
    await handleSignup({ name, skillLevel: elements.newSkill.value, division: elements.newDivision.value, ...(photoData ? { photoData } : {}) }, button);
  } catch (error) {
    showAlert(error.message || 'Could not prepare your photo.');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Send request <span aria-hidden="true">→</span>';
  }
});
if (!token) {
  elements.joinBody.hidden = true;
  elements.sessionDate.textContent = 'Signup link needed';
  setBadge('Unavailable', 'red');
  showAlert('This link is missing its session token. Ask the organizer to share the current signup link.');
} else {
  try {
    const { session } = await getPublicSession(token);
    updateSession(session);
    await watchMySignup(session.id, (entryOrError) => {
      if (entryOrError instanceof Error) {
        showAlert(entryOrError.message);
      } else if (entryOrError) {
        showSuccess(entryOrError);
      }
    });
  } catch (error) {
    elements.joinBody.hidden = true;
    elements.sessionDate.textContent = 'Session unavailable';
    setBadge('Unavailable', 'red');
    showAlert(error.message || 'This signup link is invalid or has expired. Ask the organizer for a new link.');
  }
}
