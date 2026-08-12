# Migración a Supabase — Instrucciones de configuración

## 1. Crear proyecto en Supabase
1. Ve a https://supabase.com → **New project**.
2. Espera a que se aprovisione la base de datos.

## 2. Ejecutar el SQL
1. En el dashboard, entra a **SQL Editor**.
2. Pega el contenido de `supabase/schema.sql` y ejecútalo.
   - Crea la tabla `app_storage` (clave/valor con JSONB).
   - Inserta las 4 filas iniciales vacías.
   - Habilita RLS con políticas de acceso público (sin login), para los roles `anon` y `authenticated`.

## 3. Configurar las credenciales en el frontend
1. En el dashboard: **Project Settings → API**.
2. Copia el **Project URL** y la **anon public key**.
3. Edita `js/supabase-config.js` y reemplaza:
   ```js
   const SUPABASE_URL = "https://TU-PROYECTO.supabase.co";
   const SUPABASE_ANON_KEY = "TU-ANON-PUBLIC-KEY";
   ```
   con tus valores reales.

## 4. Servir la app
Como ahora hace peticiones de red (fetch a Supabase), ábrela mediante un servidor local en vez de `file://`, por ejemplo:
```bash
npx serve .
# o
python3 -m http.server 8000
```
Y visita `http://localhost:8000` (o el puerto que indique).

## 5. Verificar
- Al abrir la app, `loadDB()` trae los datos desde Supabase (`app_storage`).
- Cada guardado (`persistDB`, `persistCat`, `persistTrash`, `persistLog`) hace `upsert` sobre la fila correspondiente.
- El indicador "✓ Guardado automáticamente" sigue funcionando igual.
- "↺ Borrar todos los datos" ahora borra las filas en Supabase y vuelve a sembrar los datos por defecto.

---

## Qué se cambió y por qué

**Diseño de la migración:** la app original guardaba 4 bloques en `localStorage`
(`flota_data_v1`, `flota_catalogos_v1`, `flota_trash_v1`, `flota_log_v1`),
cada uno como un blob JSON completo (arrays de registros por módulo,
catálogos, papelera y log de actividad).

En vez de rediseñar el modelo de datos a tablas relacionales por módulo
(lo que habría implicado reescribir todo el CRUD, los cálculos y el
render de cada uno de los 9 módulos), se creó **una sola tabla clave-valor**
(`app_storage`, columna `value jsonb`) donde cada fila reemplaza 1 a 1
una clave de `localStorage`. Esto permite:
- Conservar el 100% de la arquitectura, nombres de funciones y lógica
  (`DB`, `CAT`, `TRASH`, `LOG` siguen siendo los mismos objetos en memoria
  con la misma forma; todo el resto del código —cálculos, render, CRUD—
  no cambió ni una línea).
- Cambiar únicamente la capa de persistencia: `loadDB`, `persistDB`,
  `persistCat`, `persistTrash`, `persistLog` y `resetAll`, que ahora son
  `async` y usan el SDK oficial `@supabase/supabase-js` en vez de
  `localStorage.getItem/setItem/removeItem`.

### Archivos modificados
- `js/app.js`
  - Cabecera: se crea el cliente `supabaseClient`.
  - `loadDB()`, `persistDB()`, `persistCat()`, `persistTrash()`,
    `persistLog()`: reemplazadas por versiones `async` que leen/escriben
    en Supabase (`select`/`upsert`).
  - `resetAll()`: ahora `async`, borra las filas en Supabase en vez de
    `localStorage.removeItem`.
  - Arranque (`DOMContentLoaded`): se agrega `await loadDB()` antes de
    renderizar, ya que la carga ahora es asíncrona (petición de red).

### Archivos nuevos
- `js/supabase-config.js`: URL y anon key del proyecto (a completar).
- `supabase/schema.sql`: tabla `app_storage`, datos semilla y políticas RLS.

### Archivos sin cambios
- `index.html` (solo se agregaron los `<script>` del SDK de Supabase y de
  la config, imprescindibles para que la librería exista; ningún cambio
  de estructura, texto ni maquetado).
- `css/style.css` — sin cambios.
- `js/data.js` — sin cambios (SEED y CATALOGOS siguen igual).

### Notas
- No se agregó autenticación: las políticas RLS dan acceso completo
  (`select`/`insert`/`update`/`delete`) a los roles `anon` y
  `authenticated`, replicando el acceso público sin login que ya tenía
  la app con `localStorage`.
- Como ahora depende de red, la app ya no funciona abriendo el archivo
  `index.html` directamente (`file://`); debe servirse por http (ver
  paso 4).
