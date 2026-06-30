// server/state.js — Estado en tiempo real de todas las canchas
// Este módulo maneja el estado en memoria (rápido) y lo sincroniza con la DB

const PT = ['0', '15', '30', '40'];

// Estado en memoria por cancha: { [canchaId]: MatchState }
const canchaStates = {};

// WebSocket clients por sala: { [room]: Set<ws> }
// Rooms: "cancha:{id}", "encargado:{clubId}", "tv:{canchaId}"
const rooms = {};

function joinRoom(room, ws) {
  if (!rooms[room]) rooms[room] = new Set();
  rooms[room].add(ws);
}

function leaveRoom(room, ws) {
  if (rooms[room]) {
    rooms[room].delete(ws);
    if (rooms[room].size === 0) delete rooms[room];
  }
}

function leaveAllRooms(ws) {
  for (const room of Object.keys(rooms)) {
    leaveRoom(room, ws);
  }
}

function broadcast(room, msg, excludeWs = null) {
  if (!rooms[room]) return;
  const data = JSON.stringify(msg);
  for (const client of rooms[room]) {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(data);
    }
  }
}

function broadcastToClub(clubId, msg, excludeWs = null) {
  broadcast(`encargado:${clubId}`, msg, excludeWs);
}

// ─── ESTADO DE PARTIDO ────────────────────────────────────────────────────────

function createMatchState(partido, opts = {}) {
  return {
    partidoId: partido.id,
    canchaId: partido.cancha_id,
    clubId: partido.club_id,
    equipo1: partido.equipo1_nombre || 'Pareja 1',
    equipo2: partido.equipo2_nombre || 'Pareja 2',
    puntosOro: partido.punto_de_oro === 1,
    // Marcador actual
    pts: [0, 0],          // puntos en el game actual
    games: [0, 0],        // games en el set actual
    sets: [0, 0],         // sets ganados
    setHistory: [],       // historial de sets [{e1, e2}]
    currentSet: 1,
    serving: opts.serving || 0,
    pointsInGame: 0,
    history: [],          // para deshacer (últimos 20)
    estado: 'en_curso',
    startedAt: partido.started_at || new Date().toISOString(),
  };
}

function getState(canchaId) {
  return canchaStates[canchaId] || null;
}

function setState(canchaId, state) {
  canchaStates[canchaId] = state;
}

function clearState(canchaId) {
  delete canchaStates[canchaId];
}

// ─── LÓGICA DE PUNTUACIÓN ─────────────────────────────────────────────────────

function getDisplayScore(state, t) {
  const p = state.pts[t], o = state.pts[1 - t];
  if (state.puntosOro && p === 3 && o === 3) return 'ORO';
  if (p >= 3 && o >= 3) {
    if (p === o) return 'D';
    return p > o ? 'AD' : '40';
  }
  return PT[Math.min(p, 3)];
}

function isOro(state) {
  return state.puntosOro && state.pts[0] === 3 && state.pts[1] === 3;
}

function addPoint(state, team) {
  // Guardar en historial (máx 20)
  state.history.push(JSON.parse(JSON.stringify({
    pts: state.pts,
    games: state.games,
    sets: state.sets,
    setHistory: state.setHistory,
    currentSet: state.currentSet,
    serving: state.serving,
    pointsInGame: state.pointsInGame,
  })));
  if (state.history.length > 20) state.history.shift();

  const wasOro = isOro(state);
  state.pts[team]++;
  state.pointsInGame++;

  const p0 = state.pts[0], p1 = state.pts[1];
  let gameWon = false, gameWinner = -1;

  if (wasOro && (state.pts[0] > 3 || state.pts[1] > 3)) {
    gameWinner = team; gameWon = true;
  } else if (!wasOro) {
    if (p0 >= 3 && p1 >= 3) {
      if (Math.abs(p0 - p1) >= 2) { gameWinner = p0 > p1 ? 0 : 1; gameWon = true; }
    } else {
      if (p0 >= 4) { gameWinner = 0; gameWon = true; }
      if (p1 >= 4) { gameWinner = 1; gameWon = true; }
    }
  }

  let matchWinner = -1;

  if (gameWon) {
    state.games[gameWinner]++;
    state.pts = [0, 0];
    state.pointsInGame = 0;
    state.serving = 1 - state.serving;

    const g0 = state.games[0], g1 = state.games[1];
    let setWon = false, setWinner = -1;
    const isSuperTb = state.currentSet === 3;

    if (!isSuperTb) {
      if ((g0 >= 6 && g0 - g1 >= 2) || g0 === 7) { setWinner = 0; setWon = true; }
      else if ((g1 >= 6 && g1 - g0 >= 2) || g1 === 7) { setWinner = 1; setWon = true; }
    } else {
      if (g0 >= 7 && g0 - g1 >= 2) { setWinner = 0; setWon = true; }
      else if (g1 >= 7 && g1 - g0 >= 2) { setWinner = 1; setWon = true; }
    }

    if (setWon) {
      state.setHistory.push({ e1: g0, e2: g1 });
      state.sets[setWinner]++;
      state.games = [0, 0];
      state.currentSet++;

      if (state.sets[setWinner] >= 2) {
        matchWinner = setWinner;
        state.estado = 'finalizado';
        state.ganador = setWinner;
      }
    }
  }

  return { gameWon, matchWinner };
}

function undoPoint(state) {
  if (!state.history.length) return false;
  const prev = state.history.pop();
  state.pts = prev.pts;
  state.games = prev.games;
  state.sets = prev.sets;
  state.setHistory = prev.setHistory;
  state.currentSet = prev.currentSet;
  state.serving = prev.serving;
  state.pointsInGame = prev.pointsInGame;
  state.estado = 'en_curso';
  state.ganador = undefined;
  return true;
}

function getFullState(state) {
  if (!state) return null;
  return {
    ...state,
    history: [], // no mandar el historial completo al cliente
    displayScore: [
      getDisplayScore(state, 0),
      getDisplayScore(state, 1),
    ],
    isOro: isOro(state),
  };
}

module.exports = {
  joinRoom, leaveRoom, leaveAllRooms,
  broadcast, broadcastToClub,
  createMatchState, getState, setState, clearState,
  addPoint, undoPoint, getFullState, getDisplayScore,
  canchaStates, rooms,
};
