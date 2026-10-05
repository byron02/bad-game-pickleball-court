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
  let sessionId = null;
  let courts = [];
  let games = [];
  const previews = new Map();

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
      title.append(el('p', '', active ? 'Match in progress' : 'Ready for an individual draw'));
      top.append(title, el('span', `badge badge-${active ? 'green' : 'blue'}`, active ? 'Playing' : 'Ready'));
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
    for (const court of courts) {
      if (court.activeGameId) previews.delete(court.id);
    }
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

  grid.addEventListener('click', async (event) => {
    const control = event.target.closest('button[data-court-action]');
    if (!control || !sessionId) return;
    const action = control.dataset.courtAction;
    const id = control.dataset.id;
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
        const preview = await proposeCourtLineup({ sessionId, courtId: id });
        if (!preview.lineup) throw new Error('Not enough eligible checked-in players for this court.');
        previews.set(id, preview);
      } else if (action === 'start') {
        const preview = previews.get(id);
        if (!preview?.lineup) throw new Error('Draw players first.');
        await startCourtGame({ sessionId, courtId: id, lineup: preview.lineup });
        previews.delete(id);
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
