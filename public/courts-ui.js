import {
  cancelCourtGame, completeCourtGame, deleteCourt, listCourtGames, listCourts,
  proposeCourtLineup, replaceCourtPlayer, saveCourt, startCourtGame,
} from '../src/courtStore.js';

const $ = (id) => document.getElementById(id);
const label = (value) => String(value || '').replace(/\b\w/g, (letter) => letter.toUpperCase());
const el = (tag, className, content) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
};

function button(text, action, id, style = 'button-outline') {
  const item = el('button', `button button-small ${style}`, text);
  item.type = 'button';
  item.dataset.courtAction = action;
  item.dataset.id = id;
  return item;
}

export function initCourtsUI({ getSession, getEntries, showAlert, refreshRoster }) {
  const grid = $('courtGrid');
  const history = $('matchHistory');
  const form = $('courtForm');
  const dialog = $('courtDialog');
  const replacementDialog = $('replacementDialog');
  const manualDialog = $('manualLineupDialog');
  const manualForm = $('manualLineupForm');
  let sessionId = null;
  let courts = [];
  let games = [];
  const previews = new Map();
  let manualSubmitIntent = 'save';

  function nameFor(id, game) {
    const snapshot = game?.playerSnapshots?.[id];
    return snapshot?.name || getEntries().find((entry) => entry.playerId === id)?.name || 'Player';
  }

  function playerLabel(id, game, previewPlayers = []) {
    const fromPreview = previewPlayers.find((player) => player.id === id);
    const name = fromPreview?.name || nameFor(id, game);
    const gamesPlayed = Number(fromPreview?.gamesPlayed || 0);
    const entry = getEntries().find((item) => item.playerId === id);
    const partner = entry?.partnerPlayerId
      ? getEntries().find((item) => item.playerId === entry.partnerPlayerId)?.name
      : null;
    if (!fromPreview) return partner ? `${name} (with ${partner})` : name;
    const games = `${gamesPlayed} ${gamesPlayed === 1 ? 'game' : 'games'}`;
    return partner ? `${name} · ${games} · with ${partner}` : `${name} · ${games}`;
  }

  function teamRow(side, ids, game, previewPlayers = []) {
    const row = el('div', 'court-side');
    row.append(el('strong', '', `Side ${side}`));
    row.append(el('span', '', ids.map((id) => playerLabel(id, game, previewPlayers)).join(' + ')));
    return row;
  }

  function matchContent(lineup, game, previewPlayers = []) {
    const area = el('div', 'court-match');
    area.append(teamRow('A', lineup.sideA, game, previewPlayers));
    area.append(el('div', 'court-vs', 'VS'));
    area.append(teamRow('B', lineup.sideB, game, previewPlayers));
    return area;
  }

  function poolBanner(pool) {
    const banner = el('div', 'court-pool');
    if (!pool) {
      banner.textContent = 'Checking who is waiting…';
      return banner;
    }
    const waiting = Number(pool.waiting || 0);
    const onCourt = Number(pool.onCourt || 0);
    const eligible = Number(pool.eligible || 0);
    banner.append(el('strong', '', `${waiting} waiting`));
    banner.append(el('span', '', '·'));
    banner.append(el('strong', '', `${onCourt} on court`));
    banner.append(el('span', '', '·'));
    banner.append(el('span', '', `${eligible} eligible here`));
    return banner;
  }

  function nextGameBlock(preview, { whilePlaying = false } = {}) {
    const box = el('div', 'court-next');
    box.append(el('span', 'label-overline', whilePlaying ? 'Up next' : 'Next game'));
    if (preview?.lineup) {
      box.append(el('p', 'court-next-copy', whilePlaying
        ? 'Waiting players queued for when this match ends. Prioritizes fewer games.'
        : 'Prioritizes players with fewer games so far.'));
      box.append(matchContent(preview.lineup, null, preview.players || []));
    } else {
      const needed = Number(preview?.pool?.needed || 4);
      const eligible = Number(preview?.pool?.eligible || 0);
      box.append(el('p', 'court-next-copy',
        eligible < needed
          ? `Need ${needed - eligible} more eligible checked-in player${needed - eligible === 1 ? '' : 's'} for this court’s rules.`
          : 'Not enough eligible players right now.'));
    }
    return box;
  }

  function updateCourtKpis() {
    const waitingEl = $('courtWaitingMetric');
    const playingEl = $('courtPlayingMetric');
    const availableEl = $('courtAvailableMetric');
    const availableNames = $('courtAvailableNames');
    if (!waitingEl || !playingEl || !availableEl) return;

    const sample = [...previews.values()].find((item) => item?.pool) || null;
    const waiting = Number(sample?.pool?.waiting ?? 0);
    const playing = Number(sample?.pool?.onCourt ?? 0);
    const freeCourts = courts.filter((court) =>
      !games.some((game) => game.courtId === court.id && game.status === 'active'));

    waitingEl.textContent = String(waiting);
    playingEl.textContent = String(playing);
    availableEl.textContent = String(freeCourts.length);
    if (availableNames) {
      if (!courts.length) {
        availableNames.textContent = 'Add a court to start assigning matches';
      } else if (!freeCourts.length) {
        availableNames.textContent = 'All courts are playing right now';
      } else if (freeCourts.length === courts.length) {
        availableNames.textContent = freeCourts.map((court) => court.name).join(', ');
      } else {
        availableNames.textContent = `Open: ${freeCourts.map((court) => court.name).join(', ')}`;
      }
    }
  }

  function render() {
    updateCourtKpis();
    grid.replaceChildren();
    if (!courts.length) {
      grid.append(el('p', 'panel-empty', 'Add Court 1 to set its skill levels and division. Each court can start separately.'));
    } else for (const court of courts) {
      const active = games.find((game) => game.courtId === court.id && game.status === 'active');
      const latest = games.find((game) => game.courtId === court.id && game.status === 'completed');
      const preview = previews.get(court.id);
      const card = el('article', 'court-card');
      const top = el('div', 'court-card-top');
      const title = el('div');
      title.append(el('h3', '', court.name));
      title.append(el('p', '', active ? 'Match in progress' : 'Ready for the next draw'));
      top.append(title, el('span', `badge badge-${active ? 'green' : 'blue'}`, active ? 'Playing' : 'Ready'));
      card.append(top);

      const settings = el('div', 'court-settings');
      settings.append(el('span', '', label(court.format)));
      settings.append(el('span', '', court.division === 'open' ? 'Open teams' : `${label(court.division)} teams`));
      for (const skill of court.allowedSkills) settings.append(el('span', '', label(skill)));
      card.append(settings);

      const actions = el('div', 'court-actions');
      card.append(poolBanner(preview?.pool));
      if (active) {
        card.append(matchContent(active.lineup, active));
        card.append(nextGameBlock(preview, { whilePlaying: true }));
        actions.append(button('Side A wins', 'win-a', active.id, 'button-primary'));
        actions.append(button('Side B wins', 'win-b', active.id, 'button-primary'));
        actions.append(button('Replace player', 'replace', active.id));
        if (preview?.lineup) {
          actions.append(button('Shuffle next', 'draw', court.id));
          actions.append(button('Clear next', 'clear-draw', court.id, 'button-quiet'));
        } else {
          actions.append(button('Draw next game', 'draw', court.id));
        }
        actions.append(button('Cancel game', 'cancel-game', active.id, 'button-quiet'));
      } else {
        card.append(nextGameBlock(preview));
        if (preview?.lineup) {
          actions.append(button('Start this court', 'start', court.id, 'button-primary'));
          actions.append(button('Shuffle next', 'draw', court.id));
          actions.append(button('Manual lineup', 'manual', court.id));
          actions.append(button('Clear draw', 'clear-draw', court.id, 'button-quiet'));
        } else {
          actions.append(button('Draw next game', 'draw', court.id, 'button-primary'));
          actions.append(button('Manual lineup', 'manual', court.id));
        }
        actions.append(button('Settings', 'edit', court.id, 'button-quiet'));
        if (!preview?.lineup) actions.append(button('Delete', 'delete', court.id, 'button-quiet'));
        if (latest?.result?.winnerSide) {
          card.append(el('p', 'court-last', `Last result: Side ${latest.result.winnerSide} won.`));
        }
      }
      card.append(actions);
      grid.append(card);
    }
    history.replaceChildren();
    const results = games.filter((game) => game.status === 'completed' && game.result?.winnerSide)
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).slice(0, 10);
    if (!results.length) {
      history.append(el('p', 'panel-empty', 'No results recorded yet.'));
      return;
    }
    for (const game of results) {
      const winnerIds = game.lineup[game.result.winnerSide === 'A' ? 'sideA' : 'sideB'];
      const loserIds = game.lineup[game.result.winnerSide === 'A' ? 'sideB' : 'sideA'];
      const row = el('article', 'result-row');
      const title = el('strong', '', game.courtName || 'Court');
      const detail = el('span', '', `${winnerIds.map((id) => nameFor(id, game)).join(' + ')} beat ${loserIds.map((id) => nameFor(id, game)).join(' + ')}`);
      row.append(title, detail);
      history.append(row);
    }
  }

  async function refreshPreviews() {
    // Propose for every court, including ones currently playing, so organizers
    // can see who is up next while the live match is still on.
    await Promise.all(courts.map(async (court) => {
      try {
        const preview = await proposeCourtLineup({
          sessionId,
          courtId: court.id,
          // Stable-ish seed keeps the suggested next game from jumping on every refresh.
          random: () => 0.37,
        });
        previews.set(court.id, preview);
      } catch {
        previews.set(court.id, { lineup: null, players: [], pool: { waiting: 0, onCourt: 0, eligible: 0, needed: 4 } });
      }
    }));
  }

  async function refresh(nextSessionId = getSession()?.id) {
    if (!nextSessionId) return;
    if (sessionId !== nextSessionId) {
      sessionId = nextSessionId;
      previews.clear();
    }
    const [courtResult, gameResult] = await Promise.all([
      listCourts(), listCourtGames(sessionId),
    ]);
    courts = courtResult.courts;
    games = gameResult.games;
    await refreshPreviews();
    render();
  }

  function openCourtDialog(court = null) {
    $('courtDialogTitle').textContent = court ? `Settings · ${court.name}` : 'Add court';
    $('courtIdInput').value = court?.id || '';
    $('courtNameInput').value = court?.name || '';
    $('courtFormatInput').value = court?.format || 'doubles';
    $('courtDivisionInput').value = court?.division || 'open';
    for (const checkbox of form.querySelectorAll('input[name="courtSkill"]')) {
      checkbox.checked = court ? court.allowedSkills.includes(checkbox.value) : true;
    }
    dialog.showModal();
    $('courtNameInput').focus();
  }

  $('addCourtButton').addEventListener('click', () => openCourtDialog());
  $('cancelCourt').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const allowedSkills = [...form.querySelectorAll('input[name="courtSkill"]:checked')]
      .map((item) => item.value);
    if (!allowedSkills.length) return showAlert('Select at least one skill level for the court.');
    const save = $('saveCourt');
    save.disabled = true;
    try {
      await saveCourt({
        id: $('courtIdInput').value || undefined,
        name: $('courtNameInput').value,
        format: $('courtFormatInput').value,
        division: $('courtDivisionInput').value,
        allowedSkills,
      });
      dialog.close();
      await refresh();
      showAlert('Court settings saved.', 'success');
    } catch (cause) {
      showAlert(cause.message || 'Could not save court.');
    } finally {
      save.disabled = false;
    }
  });

  function openReplacement(game) {
    const outgoing = $('outgoingPlayerInput');
    const incoming = $('incomingPlayerInput');
    outgoing.replaceChildren();
    incoming.replaceChildren();
    const activeIds = new Set(games.filter((item) => item.status === 'active')
      .flatMap((item) => [...item.lineup.sideA, ...item.lineup.sideB]));
    for (const id of [...game.lineup.sideA, ...game.lineup.sideB]) {
      const option = el('option', '', nameFor(id, game));
      option.value = id;
      outgoing.append(option);
    }
    for (const entry of getEntries().filter((item) =>
      item.status === 'confirmed' && item.checkedIn && item.playerId && !activeIds.has(item.playerId))) {
      const option = el('option', '', `${entry.name} · ${entry.skillLevel}`);
      option.value = entry.playerId;
      incoming.append(option);
    }
    $('replacementGameInput').value = game.id;
    $('replaceSubmit').disabled = !incoming.options.length;
    $('replacementHelp').textContent = incoming.options.length
      ? 'The replacement must also meet this court’s current rules.'
      : 'No checked-in off-court players are available.';
    replacementDialog.showModal();
  }

  $('cancelReplacement').addEventListener('click', () => replacementDialog.close());
  $('replacementForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('replaceSubmit');
    submit.disabled = true;
    try {
      await replaceCourtPlayer({
        sessionId,
        gameId: $('replacementGameInput').value,
        outgoingPlayerId: $('outgoingPlayerInput').value,
        incomingPlayerId: $('incomingPlayerInput').value,
      });
      replacementDialog.close();
      await refresh();
      showAlert('Player replaced on this court.', 'success');
    } catch (cause) {
      showAlert(cause.message || 'Could not replace player.');
    } finally {
      submit.disabled = false;
    }
  });

  function availableCheckedInPlayers() {
    const busy = new Set(games.filter((item) => item.status === 'active')
      .flatMap((item) => [...(item.lineup?.sideA || []), ...(item.lineup?.sideB || [])]));
    return getEntries()
      .filter((entry) => entry.status === 'confirmed'
        && entry.checkedIn
        && entry.sittingOut !== true
        && entry.playerId
        && !busy.has(entry.playerId))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  }

  function fillManualSelect(select, players, { required = true } = {}) {
    select.replaceChildren();
    const blank = el('option', '', required ? 'Select player' : 'None');
    blank.value = '';
    select.append(blank);
    for (const entry of players) {
      const bits = [entry.name || 'Player', entry.skillLevel || ''];
      if (entry.partnerPlayerId) {
        const partner = getEntries().find((item) => item.playerId === entry.partnerPlayerId);
        if (partner?.name) bits.push(`with ${partner.name}`);
      }
      const option = el('option', '', bits.filter(Boolean).join(' · '));
      option.value = entry.playerId;
      select.append(option);
    }
    select.required = required;
  }

  function openManualLineup(court) {
    if (!court || !manualDialog) return;
    const singles = court.format === 'singles';
    const players = availableCheckedInPlayers();
    $('manualLineupTitle').textContent = `Manual lineup · ${court.name}`;
    $('manualCourtIdInput').value = court.id;
    $('manualLineupHelp').textContent = players.length
      ? (singles
        ? 'Choose one checked-in player for each side.'
        : 'Choose two checked-in players for Side A and two for Side B.')
      : 'No checked-in players are free right now.';
    fillManualSelect($('manualSideA1'), players, { required: true });
    fillManualSelect($('manualSideA2'), players, { required: !singles });
    fillManualSelect($('manualSideB1'), players, { required: true });
    fillManualSelect($('manualSideB2'), players, { required: !singles });
    const a2Label = $('manualSideA2')?.previousElementSibling;
    const b2Label = $('manualSideB2')?.previousElementSibling;
    $('manualSideA2').hidden = singles;
    if (a2Label) a2Label.hidden = singles;
    $('manualSideB2').hidden = singles;
    if (b2Label) b2Label.hidden = singles;
    $('saveManualLineup').disabled = !players.length;
    $('startManualLineup').disabled = !players.length;
    manualDialog.showModal();
  }

  function readManualLineup(court) {
    const singles = court.format === 'singles';
    const sideA = [$('manualSideA1').value, singles ? null : $('manualSideA2').value].filter(Boolean);
    const sideB = [$('manualSideB1').value, singles ? null : $('manualSideB2').value].filter(Boolean);
    const needed = singles ? 1 : 2;
    if (sideA.length !== needed || sideB.length !== needed) {
      throw new Error(singles
        ? 'Pick one player for Side A and one for Side B.'
        : 'Pick two players for Side A and two for Side B.');
    }
    const ids = [...sideA, ...sideB];
    if (new Set(ids).size !== ids.length) {
      throw new Error('Each player can appear only once in the matchup.');
    }
    const byId = new Map(getEntries().filter((entry) => entry.playerId).map((entry) => [entry.playerId, entry]));
    return {
      lineup: { sideA, sideB },
      players: ids.map((id) => {
        const entry = byId.get(id);
        if (!entry) throw new Error('A selected player is no longer on today’s roster.');
        return {
          id,
          name: entry.name,
          skillLevel: entry.skillLevel,
          division: entry.division || 'unspecified',
          photoUrl: entry.photoData || null,
          gamesPlayed: 0,
        };
      }),
    };
  }

  $('cancelManualLineup')?.addEventListener('click', () => manualDialog?.close());
  $('saveManualLineup')?.addEventListener('click', () => { manualSubmitIntent = 'save'; });
  $('startManualLineup')?.addEventListener('click', () => { manualSubmitIntent = 'start'; });
  manualForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const courtId = $('manualCourtIdInput').value;
    const court = courts.find((item) => item.id === courtId);
    if (!court || !sessionId) return;
    const saveBtn = $('saveManualLineup');
    const startBtn = $('startManualLineup');
    saveBtn.disabled = true;
    startBtn.disabled = true;
    try {
      const manual = readManualLineup(court);
      const existing = previews.get(courtId);
      previews.set(courtId, {
        lineup: manual.lineup,
        players: manual.players,
        pool: existing?.pool || {
          waiting: 0, onCourt: 0, eligible: manual.players.length,
          needed: court.format === 'singles' ? 2 : 4,
        },
      });
      if (manualSubmitIntent === 'start') {
        await startCourtGame({ sessionId, courtId, lineup: manual.lineup });
        previews.delete(courtId);
        showAlert(`${court.name} started with your manual lineup.`, 'success');
        await refreshRoster?.();
      } else {
        showAlert(`Manual lineup set for ${court.name}. Tap Start when ready.`, 'success');
      }
      manualDialog.close();
      await refresh();
    } catch (cause) {
      showAlert(cause.message || 'Could not set that lineup.');
    } finally {
      saveBtn.disabled = false;
      startBtn.disabled = false;
    }
  });

  grid.addEventListener('click', async (event) => {
    const control = event.target.closest('button[data-court-action]');
    if (!control || !sessionId) return;
    const action = control.dataset.courtAction;
    const id = control.dataset.id;
    const court = courts.find((item) => item.id === id);
    const game = games.find((item) => item.id === id);
    if (action === 'edit') return openCourtDialog(court);
    if (action === 'replace') return openReplacement(game);
    if (action === 'manual') return openManualLineup(court);
    if (action === 'delete' && !confirm(`Delete ${court?.name || 'this court'}?`)) return;
    if ((action === 'win-a' || action === 'win-b') &&
        !confirm(`Record Side ${action === 'win-a' ? 'A' : 'B'} as the winner? Each winner gains one win and each opponent gains one loss.`)) return;
    if (action === 'cancel-game' && !confirm('Cancel this game without recording wins or losses?')) return;
    control.disabled = true;
    try {
      if (action === 'draw') {
        const preview = await proposeCourtLineup({ sessionId, courtId: id });
        previews.set(id, preview);
        if (!preview.lineup) throw new Error('Not enough eligible checked-in players for this court.');
      } else if (action === 'clear-draw') {
        const existing = previews.get(id);
        previews.set(id, {
          lineup: null,
          players: [],
          pool: existing?.pool || { waiting: 0, onCourt: 0, eligible: 0, needed: 4 },
        });
        showAlert('Next-game draw cleared.', 'success');
      } else if (action === 'start') {
        const preview = previews.get(id);
        if (!preview?.lineup) throw new Error('Draw players first.');
        await startCourtGame({ sessionId, courtId: id, lineup: preview.lineup });
        showAlert(`${court?.name || 'Court'} started.`, 'success');
      } else if (action === 'win-a' || action === 'win-b') {
        const winnerSide = action === 'win-a' ? 'A' : 'B';
        const result = await completeCourtGame({ sessionId, gameId: id, winnerSide });
        if (result.applied) showAlert('Result saved. Winners gained one win; opponents gained one loss.', 'success');
        await refreshRoster();
      } else if (action === 'cancel-game') {
        await cancelCourtGame({ sessionId, gameId: id });
        showAlert('Game cancelled. No result was added.', 'success');
      } else if (action === 'delete') {
        await deleteCourt(id);
        previews.delete(id);
        showAlert('Court deleted.', 'success');
      }
      await refresh();
    } catch (cause) {
      showAlert(cause.message || 'Court action failed.');
    } finally {
      control.disabled = false;
    }
  });

  return { refresh };
}
