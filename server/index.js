// server/index.js — Servidor principal Da El Punto
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, helpers } = require('./db');
const state = require('./state');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── REST API ─────────────────────────────────────────────────────────────────

// GET /api/club/:codigo — info del club
app.get('/api/club/:codigo', (req, res) => {
  const club = helpers.getClub.get(req.params.codigo.toUpperCase());
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });
  const canchas = helpers.getCanchas.all(club.id);
  const equipos = helpers.getEquipos.all(club.id);
  res.json({ club, canchas, equipos });
});

// GET /api/club/:codigo/estado — estado en tiempo real de todas las canchas
app.get('/api/club/:codigo/estado', (req, res) => {
  const club = helpers.getClub.get(req.params.codigo.toUpperCase());
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });
  const canchas = helpers.getCanchas.all(club.id);
  const resultado = canchas.map(c => ({
    cancha: c,
    partido: state.getFullState(state.getState(c.id)),
  }));
  res.json(resultado);
});

// POST /api/partido — crear nuevo partido
app.post('/api/partido', (req, res) => {
  const { clubCodigo, canchaId, equipo1Nombre, equipo2Nombre, puntoDeOro, equipo1Id, equipo2Id, torneoId, serving } = req.body;
  const club = helpers.getClub.get(clubCodigo?.toUpperCase());
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });

  const cancha = helpers.getCancha.get(canchaId);
  if (!cancha) return res.status(404).json({ error: 'Cancha no encontrada' });

  const id = uuidv4();
  helpers.insertPartido.run(
    id, club.id, canchaId, torneoId || null,
    equipo1Id || null, equipo2Id || null,
    equipo1Nombre || 'Pareja 1',
    equipo2Nombre || 'Pareja 2',
    puntoDeOro ? 1 : 0
  );

  const partido = { id, club_id: club.id, cancha_id: canchaId, punto_de_oro: puntoDeOro ? 1 : 0,
    equipo1_nombre: equipo1Nombre || 'Pareja 1', equipo2_nombre: equipo2Nombre || 'Pareja 2' };
  const matchState = state.createMatchState(partido, { serving: serving !== undefined ? Number(serving) : 0 });
  state.setState(canchaId, matchState);

  // Notificar a todos los conectados a esta cancha y al panel del encargado
  const fullState = state.getFullState(matchState);
  state.broadcast(`cancha:${canchaId}`, { type: 'PARTIDO_INICIADO', state: fullState });
  state.broadcast(`tv:${canchaId}`, { type: 'PARTIDO_INICIADO', state: fullState });
  state.broadcastToClub(club.id, { type: 'CANCHA_UPDATE', canchaId, state: fullState });

  res.json({ id, state: fullState });
});

// POST /api/partido/:id/finalizar — forzar fin de partido
app.post('/api/partido/:id/finalizar', (req, res) => {
  const { canchaId, ganador } = req.body;
  const matchState = state.getState(canchaId);
  if (!matchState) return res.status(404).json({ error: 'Partido no encontrado en memoria' });

  helpers.finalizarPartido.run(ganador !== undefined ? ganador.toString() : null,
    matchState.sets[0], matchState.sets[1], req.params.id);

  // Guardar sets en DB
  matchState.setHistory.forEach((s, i) => {
    helpers.insertSet.run(uuidv4(), req.params.id, i + 1, s.e1, s.e2, s.e1 > s.e2 ? 1 : 2);
  });

  state.clearState(canchaId);

  state.broadcast(`cancha:${canchaId}`, { type: 'PARTIDO_FINALIZADO' });
  state.broadcast(`tv:${canchaId}`, { type: 'PARTIDO_FINALIZADO' });
  state.broadcastToClub(matchState.clubId, { type: 'CANCHA_UPDATE', canchaId, state: null });

  res.json({ ok: true });
});

// ── EQUIPOS ──
app.post('/api/equipo', (req, res) => {
  const { clubCodigo, nombre, jugador1, jugador2 } = req.body;
  const club = helpers.getClub.get(clubCodigo?.toUpperCase());
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });
  const id = uuidv4();
  helpers.insertEquipo.run(id, club.id, nombre, jugador1 || null, jugador2 || null);
  res.json({ id, nombre });
});

