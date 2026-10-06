import {
  cancelCourtGame, completeCourtGame, deleteCourt, proposeCourtLineup,
  replaceCourtPlayer, saveCourt, startCourtGame, watchCourtGames, watchCourts,
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
  grid.tabIndex = -1;
  const history = $('matchHistory');
  const form = $('courtForm');
  const dialog = $('courtDialog');
  const replacementDialog = $('replacementDialog');
  let sessionId = null;
  let courts = [];
  let games = [];
  let generation = 0;
  let stopCourts = () => {};
  let stopGames = () => {};
  let setupPromise = null;
  let listenerFailed = false;
  let courtsReady = false;
  let gamesReady = false;
  let gameSignature = null;
  let replacementSessionId = null;
  const previews = new Map();
  const feedback = new Map();
  const status = el('p', 'panel-empty');
  status.setAttribute('role', 'alert');
  status.hidden = true;
  grid.before(status);

  function setFeedback(courtId, message, type = 'success') {
    if (courtId) feedback.set(courtId, { message, type });
    showAlert(message, type);
    render();
  }

  function listenerError(cause) {
    listenerFailed = true;
    status.textContent = `Court updates stopped: ${cause?.message || 'connection failed'}. Refresh the dashboard to retry.`;
    status.hidden = false;
    showAlert(status.textContent);
  }

  function stopWatching() {
    generation += 1;
    stopCourts();
    stopGames();
    stopCourts = () => {};
    stopGames = () => {};
    setupPromise = null;
  }

  function nameFor(id, game) {
    const snapshot = game?.playerSnapshots?.[id];
    return snapshot?.name || getEntries().find((entry) => entry.playerId === id)?.name || 'Player';
  }

  function teamRow(side, ids, game) {
    const row = el('div', 'court-side');
    row.append(el('strong', '', `Side ${side}`));
    row.append(el('span', '', ids.map((id) => nameFor(id, game)).join(' + ')));
    return row;
  }

  function matchContent(lineup, game) {
    const area = el('div', 'court-match');
    area.append(teamRow('A', lineup.sideA, game));
    area.append(el('div', 'court-vs', 'VS'));
    area.append(teamRow('B', lineup.sideB, game));
    return area;
  }

  function render() {
    const focused = grid.contains(document.activeElement) ? {
      action: document.activeElement.dataset?.courtAction,
      id: document.activeElement.dataset?.id,
    } : null;
    grid.replaceChildren();
    if (!courtsReady || !gamesReady) {
      grid.append(el('p', 'panel-empty', 'Loading courts and matches…'));
      history.replaceChildren(el('p', 'panel-empty', 'Loading recent results…'));
      return;
    }
    if (!courts.length) {
      grid.append(el('p', 'panel-empty', 'Add Court 1 to set its skill levels and division. Each court can start separately.'));
    } else for (const court of courts) {
      const active = games.find((game) => game.courtId === court.id && game.status === 'active');
      const latest = games.find((game) => game.courtId === court.id && game.status === 'completed');
      const preview = previews.get(court.id);
      const busyElsewhere = court.activeGameId && court.activeSessionId !== sessionId;
      const card = el('article', 'court-card');
      const top = el('div', 'court-card-top');
      const title = el('div');
      title.append(el('h3', '', court.name));
      title.append(el('p', '', active ? 'Match in progress' : busyElsewhere ? 'Playing in another session' : 'Ready for an individual draw'));
      top.append(title, el('span', `badge badge-${active ? 'green' : busyElsewhere ? 'amber' : 'blue'}`,
        active ? 'Playing' : busyElsewhere ? 'Busy' : 'Ready'));
      card.append(top);

      const settings = el('div', 'court-settings');
      settings.append(el('span', '', label(court.format)));
      settings.append(el('span', '', court.division === 'open' ? 'Open teams' : `${label(court.division)} teams`));
      for (const skill of court.allowedSkills) settings.append(el('span', '', label(skill)));
      card.append(settings);

      const actions = el('div', 'court-actions');
      if (active) {
        card.append(matchContent(active.lineup, active));
        actions.append(button('Side A wins', 'win-a', active.id, 'button-primary'));
        actions.append(button('Side B wins', 'win-b', active.id, 'button-primary'));
        actions.append(button('Replace player', 'replace', active.id));
        actions.append(button('Cancel game', 'cancel-game', active.id, 'button-quiet'));
      } else if (busyElsewhere) {
        card.append(el('div', 'court-empty', 'Finish or cancel the other session’s game before drawing here.'));
        actions.append(button('Settings', 'edit', court.id, 'button-quiet'));
      } else if (preview?.lineup) {
        card.append(matchContent(preview.lineup));
        actions.append(button('Start this court', 'start', court.id, 'button-primary'));
        actions.append(button('Shuffle', 'draw', court.id));
        actions.append(button('Settings', 'edit', court.id, 'button-quiet'));
      } else {
        card.append(el('div', 'court-empty', latest
          ? `Last game: Side ${latest.result?.winnerSide || '?'} won. Draw the next game for this court.`
          : 'No game started. Draw from checked-in players who meet this court’s rules.'));
        actions.append(button('Draw players', 'draw', court.id, 'button-primary'));
        actions.append(button('Settings', 'edit', court.id, 'button-quiet'));
        actions.append(button('Delete', 'delete', court.id, 'button-quiet'));
      }
      card.append(actions);
      const note = feedback.get(court.id);
      if (note) {
        const message = el('p', `court-feedback ${note.type === 'success' ? 'success' : 'error'}`, note.message);
        message.setAttribute('role', note.type === 'success' ? 'status' : 'alert');
        card.append(message);
      }
      grid.append(card);
    }
    if (focused) {
      const replacement = [...grid.querySelectorAll('button[data-court-action]')]
        .find((item) => item.dataset.courtAction === focused.action && item.dataset.id === focused.id);
      (replacement || grid).focus({ preventScroll: true });
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

  async function refresh(nextSessionId = getSession()?.id) {
    if (!nextSessionId) {
      dispose();
      return;
    }
    if (sessionId === nextSessionId && setupPromise && !listenerFailed) {
      render();
      return setupPromise;
    }
    stopWatching();
    const currentGeneration = generation;
    sessionId = nextSessionId;
    courts = [];
    games = [];
    courtsReady = false;
    gamesReady = false;
    gameSignature = null;
    listenerFailed = false;
    status.hidden = true;
    previews.clear();
    feedback.clear();
    render();
    const current = () => generation === currentGeneration &&
      sessionId === nextSessionId && getSession()?.id === nextSessionId;
    setupPromise = Promise.all([
      watchCourts((result) => {
        if (!current()) return;
        if (result.error) return listenerError(result.error);
        courts = result.courts;
        courtsReady = true;
        for (const court of courts) if (court.activeGameId) previews.delete(court.id);
        render();
      }),
      watchCourtGames(nextSessionId, (result) => {
        if (!current()) return;
        if (result.error) return listenerError(result.error);
        const signature = JSON.stringify(result.games.map((game) =>
          [game.id, game.status, game.lineup, game.result]));
        if (gameSignature !== null && signature !== gameSignature) previews.clear();
        gameSignature = signature;
        games = result.games;
        gamesReady = true;
        render();
      }),
    ]).then(([unsubscribeCourts, unsubscribeGames]) => {
      if (!current()) {
        unsubscribeCourts();
        unsubscribeGames();
        return;
      }
      stopCourts = unsubscribeCourts;
      stopGames = unsubscribeGames;
    }).catch((cause) => {
      if (current()) listenerError(cause);
    });
    return setupPromise;
  }

  function dispose() {
    stopWatching();
    sessionId = null;
    courts = [];
    games = [];
    courtsReady = false;
    gamesReady = false;
    previews.clear();
    feedback.clear();
    status.hidden = true;
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
      const saved = await saveCourt({
        id: $('courtIdInput').value || undefined,
        name: $('courtNameInput').value,
        format: $('courtFormatInput').value,
        division: $('courtDivisionInput').value,
        allowedSkills,
      });
      dialog.close();
      await refresh();
      setFeedback(saved.court.id, 'Court settings saved.');
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
    replacementSessionId = sessionId;
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
    const selectedSessionId = replacementSessionId;
    const selectedGame = games.find((game) => game.id === $('replacementGameInput').value);
    try {
      await replaceCourtPlayer({
        sessionId: selectedSessionId,
        gameId: $('replacementGameInput').value,
        outgoingPlayerId: $('outgoingPlayerInput').value,
        incomingPlayerId: $('incomingPlayerInput').value,
      });
      replacementDialog.close();
      if (sessionId === selectedSessionId) {
        await refresh();
        setFeedback(selectedGame?.courtId, 'Player replaced on this court.');
      }
    } catch (cause) {
      showAlert(cause.message || 'Could not replace player.');
    } finally {
      submit.disabled = false;
    }
  });

  grid.addEventListener('click', async (event) => {
    const control = event.target.closest('button[data-court-action]');
    if (!control || !sessionId) return;
    const action = control.dataset.courtAction;
    const id = control.dataset.id;
    const selectedSessionId = sessionId;
    const selectedGeneration = generation;
    const stillCurrent = () => sessionId === selectedSessionId &&
      generation === selectedGeneration && getSession()?.id === selectedSessionId;
    const court = courts.find((item) => item.id === id);
    const game = games.find((item) => item.id === id);
    if (action === 'edit') return openCourtDialog(court);
    if (action === 'replace') return openReplacement(game);
    if (action === 'delete' && !confirm(`Delete ${court?.name || 'this court'}?`)) return;
    if ((action === 'win-a' || action === 'win-b') &&
        !confirm(`Record Side ${action === 'win-a' ? 'A' : 'B'} as the winner? Each winner gains one win and each opponent gains one loss.`)) return;
    if (action === 'cancel-game' && !confirm('Cancel this game without recording wins or losses?')) return;
    control.disabled = true;
    try {
      if (action === 'draw') {
        const preview = await proposeCourtLineup({ sessionId: selectedSessionId, courtId: id });
        if (!stillCurrent()) return;
        if (!preview.lineup) throw new Error('Not enough eligible checked-in players for this court.');
        previews.set(id, preview);
        feedback.delete(id);
      } else if (action === 'start') {
        const preview = previews.get(id);
        if (!preview?.lineup) throw new Error('Draw players first.');
        await startCourtGame({ sessionId: selectedSessionId, courtId: id, lineup: preview.lineup });
        if (!stillCurrent()) return;
        previews.delete(id);
        setFeedback(id, `${court?.name || 'Court'} started.`);
      } else if (action === 'win-a' || action === 'win-b') {
        const winnerSide = action === 'win-a' ? 'A' : 'B';
        const result = await completeCourtGame({ sessionId: selectedSessionId, gameId: id, winnerSide });
        if (!stillCurrent()) return;
        if (result.applied) setFeedback(game?.courtId, 'Result saved. Winners gained one win; opponents gained one loss.');
        await refreshRoster();
      } else if (action === 'cancel-game') {
        await cancelCourtGame({ sessionId: selectedSessionId, gameId: id });
        if (!stillCurrent()) return;
        setFeedback(game?.courtId, 'Game cancelled. No result was added.');
      } else if (action === 'delete') {
        await deleteCourt(id);
        if (!stillCurrent()) return;
        previews.delete(id);
        showAlert('Court deleted.', 'success');
      }
      if (stillCurrent()) await refresh();
    } catch (cause) {
      if (stillCurrent()) setFeedback(court?.id || game?.courtId, cause.message || 'Court action failed.', 'error');
    } finally {
      control.disabled = false;
    }
  });

  return { refresh, dispose };
}
