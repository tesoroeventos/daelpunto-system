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
  const { clubCodigo, canchaId, equipo1Nombre, equipo2Nombre, puntoDeOro, equipo1Id, equipo2Id, torneoId, serving, soloServing } = req.body;
  const club = helpers.getClub.get(clubCodigo?.toUpperCase());
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });

  const cancha = helpers.getCancha.get(canchaId);
  if (!cancha) return res.status(404).json({ error: 'Cancha no encontrada' });

  // Si soloServing=true, solo actualizar el serving del partido existente
  if (soloServing) {
    const existingState = state.getState(canchaId);
    if (existingState) {
      existingState.serving = serving !== undefined ? Number(serving) : 0;
      const fullState = state.getFullState(existingState);
      state.broadcast(`cancha:${canchaId}`, { type: 'STATE_UPDATE', state: fullState });
      state.broadcast(`tv:${canchaId}`, { type: 'STATE_UPDATE', state: fullState });
      return res.json({ ok: true, state: fullState });
    }
  }

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

  // Siguiente potencia de 2
  let slots = 1;
  while (slots < n) slots *= 2;

  const byes = slots - n; // equipos que pasan directo
  const ronda1 = slots / 2; // número de partidos en ronda 1

  // Emparejamiento estándar:
  // Los 'byes' primeros seeds pasan directo (no juegan ronda 1)
  // El resto juega entre sí en ronda 1
  //
  // Ejemplo 10 equipos, slots=16, byes=6:
  // Seeds 1-6 pasan directo a cuartos
  // Seeds 7-10 juegan: 7vs10, 8vs9 en "pre-cuartos"
  //
  // Posiciones en ronda1 (ronda1=8 para slots=16):
  // pos 1: seed1 BYE (null vs null → solo seed1 avanza)
  // pos 2: seed2 BYE
  // ...
  // pos 6: seed6 BYE
  // pos 7: seed7 vs seed10
  // pos 8: seed8 vs seed9

  for (let pos = 1; pos <= ronda1; pos++) {
    const topIdx = pos - 1;        // 0-based desde arriba
    const botIdx = slots - pos;    // 0-based desde abajo

    let e1 = topIdx < n ? equipoIds[topIdx] : null;
    let e2 = botIdx < n ? equipoIds[botIdx] : null;

    // Si top y bot son el mismo equipo (número impar), e2 = null
    if (topIdx >= botIdx) e2 = null;

    helpers.insertLlave.run(uuidv4(), torneoId, ronda1, pos, e1, e2);
  }

  // Rondas siguientes vacías (se llenan al avanzar ganadores)
  let ronda = ronda1 / 2;
  while (ronda >= 1) {
    for (let i = 0; i < ronda; i++) {
      helpers.insertLlave.run(uuidv4(), torneoId, ronda, i + 1, null, null);
    }
    ronda = Math.floor(ronda / 2);
  }

  // Avanzar byes automáticamente a la siguiente ronda
  const stmtGetLlaves = db.prepare('SELECT * FROM llaves WHERE torneo_id = ? AND ronda = ? ORDER BY posicion');
  const stmtSetGanador = db.prepare('UPDATE llaves SET ganador_id = ? WHERE id = ?');
  const stmtGetSigLlave = db.prepare('SELECT * FROM llaves WHERE torneo_id = ? AND ronda = ? AND posicion = ?');
  const stmtSetE1 = db.prepare('UPDATE llaves SET equipo1_id = ? WHERE id = ?');
  const stmtSetE2 = db.prepare('UPDATE llaves SET equipo2_id = ? WHERE id = ?');

  const llaves1 = stmtGetLlaves.all(torneoId, ronda1);
  const sigRonda = ronda1 / 2;

  llaves1.forEach(l => {
    const tieneSolo = (l.equipo1_id && !l.equipo2_id) || (!l.equipo1_id && l.equipo2_id);
    if (!tieneSolo) return;

    const ganadorId = l.equipo1_id || l.equipo2_id;
    stmtSetGanador.run(ganadorId, l.id);

    const sigPos = Math.ceil(l.posicion / 2);
    const sigLlave = stmtGetSigLlave.get(torneoId, sigRonda, sigPos);

    if (sigLlave) {
      if (l.posicion % 2 === 1) {
        stmtSetE1.run(ganadorId, sigLlave.id);
      } else {
        stmtSetE2.run(ganadorId, sigLlave.id);
      }
    }
  });
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


// ── TORNEOS ADICIONALES ──────────────────────────────────────────────────────

// GET /api/club/:codigo/torneos — torneos del club
app.get('/api/club/:codigo/torneos', (req, res) => {
  const club = helpers.getClub.get(req.params.codigo.toUpperCase());
  if (!club) return res.status(404).json({ error: 'Club no encontrado' });
  const torneos = helpers.getTorneos.all(club.id);
  res.json(torneos);
});