// ── TORNEOS ──
app.get('/api/torneo/:id', (req, res) => {
  const torneo = helpers.getTorneo.get(req.params.id);
  if (!torneo) return res.status(404).json({ error: 'No encontrado' });
  const equipos = helpers.getTorneoEquipos.all(torneo.id);
  const llaves = helpers.getLlaves.all(torneo.id);
  res.json({ torneo, equipos, llaves });
});

app.post('/api/torneo', (req, res) => {
  const { clubCodigo, nombre, formato, equipos } = req.body;
  const club = helpers.getClub.get(clubCodigo?.toUpperCase());
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });

  const torneoId = uuidv4();
  helpers.insertTorneo.run(torneoId, club.id, nombre, formato || 'eliminacion');

  // Inscribir equipos y generar llaves
  const teIds = [];
  if (equipos && equipos.length) {
    equipos.forEach((e, i) => {
      const teId = uuidv4();
      helpers.insertTorneoEquipo.run(teId, torneoId, e.equipoId || null, e.nombre, e.seed || i + 1);
      teIds.push(teId);
    });
    generarLlaves(torneoId, teIds);
  }

  helpers.updateTorneoEstado.run('en_curso', torneoId);
  res.json({ id: torneoId });
});

// Generar bracket de eliminación simple
function generarLlaves(torneoId, equipoIds) {
  const n = equipoIds.length;
  // Redondear al siguiente número de potencia de 2
  let slots = 1;
  while (slots < n) slots *= 2;

  // Ronda 1 — emparejamiento por seeds
  const partidos = Math.floor(slots / 2);
  for (let i = 0; i < partidos; i++) {
    const e1 = equipoIds[i] || null;
    const e2 = equipoIds[slots - 1 - i] || null;
    helpers.insertLlave.run(uuidv4(), torneoId, slots / 2, i + 1, e1, e2);
  }

  // Rondas siguientes (sin equipos todavía, se llenan al avanzar)
  let ronda = slots / 4;
  while (ronda >= 1) {
    const p = ronda;
    for (let i = 0; i < p; i++) {
      helpers.insertLlave.run(uuidv4(), torneoId, ronda, i + 1, null, null);
    }
    ronda = Math.floor(ronda / 2);
  }
}


// ─── ADMIN API (protegida con ADMIN_KEY) ─────────────────────────────────────

function checkAdmin(req, res) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== process.env.DEP_ADMIN_KEY) {
    res.status(401).json({ error: 'No autorizado' });
    return false;
  }
  return true;
}

