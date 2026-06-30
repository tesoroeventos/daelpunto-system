// server/db.js — Base de datos SQLite
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/daelpunto.db');

// Crear directorio si no existe
const fs = require('fs');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Optimizaciones
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

db.exec(`
  -- Clubes
  CREATE TABLE IF NOT EXISTS clubes (
    id          TEXT PRIMARY KEY,
    nombre      TEXT NOT NULL,
    codigo      TEXT UNIQUE NOT NULL,  -- código corto para acceso rápido (ej: CLUB001)
    plan        TEXT DEFAULT 'starter', -- starter | club | pro
    activo      INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Canchas del club
  CREATE TABLE IF NOT EXISTS canchas (
    id          TEXT PRIMARY KEY,
    club_id     TEXT NOT NULL REFERENCES clubes(id),
    numero      INTEGER NOT NULL,
    nombre      TEXT,                  -- ej: "Cancha 1", "Central"
    tiene_tv    INTEGER DEFAULT 0,
    activa      INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Jugadores/Equipos registrados en el club
  CREATE TABLE IF NOT EXISTS equipos (
    id          TEXT PRIMARY KEY,
    club_id     TEXT NOT NULL REFERENCES clubes(id),
    nombre      TEXT NOT NULL,
    jugador1    TEXT,
    jugador2    TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Partidos
  CREATE TABLE IF NOT EXISTS partidos (
    id            TEXT PRIMARY KEY,
    club_id       TEXT NOT NULL REFERENCES clubes(id),
    cancha_id     TEXT NOT NULL REFERENCES canchas(id),
    torneo_id     TEXT REFERENCES torneos(id),
    equipo1_id    TEXT REFERENCES equipos(id),
    equipo2_id    TEXT REFERENCES equipos(id),
    equipo1_nombre TEXT NOT NULL DEFAULT 'Pareja 1',
    equipo2_nombre TEXT NOT NULL DEFAULT 'Pareja 2',
    estado        TEXT DEFAULT 'en_curso', -- en_curso | finalizado | suspendido
    punto_de_oro  INTEGER DEFAULT 0,
    ganador_id    TEXT,
    sets_e1       INTEGER DEFAULT 0,
    sets_e2       INTEGER DEFAULT 0,
    started_at    TEXT DEFAULT (datetime('now')),
    finished_at   TEXT
  );

  -- Sets de cada partido
  CREATE TABLE IF NOT EXISTS sets (
    id          TEXT PRIMARY KEY,
    partido_id  TEXT NOT NULL REFERENCES partidos(id),
    numero      INTEGER NOT NULL,
    games_e1    INTEGER DEFAULT 0,
    games_e2    INTEGER DEFAULT 0,
    ganador     INTEGER,  -- 1 o 2
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Torneos
  CREATE TABLE IF NOT EXISTS torneos (
    id          TEXT PRIMARY KEY,
    club_id     TEXT NOT NULL REFERENCES clubes(id),
    nombre      TEXT NOT NULL,
    formato     TEXT DEFAULT 'eliminacion', -- eliminacion | grupos | round_robin
    estado      TEXT DEFAULT 'pendiente',   -- pendiente | en_curso | finalizado
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Participantes del torneo (equipos inscriptos)
  CREATE TABLE IF NOT EXISTS torneo_equipos (
    id          TEXT PRIMARY KEY,
    torneo_id   TEXT NOT NULL REFERENCES torneos(id),
    equipo_id   TEXT REFERENCES equipos(id),
    nombre      TEXT NOT NULL,  -- nombre para el torneo (puede ser distinto)
    seed        INTEGER,        -- cabeza de serie
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Llaves del torneo
  CREATE TABLE IF NOT EXISTS llaves (
    id            TEXT PRIMARY KEY,
    torneo_id     TEXT NOT NULL REFERENCES torneos(id),
    ronda         INTEGER NOT NULL,   -- 1=final, 2=semis, 4=cuartos, etc
    posicion      INTEGER NOT NULL,   -- posición dentro de la ronda
    equipo1_id    TEXT REFERENCES torneo_equipos(id),
    equipo2_id    TEXT REFERENCES torneo_equipos(id),
    partido_id    TEXT REFERENCES partidos(id),
    ganador_id    TEXT REFERENCES torneo_equipos(id),
    created_at    TEXT DEFAULT (datetime('now'))
  );

  -- Club demo para desarrollo
  INSERT OR IGNORE INTO clubes (id, nombre, codigo, plan) 
  VALUES ('club-demo', 'Club Demo', 'DEMO', 'pro');

  -- Canchas demo
  INSERT OR IGNORE INTO canchas (id, club_id, numero, nombre, tiene_tv)
  VALUES 
    ('cancha-1', 'club-demo', 1, 'Cancha 1', 1),
    ('cancha-2', 'club-demo', 2, 'Cancha 2', 1),
    ('cancha-3', 'club-demo', 3, 'Cancha 3', 1),
    ('cancha-4', 'club-demo', 4, 'Cancha 4', 1),
    ('cancha-5', 'club-demo', 5, 'Cancha 5', 1),
    ('cancha-6', 'club-demo', 6, 'Cancha 6', 0),
    ('cancha-7', 'club-demo', 7, 'Cancha 7', 0),
    ('cancha-8', 'club-demo', 8, 'Cancha 8', 0);
`);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const helpers = {
  // Clubes
  getClub: db.prepare('SELECT * FROM clubes WHERE codigo = ?'),
  getClubById: db.prepare('SELECT * FROM clubes WHERE id = ?'),
  
  // Canchas
  getCanchas: db.prepare('SELECT * FROM canchas WHERE club_id = ? AND activa = 1 ORDER BY numero'),
  getCancha: db.prepare('SELECT * FROM canchas WHERE id = ?'),

  // Equipos
  getEquipos: db.prepare('SELECT * FROM equipos WHERE club_id = ? ORDER BY nombre'),
  getEquipo: db.prepare('SELECT * FROM equipos WHERE id = ?'),
  insertEquipo: db.prepare(`
    INSERT INTO equipos (id, club_id, nombre, jugador1, jugador2)
    VALUES (?, ?, ?, ?, ?)
  `),

  // Partidos
  getPartidoActivo: db.prepare(`
    SELECT p.*, 
           e1.nombre as e1_nombre, e2.nombre as e2_nombre,
           c.nombre as cancha_nombre
    FROM partidos p
    LEFT JOIN equipos e1 ON p.equipo1_id = e1.id
    LEFT JOIN equipos e2 ON p.equipo2_id = e2.id
    LEFT JOIN canchas c ON p.cancha_id = c.id
    WHERE p.cancha_id = ? AND p.estado = 'en_curso'
    ORDER BY p.started_at DESC LIMIT 1
  `),
  getPartidosActivos: db.prepare(`
    SELECT p.*, c.numero as cancha_numero, c.nombre as cancha_nombre
    FROM partidos p
    JOIN canchas c ON p.cancha_id = c.id
    WHERE p.club_id = ? AND p.estado = 'en_curso'
    ORDER BY c.numero
  `),
  insertPartido: db.prepare(`
    INSERT INTO partidos (id, club_id, cancha_id, torneo_id, equipo1_id, equipo2_id, equipo1_nombre, equipo2_nombre, punto_de_oro)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  finalizarPartido: db.prepare(`
    UPDATE partidos SET estado = 'finalizado', ganador_id = ?, sets_e1 = ?, sets_e2 = ?, finished_at = datetime('now')
    WHERE id = ?
  `),

  // Sets
  getSets: db.prepare('SELECT * FROM sets WHERE partido_id = ? ORDER BY numero'),
  insertSet: db.prepare(`
    INSERT INTO sets (id, partido_id, numero, games_e1, games_e2, ganador)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  // Torneos
  getTorneos: db.prepare('SELECT * FROM torneos WHERE club_id = ? ORDER BY created_at DESC'),
  getTorneo: db.prepare('SELECT * FROM torneos WHERE id = ?'),
  insertTorneo: db.prepare(`
    INSERT INTO torneos (id, club_id, nombre, formato) VALUES (?, ?, ?, ?)
  `),
  updateTorneoEstado: db.prepare('UPDATE torneos SET estado = ? WHERE id = ?'),

  // Llaves
  getLlaves: db.prepare(`
    SELECT l.*, 
           te1.nombre as e1_nombre, te2.nombre as e2_nombre,
           teg.nombre as ganador_nombre
    FROM llaves l
    LEFT JOIN torneo_equipos te1 ON l.equipo1_id = te1.id
    LEFT JOIN torneo_equipos te2 ON l.equipo2_id = te2.id
    LEFT JOIN torneo_equipos teg ON l.ganador_id = teg.id
    WHERE l.torneo_id = ?
    ORDER BY l.ronda DESC, l.posicion
  `),

  // Equipos del torneo
  getTorneoEquipos: db.prepare('SELECT * FROM torneo_equipos WHERE torneo_id = ? ORDER BY seed, nombre'),
  insertTorneoEquipo: db.prepare(`
    INSERT INTO torneo_equipos (id, torneo_id, equipo_id, nombre, seed)
    VALUES (?, ?, ?, ?, ?)
  `),
  insertLlave: db.prepare(`
    INSERT INTO llaves (id, torneo_id, ronda, posicion, equipo1_id, equipo2_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  updateLlaveGanador: db.prepare(`
    UPDATE llaves SET ganador_id = ?, partido_id = ? WHERE id = ?
  `),
};

module.exports = { db, helpers };