// POST /api/torneo/:id/equipo — agregar equipo a torneo existente
app.post('/api/torneo/:id/equipo', (req, res) => {
  const { nombre, seed } = req.body;
  const torneo = helpers.getTorneo.get(req.params.id);
  if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });
  const teId = uuidv4();
  helpers.insertTorneoEquipo.run(teId, torneo.id, null, nombre, seed || null);
  res.json({ id: teId, nombre });
});

// POST /api/torneo/:id/generar — generar llaves con equipos ya cargados
app.post('/api/torneo/:id/generar', (req, res) => {
  const torneo = helpers.getTorneo.get(req.params.id);
  if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });
  const equipos = helpers.getTorneoEquipos.all(torneo.id);
  if (equipos.length < 2) return res.status(400).json({ error: 'Necesitás al menos 2 equipos' });

  // Limpiar llaves anteriores si las hay
  db.prepare('DELETE FROM llaves WHERE torneo_id = ?').run(torneo.id);

  const teIds = equipos.map(e => e.id);
  generarLlaves(torneo.id, teIds);
  helpers.updateTorneoEstado.run('en_curso', torneo.id);

  const llaves = helpers.getLlaves.all(torneo.id);
  res.json({ ok: true, llaves });
});

// POST /api/llave/:id/ganador — registrar ganador de una llave
app.post('/api/llave/:id/ganador', (req, res) => {
  const { ganadorId, torneoId, canchaId } = req.body;

  // Registrar ganador en la llave actual
  db.prepare('UPDATE llaves SET ganador_id = ? WHERE id = ?').run(ganadorId, req.params.id);

  // Buscar la llave actual para saber ronda y posición
  const llave = db.prepare('SELECT * FROM llaves WHERE id = ?').get(req.params.id);
  if (!llave) return res.status(404).json({ error: 'Llave no encontrada' });

  // Avanzar ganador a la siguiente ronda
  const sigRonda = Math.floor(llave.ronda / 2);
  if (sigRonda >= 1) {
    const sigPos = Math.ceil(llave.posicion / 2);
    const sigLlave = db.prepare(
      'SELECT * FROM llaves WHERE torneo_id = ? AND ronda = ? AND posicion = ?'
    ).get(llave.torneo_id, sigRonda, sigPos);

    if (sigLlave) {
      // Determinar si va como equipo1 o equipo2
      if (llave.posicion % 2 === 1) {
        db.prepare('UPDATE llaves SET equipo1_id = ? WHERE id = ?').run(ganadorId, sigLlave.id);
      } else {
        db.prepare('UPDATE llaves SET equipo2_id = ? WHERE id = ?').run(ganadorId, sigLlave.id);
      }
    } else if (sigRonda === 0) {
      // Es el campeón
      helpers.updateTorneoEstado.run('finalizado', llave.torneo_id);
      db.prepare('UPDATE torneos SET ganador_id = ? WHERE id = ?').run(ganadorId, llave.torneo_id);
    }
  } else {
    // Ronda 1 ya es la final — campeón
    helpers.updateTorneoEstado.run('finalizado', llave.torneo_id);
    db.prepare('UPDATE torneos SET ganador_id = ? WHERE id = ?').run(ganadorId, llave.torneo_id);
  }

  // Asignar cancha si se especificó
  if (canchaId) {
    db.prepare('UPDATE llaves SET cancha_id = ? WHERE id = ?').run(canchaId, req.params.id);
  }

  // Broadcast a todos los conectados al torneo
  const llaves = helpers.getLlaves.all(llave.torneo_id);
  const equipos = helpers.getTorneoEquipos.all(llave.torneo_id);
  state.broadcast(`torneo:${llave.torneo_id}`, { type: 'TORNEO_UPDATE', llaves, equipos });

  res.json({ ok: true });
});

// POST /api/llave/:id/cancha — asignar cancha a un partido
app.post('/api/llave/:id/cancha', (req, res) => {
  const { canchaId } = req.body;
  db.prepare('UPDATE llaves SET cancha_id = ? WHERE id = ?').run(canchaId, req.params.id);
  const llave = db.prepare('SELECT * FROM llaves WHERE id = ?').get(req.params.id);
  state.broadcast(`torneo:${llave.torneo_id}`, { type: 'TORNEO_UPDATE_CANCHA', llaveId: req.params.id, canchaId });
  res.json({ ok: true });
});

// JOIN torneo en WebSocket — agregar al onmessage
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
      case 'JOIN_TORNEO': {
        state.joinRoom(`torneo:${msg.torneoId}`, ws);
        ws.torneoId = msg.torneoId;
        ws.role = 'torneo';
        const torneoData = helpers.getTorneo.get(msg.torneoId);
        const llaves = torneoData ? helpers.getLlaves.all(msg.torneoId) : [];
        const equipos = torneoData ? helpers.getTorneoEquipos.all(msg.torneoId) : [];
        ws.send(JSON.stringify({ type: 'TORNEO_INIT', torneo: torneoData, llaves, equipos }));
        break;
      }

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