// POST /api/admin/club — crear nuevo club
app.post('/api/admin/club', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { nombre, codigo, plan, canchas } = req.body;
  if (!nombre || !codigo) return res.status(400).json({ error: 'nombre y codigo requeridos' });

  const id = 'club-' + codigo.toLowerCase();
  try {
    db.prepare(`INSERT INTO clubes (id, nombre, codigo, plan) VALUES (?, ?, ?, ?)`)
      .run(id, nombre, codigo.toUpperCase(), plan || 'club');

    // Crear canchas si se especifican
    if (canchas && canchas.length) {
      canchas.forEach((c, i) => {
        db.prepare(`INSERT INTO canchas (id, club_id, numero, nombre, tiene_tv) VALUES (?, ?, ?, ?, ?)`)
          .run(`${id}-c${i+1}`, id, i+1, c.nombre || `Cancha ${i+1}`, c.tiene_tv ? 1 : 0);
      });
    }

    res.json({ ok: true, id, codigo: codigo.toUpperCase() });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/admin/clubes — listar todos los clubes
app.get('/api/admin/clubes', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const clubes = db.prepare('SELECT * FROM clubes ORDER BY created_at DESC').all();
  res.json(clubes);
});

// DELETE /api/admin/club/:id — desactivar club
app.delete('/api/admin/club/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  db.prepare('UPDATE clubes SET activo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── WEBSOCKETS ───────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  console.log('WS conectado:', req.url);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // Unirse como encargado del club
      case 'JOIN_ENCARGADO': {
        const club = helpers.getClub.get(msg.clubCodigo?.toUpperCase());
        if (!club) return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Club no encontrado' }));
        state.joinRoom(`encargado:${club.id}`, ws);
        ws.clubId = club.id;
        ws.role = 'encargado';
        // Enviar estado actual de todas las canchas
        const canchas = helpers.getCanchas.all(club.id);
        const estadoCanchas = canchas.map(c => ({
          cancha: c,
          partido: state.getFullState(state.getState(c.id)),
        }));
        ws.send(JSON.stringify({ type: 'INIT', club, estadoCanchas }));
        break;
      }

      // Unirse como control de una cancha (celu del jugador)
      case 'JOIN_CANCHA': {
        const club = helpers.getClub.get(msg.clubCodigo?.toUpperCase());
        if (!club) return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Club no encontrado' }));
        state.joinRoom(`cancha:${msg.canchaId}`, ws);
        ws.canchaId = msg.canchaId;
        ws.clubId = club.id;
        ws.role = 'jugador';
        const matchState = state.getState(msg.canchaId);
        ws.send(JSON.stringify({ type: 'INIT', state: state.getFullState(matchState) }));
        break;
      }

      // Unirse como TV de una cancha
      case 'JOIN_TV': {
        console.log('JOIN_TV canchaId:', msg.canchaId);
        state.joinRoom(`tv:${msg.canchaId}`, ws);
        ws.canchaId = msg.canchaId;
        ws.role = 'tv';
        const matchState = state.getState(msg.canchaId);
        ws.send(JSON.stringify({ type: 'INIT', state: state.getFullState(matchState) }));
        break;
      }

      // Sumar punto
      case 'POINT': {
        const canchaId = msg.canchaId || ws.canchaId;
        const matchState = state.getState(canchaId);
        console.log('POINT canchaId:', canchaId, 'team:', msg.team, 'stateExists:', !!matchState);
        console.log('All states:', Object.keys(state.canchaStates || {}));
        if (!matchState || matchState.estado !== 'en_curso') {
          console.log('NO STATE - ignorando punto');
          return;
        }

        const { matchWinner } = state.addPoint(matchState, msg.team);
        const fullState = state.getFullState(matchState);

        // Broadcast a cancha y TV
        state.broadcast(`cancha:${canchaId}`, { type: 'STATE_UPDATE', state: fullState, team: msg.team });
        state.broadcast(`tv:${canchaId}`, { type: 'STATE_UPDATE', state: fullState, team: msg.team });
        state.broadcastToClub(matchState.clubId, { type: 'CANCHA_UPDATE', canchaId, state: fullState });

        // Si terminó el partido, guardar en DB
        if (matchWinner >= 0) {
          const partidoId = matchState.partidoId;
          helpers.finalizarPartido.run(
            matchWinner.toString(),
            matchState.sets[0], matchState.sets[1],
            partidoId
          );
          matchState.setHistory.forEach((s, i) => {
            helpers.insertSet.run(uuidv4(), partidoId, i + 1, s.e1, s.e2, s.e1 > s.e2 ? 1 : 2);
          });
        }
        break;
      }

      // Deshacer punto
      case 'UNDO': {
        const canchaId = msg.canchaId || ws.canchaId;
        const matchState = state.getState(canchaId);
        if (!matchState) return;
        state.undoPoint(matchState);
        const fullState = state.getFullState(matchState);
        state.broadcast(`cancha:${canchaId}`, { type: 'STATE_UPDATE', state: fullState });
        state.broadcast(`tv:${canchaId}`, { type: 'STATE_UPDATE', state: fullState });
        state.broadcastToClub(matchState.clubId, { type: 'CANCHA_UPDATE', canchaId, state: fullState });
        break;
      }
    }
  });

  ws.on('close', () => {
    state.leaveAllRooms(ws);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    state.leaveAllRooms(ws);
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Da El Punto server corriendo en puerto ${PORT}`);
  console.log(`Panel encargado: http://localhost:${PORT}/encargado`);
  console.log(`TV cancha:       http://localhost:${PORT}/tv`);
  console.log(`Control jugador: http://localhost:${PORT}/cancha`);
});
