# App de conductores — "Mis Rutas"

Vive **dentro del mismo sitio** que ya tienes en
`https://super-meadow-418f.ra-ibarra.workers.dev/`, en la carpeta `conductor/`.
No es un sitio ni un dominio aparte: sube junto con el resto de tus
archivos y queda disponible en `.../conductor/`. Usa la **misma base de
Supabase**, así que todo lo que un conductor crea en su app aparece de
inmediato en el panel web (y viceversa).

## 1. Ejecutar el SQL nuevo
1. Entra a tu proyecto en Supabase → **SQL Editor**.
2. Pega el contenido de `supabase/002_conductor_auth.sql` y ejecútalo.
   (Puedes volver a ejecutarlo sin problema si algo falla a mitad de camino).

Esto agrega, sin tocar nada de lo que ya funciona en el panel web:
- Cuentas de conductor (teléfono + contraseña) vía **Supabase Auth**.
- Cada conductor solo puede ver/crear/editar/borrar **sus propias** rutas
  (Postgres lo impone con Row Level Security, no depende del frontend).
- Un "número de ruta" que ahora lo asigna la base de datos automáticamente,
  para que nunca choquen dos rutas creadas al mismo tiempo por distintos
  conductores (o por un conductor y el panel web a la vez).
- El panel web recibe los cambios **en vivo** (Supabase Realtime): si un
  conductor crea una ruta desde su celular, aparece sola en el panel sin
  recargar la página.

## 2. Configurar Authentication en el dashboard de Supabase
Ve a **Authentication → Providers → Email** y desactiva **"Confirm email"**.
La app arma internamente un correo a partir del teléfono (el conductor
nunca lo ve ni lo escribe); como ese correo no existe de verdad, nunca
podría confirmarse, así que hay que dejar el login habilitado sin ese paso.

Opcional pero recomendado, en **Authentication → Settings**:
- **Password minimum length:** 8.
- Revisa **Authentication → Rate Limits**: los valores por defecto de
  Supabase ya protegen contra fuerza bruta e intentos masivos de registro
  (no hace falta tocarlos).

## 3. Subir los archivos nuevos
Se agregó la carpeta `conductor/` (HTML, CSS y JS) y se modificó
`js/app.js` del panel (para no borrar nunca una ruta creada por un
conductor — ver detalle más abajo). No se tocó nada del diseño ni de los
otros 8 módulos del panel.

Cómo subirlo depende de cómo tengas conectado hoy ese Worker/Pages a tus
archivos:

- **Si el sitio se despliega desde un repositorio de GitHub (Cloudflare
  Pages conectado a Git):** agrega la carpeta `conductor/` al repo junto
  al resto (`index.html`, `css/`, `js/`), reemplaza `js/app.js` por la
  versión nueva, haz commit y push. Cloudflare vuelve a desplegar solo.
- **Si lo subes con Wrangler (`wrangler deploy` / `wrangler pages
  deploy`):** copia la carpeta `conductor/` dentro de tu carpeta de
  assets estáticos (junto a `index.html`) y reemplaza `js/app.js`, luego
  vuelve a correr el mismo comando de deploy que usas normalmente.

No hace falta crear un Worker ni un proyecto de Cloudflare nuevo: al ser
contenido estático, el mismo dominio que ya tienes queda respondiendo
`/conductor/` sin nada adicional que configurar. Cloudflare sirve el sitio
desde su red 24/7 igual que hoy; no depende de que tu computador esté
encendido.

## 4. Cómo se usa
- Un conductor entra a `https://super-meadow-418f.ra-ibarra.workers.dev/conductor/`,
  toca **"Registrarme"**, ingresa nombre, apellido, su número de teléfono y
  una contraseña (mínimo 8 caracteres, con letras y números).
- Desde ahí solo ve y administra **sus propias** rutas: crear, editar,
  eliminar, con foto de inicio y "Récord", tal como en el panel.
- Puede agregar el acceso a la pantalla de inicio de su celular (Safari:
  Compartir → "Agregar a inicio"; Chrome: menú → "Instalar app") para que
  quede como una app normal.
- Si ya cargaste conductores desde el panel web (módulo **Conductores**)
  con su número de teléfono, al registrarse la cuenta nueva se **vincula**
  sola a esa ficha existente en vez de duplicarla.

## 5. Una limitación a tener en cuenta
Evita usar **"Importar"** o **"↺ Borrar todos los datos"** sobre el módulo
de **Rutas** justo mientras un conductor está creando una ruta al mismo
tiempo: esas dos acciones siguen siendo operaciones masivas explícitas
("reemplazar/borrar todo lo de este módulo") y, si coinciden con el mismo
instante exacto, podrían pisar esa ruta. El uso normal del día a día
(crear, editar, borrar una ruta a la vez, desde el panel o desde el
celular) nunca tiene ese problema — se corrigió específicamente para eso.

---

## Qué se cambió en el panel web (`js/app.js`) y por qué

La tabla `rutas` ahora la escriben **dos apps a la vez** (el panel y la
app de conductores), así que dejó de ser seguro seguir usando el patrón
"borro toda la tabla y la reinserto completa" que usan los otros 8
módulos: si un conductor creaba una ruta justo cuando el panel guardaba
cualquier otro cambio, esa ruta nueva se borraba sola (porque el panel no
la tenía en su copia en memoria). Los cambios puntuales:

- `submitForm`, al borrar (`confirmDelete`) y al restaurar de la papelera
  (`restoreFromTrash`) ahora escriben **solo la fila de ruta que cambió**
  (`insert`/`update`/`delete` puntual) en vez de reemplazar toda la tabla.
- Al crear una ruta nueva desde el panel, el número de ruta ya no se
  calcula como "el más alto que veo + 1" (podía chocar con una ruta creada
  segundos antes por un conductor) — lo asigna la base de datos de forma
  atómica.
- Se agregó una suscripción a Supabase Realtime sobre `rutas`, así el
  panel se actualiza solo cuando algo cambia ahí, venga de un conductor o
  de otra pestaña del panel.

El resto de la app (los otros 8 módulos, catálogos, papelera, historial,
importar/exportar Excel) no se tocó.
