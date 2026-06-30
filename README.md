# Da El Punto — Sistema de Gestión Deportiva

Sistema en tiempo real para clubes de padel. Tanteador + TV + Panel de encargado.

## Stack
- Node.js + Express
- WebSockets (ws)
- SQLite (better-sqlite3)
- HTML/CSS/JS vanilla — sin frameworks

## Instalación local

```bash
npm install
npm start
```

Abre http://localhost:3000

## Deploy en Railway

1. Crear proyecto en railway.app
2. Conectar este repo de GitHub
3. Railway detecta el Procfile y deployea automáticamente
4. Variables de entorno opcionales:
   - `PORT` — Railway lo setea automáticamente
   - `DB_PATH` — path de la base de datos (default: ./data/daelpunto.db)

## URLs del sistema

| URL | Quién la usa |
|-----|-------------|
| `/` | Menú principal |
| `/encargado` | Encargado del club — panel general |
| `/cancha` | Jugador — tanteador en el celu |
| `/tv` | Pantalla TV — marcador grande |
| `/torneo` | Vista del fixture del torneo |

## Código demo

El sistema viene con un club demo listo para usar:
- **Código:** `DEMO`
- **Canchas:** 8 canchas preconfiguradas

## Crear un nuevo club

Por ahora se hace directo en la DB:
```sql
INSERT INTO clubes (id, nombre, codigo, plan) VALUES ('club-001', 'Mi Club', 'MICLUB', 'club');
INSERT INTO canchas (id, club_id, numero, nombre, tiene_tv) VALUES 
  ('c1', 'club-001', 1, 'Cancha 1', 1),
  ('c2', 'club-001', 2, 'Cancha 2', 1);
```

Próximamente: panel de administración para crear clubes.

## Flujo de uso

1. **Encargado** abre `/encargado` desde la PC del club
2. **Ingresa el código del club** (ej: DEMO)
3. Ve todas las canchas en tiempo real
4. Para una cancha libre → click "Nuevo partido" → completa nombres → confirma
5. **Jugador** abre `/cancha` desde su celu
6. Ingresa código del club y selecciona su cancha
7. Suma puntos tocando "+ Punto"
8. **TV** de la cancha abre `/tv` en fullscreen
9. Selecciona el mismo club y cancha → muestra el marcador automáticamente

Todo se sincroniza en tiempo real vía WebSockets.
