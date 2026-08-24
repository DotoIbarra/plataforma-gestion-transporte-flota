# Control de Flota — Transporte OGV

Sistema web interno para la gestión integral de la flota vehicular de **Transporte Osvaldo Gutiérrez Velásquez (Transporte OGV)** — Rut 20.752.714-9.

Permite administrar vehículos, seguros, impuestos, conductores, talleres, rutas de viaje, multas, mantenimiento, fletes e incidencias desde un panel único, con roles de usuario, notificaciones internas, auditoría de acciones y seguimiento GPS en vivo de las rutas activas — además de ofrecer un portal independiente para que los conductores registren sus rutas desde el celular.

> Uso interno y exclusivo del personal autorizado de Transporte OGV.

---

## Índice

1. [Descripción general](#descripción-general)
2. [Arquitectura](#arquitectura)
3. [Módulos del sistema](#módulos-del-sistema)
4. [Usuarios y roles](#usuarios-y-roles)
5. [Notificaciones y auditoría](#notificaciones-y-auditoría)
6. [Mapa operacional y seguimiento GPS](#mapa-operacional-y-seguimiento-gps)
7. [Portal del conductor](#portal-del-conductor)
8. [Estructura del proyecto](#estructura-del-proyecto)
9. [Requisitos](#requisitos)
10. [Instalación y despliegue](#instalación-y-despliegue)
11. [Base de datos](#base-de-datos)
12. [API — Endpoints](#api--endpoints)
13. [Seguridad](#seguridad)
14. [Historial / migración](#historial--migración)
15. [Licencia y uso](#licencia-y-uso)

---

## Descripción general

Control de Flota es una aplicación **web responsive** que digitaliza el control operativo de una flota de transporte de carga: qué vehículos existen, en qué estado están, quién los conduce, qué rutas hacen (y dónde están *ahora mismo*), qué documentación (seguros, impuestos, multas) está vigente o vencida, qué incidencias se han reportado en ruta y qué mantenimiento requieren.

El sistema está pensado para tres tipos de usuarios:

- **Administradores**: acceden al panel completo (`/index.html`) con las 10 áreas de gestión, dashboard de indicadores, mapa operacional, auditoría y control total de datos, incluida la gestión de usuarios del panel.
- **Operadores / despachadores**: acceden al mismo panel con sesión propia, pero solo a la operación del día a día (flota, rutas, fletes, conductores, incidencias, etc.); no ven la sección de **Usuarios** ni pueden realizar acciones reservadas a administradores.
- **Conductores**: acceden a un portal ligero tipo PWA (`/conductor/index.html`) donde solo ven y gestionan **sus propias rutas asignadas**, incluyendo carga de evidencia fotográfica, cambios de estado del servicio, reporte de incidencias y envío de su ubicación en vivo.

## Arquitectura

| Capa | Tecnología |
|---|---|
| Frontend admin | HTML5 + CSS3 + JavaScript vanilla (sin frameworks ni build step) |
| Frontend conductor | HTML5 + CSS3 + JavaScript vanilla, empaquetado como PWA instalable |
| Backend | PHP 8 (API REST propia, sin frameworks) |
| Base de datos | MySQL / MariaDB (vía `mysqli`, consultas preparadas) |
| Mapa | Leaflet 1.9.4 (cargado perezosamente desde CDN solo al abrir "Mapa operacional") |
| Autenticación | Sesiones nativas de PHP con cookies `httponly` + `secure`, dos ámbitos independientes (admin/operador y conductor), con rol embebido en la sesión de admin |
| Hosting | cPanel / hosting compartido (WebHostChile), con Apache + `.htaccess` |

**Flujo general:** el navegador consume una API JSON propia en `/api/*` (no hay ningún framework de por medio: cada endpoint es un archivo PHP independiente). La sesión del panel (admin u operador) se maneja con cookie `flota_admin_sess`; la del conductor con una cookie de sesión separada, de modo que ambos accesos conviven sin interferir entre sí.

Todos los módulos "simples" (flota, seguros, impuestos, conductores, talleres, multas, mantenimiento, fletes, incidencias) comparten un mismo patrón CRUD genérico (`api/crud_helpers.php`): cada endpoint solo define su tabla y columnas, y reutiliza `list_rows()` / `upsert_row()` / `delete_row()`. Sobre esa misma base backend hay dos capas transversales agregadas:

- **`api/notify.php`**: inserta notificaciones internas (campanita del panel) cuando el conductor hace algo relevante (reporta una incidencia, cambia el estado de una ruta).
- **`api/auditoria.php`**: deja constancia permanente de "quién hizo qué" (acciones del panel y del conductor), con el actor siempre resuelto en el servidor, nunca en lo que mande el navegador.

El módulo de **rutas** sigue siendo el más particular, porque además debe:

- vincular automáticamente cada ruta al conductor correspondiente (`conductor_user_id`), buscando coincidencia por nombre completo;
- exponer una copia filtrada de sí mismo (`api/conductor_rutas/`) para que cada conductor solo vea sus propias rutas, con endpoints propios para avanzar el estado del servicio (`estado.php`) y reportar su posición GPS (`ubicacion.php`);
- guardar el historial de posiciones en `rutas_ubicaciones`, consultable por el admin vía `api/rutas/ubicaciones.php` para dibujar el trayecto en el mapa.

> El proyecto fue migrado desde una versión anterior sobre **Supabase (PostgreSQL)** a esta arquitectura propia en PHP + MySQL. El cliente JavaScript (`apiFetch`) mantiene la misma firma `{data, error}` que usaba `supabase-js`, para no tener que reescribir toda la lógica de UI.

## Módulos del sistema

| Módulo | Ícono | Grupo | Descripción |
|---|:---:|---|---|
| **Flota de vehículos** | 🚚 | Operación | Alta de vehículos: tipo, marca/modelo, placa, N° de serie, color, año, carga máxima y estado (Disponible / En viaje / En mantenimiento / No disponible). |
| **Rutas de viaje** | 🗺️ | Operación | Registro de cada viaje: origen/destino, obra, conductor, peso de carga, costo por Kg, foto de inicio y de cierre (con guía y N° de reporte). Ahora con **estado de servicio** (Asignado → Aceptado → En ruta → En destino → Finalizado, o Cancelado) y última posición GPS conocida. |
| **Fletes** | 📦 | Operación | Registro comercial de fletes: tipo de vehículo usado, cliente/obra, valores asociados. |
| **Mantenimiento** | 🛠️ | Operación | Mantenimientos preventivos (paquetes 01–05) y correctivos, con detalle de servicios incluidos por paquete. |
| **Seguros** | 🛡️ | Cumplimiento | Póliza por vehículo, aseguradora, vigencia y estado calculado automáticamente (vigente / por vencer / vencida). |
| **Impuestos** | 🧾 | Cumplimiento | Pago de impuestos anuales por vehículo, con importe y fecha de pago. |
| **Multas** | 🚨 | Cumplimiento | Infracciones asociadas a vehículo/conductor, con estado de pago pendiente/pagado. |
| **Incidencias** *(nuevo)* | ⚠️ | Cumplimiento | Accidentes, fallas mecánicas, retrasos, daños de carga, robos, etc. reportados desde el panel o directamente por el conductor desde su celular. Con tipo, gravedad (Baja/Media/Alta/Crítica), estado (Abierta/En revisión/Resuelta/Cerrada), evidencia y solución. El conductor solo puede crear incidencias, nunca editar el seguimiento que hace el administrador. |
| **Conductores** | 🧑‍✈️ | Operación | Ficha del conductor: licencia, clase, municipalidad, controles médicos/psicotécnicos, calificación (1–5 estrellas). |
| **Talleres** | 🔧 | Operación | Directorio de talleres externos usados para mantenimiento y reparaciones. |

Además, el panel incluye:

- **Dashboard** con KPIs en vivo (vehículos disponibles, deuda por multas, fletes registrados, mantenimientos en curso, ranking de obras, e **incidencias abiertas** destacando las de gravedad alta/crítica).
- **📍 Mapa operacional** *(nuevo)*: ver sección dedicada más abajo.
- **🔒 Auditoría** *(nuevo)*: ver sección dedicada más abajo.
- **👤 Usuarios y roles** *(nuevo, solo visible para administradores)*: ver sección dedicada más abajo.
- **Campanita de notificaciones** *(nuevo)* en el sidebar, con contador de no leídas.
- **Papelera** de elementos eliminados y **bitácora** de actividad diaria, persistidas en la tabla `app_storage` (complementa, y no reemplaza, la auditoría de sesión completa descrita abajo).
- Catálogos configurables (marcas/modelos, tipos de combustible, infracciones, tipos y gravedad de incidencia, etc.).

## Usuarios y roles

El panel de administración ahora soporta dos roles sobre la misma tabla `admin_users`:

- **Administrador (`admin`)**: acceso total, incluida la sección **Usuarios y roles**, donde puede crear, editar y eliminar cuentas del panel y asignarles rol.
- **Operador / despachador (`operador`)**: gestiona la operación diaria (flota, rutas, fletes, conductores, incidencias, etc.) pero no ve ni puede acceder a la gestión de usuarios.

Reglas aplicadas en el backend (nunca solo en el frontend):

- `require_admin()` exige sesión activa (admin u operador) para cualquier endpoint del panel.
- `require_role_admin()` exige además que el rol en sesión sea `admin`; se usa en `api/usuarios/*` para bloquear a los operadores incluso si intentan llamar el endpoint directamente.
- No se puede eliminar el propio usuario en sesión, ni eliminar al último administrador restante del sistema (evita que el sistema se quede sin nadie con permisos completos).
- Si un administrador se edita a sí mismo y cambia su propio rol, la sesión activa se actualiza al instante.

## Notificaciones y auditoría

Se agregaron dos mecanismos complementarios, pensados para que el panel se entere de lo que pasa "en la calle" sin tener que revisar cada módulo:

- **Notificaciones** (`notificaciones`, `api/notify.php`, `api/notificaciones/*`): campanita en el sidebar visible para cualquier usuario logueado del panel (admin u operador). Se generan automáticamente cuando un conductor reporta una incidencia o cambia el estado de una ruta (acepta, inicia, llega a destino o cancela). Se pueden marcar todas como leídas.
- **Auditoría** (`auditoria`, `api/auditoria.php`, `api/auditoria_log/list.php`): registro permanente de "quién hizo qué" — creaciones, actualizaciones y cambios de estado — tanto del panel (admin/operador) como de la app del conductor, mostrando los últimos 500 eventos con el actor, la acción, la entidad afectada y el detalle. El actor nunca se toma de lo que envía el navegador: siempre se resuelve en el servidor a partir de la sesión activa.

Ambos mecanismos están diseñados para no interrumpir la operación real: si `notify()` o `audit()` fallan por cualquier motivo, el error se registra en el log del servidor pero la acción original (guardar una ruta, cambiar un estado) se completa igual.

## Mapa operacional y seguimiento GPS

Nuevo módulo **📍 Mapa operacional**, construido sobre Leaflet:

- Muestra en un mapa (centrado por defecto en Chile central) todas las rutas activas que tienen al menos una posición GPS reportada, con la hora de la última actualización.
- La posición se captura de forma **interina, vía navegador**: el conductor todavía no cuenta con un dispositivo GPS dedicado en el vehículo, así que mientras el servicio está activo, la app del conductor usa `navigator.geolocation` del propio celular para enviar pings periódicos (`api/conductor_rutas/ubicacion.php`).
- Cada ping actualiza la última posición conocida directamente en `rutas` (para que el mapa sea una sola consulta rápida) y además queda guardado en el historial `rutas_ubicaciones`, consultable por ruta vía `api/rutas/ubicaciones.php` para reconstruir el trayecto completo.
- El diseño deja el camino abierto a GPS embarcado a futuro: el mismo endpoint podría recibir los pings de hardware dedicado en vez de (o además de) los del teléfono, sin tocar el resto del sistema.
- Un conductor solo puede reportar ubicación y avanzar el estado de una ruta que sea suya y que siga abierta (no `Finalizado` ni `Cancelado`); esa validación se hace siempre en el servidor.

El **estado de servicio** de cada ruta (`estadoServicio`) sigue una secuencia controlada por el backend: `Asignado → Aceptado → En ruta → En destino`, con `Cancelado` disponible en cualquier punto antes del cierre. `Finalizado` no se setea desde este flujo: se marca automáticamente al guardar la foto de cierre (Report) en `conductor_rutas/save.php`.

## Portal del conductor

Aplicación independiente en `/conductor/`, instalable como **PWA** (`manifest.json` incluido):

- Registro y login propio por **número de teléfono** (`api/conductor_auth/`), separado del login del panel.
- Al registrarse, el sistema enlaza automáticamente la cuenta con una ficha de conductor preexistente creada por el administrador (si el teléfono coincide), o crea una ficha básica nueva.
- Lista solo las **rutas asignadas al conductor autenticado** (`api/conductor_rutas/`).
- Permite avanzar el **estado del servicio** de cada ruta (aceptar, iniciar, marcar llegada a destino, o cancelar) mediante `api/conductor_rutas/estado.php`.
- Envía la **ubicación en vivo** mientras la ruta está activa y la app abierta (`api/conductor_rutas/ubicacion.php`), mostrando un aviso si el navegador no da permiso de geolocalización.
- Permite marcar una ruta como **realizada**, adjuntando la foto de cierre (`fotoFin`) antes de habilitar el botón de confirmación.
- Permite **reportar incidencias** propias (accidente, falla mecánica, daño de carga, etc.) desde `api/conductor_incidencias/`, quedando visibles de inmediato para el panel vía notificación.

## Estructura del proyecto

```
ControlFlotaOGV/
├── index.html                     # Panel de administración (SPA)
├── css/style.css                   # Estilos del panel admin
├── js/
│   ├── app.js                      # Lógica completa del panel (módulos, dashboard, mapa, auditoría, CRUD, UI)
│   └── data.js                     # Catálogos semilla (marcas, modelos, tipos, etc.)
├── conductor/                      # Portal del conductor (PWA independiente)
│   ├── index.html
│   ├── manifest.json
│   ├── css/style.css
│   └── js/app.js                   # Incluye envío de ubicación GPS y cambio de estado de ruta
├── img/                             # Logo y favicons
├── api/                             # Backend REST en PHP
│   ├── config.php                   # Conexión a BD + helpers de respuesta JSON
│   ├── auth.php                     # Sesión, autenticación y rol (admin/operador) del panel
│   ├── conductor_auth.php           # Sesión y autenticación de conductores
│   ├── crud_helpers.php             # CRUD genérico reutilizado por los módulos simples
│   ├── notify.php                   # Notificaciones internas (campanita del panel)
│   ├── auditoria.php                # Registro de auditoría (quién hizo qué)
│   ├── login.php / logout.php / me.php
│   ├── conductor_auth/               # login, register, logout, me (conductores)
│   ├── flota/  seguros/  impuestos/  conductores/  talleres/
│   ├── rutas/                        # list · save · delete · ubicaciones (historial GPS por ruta)
│   ├── multas/  mantenimiento/  fletes/
│   ├── incidencias/                  # list · save · delete (vista de administración)
│   ├── conductor_incidencias/        # list · save (el conductor solo crea, nunca edita)
│   ├── conductor_rutas/              # list · save · estado (máquina de estados) · ubicacion (ping GPS) · delete
│   ├── notificaciones/               # list · marcar_leidas
│   ├── auditoria_log/                # list (últimos 500 eventos)
│   ├── usuarios/                     # list · save · delete (solo rol admin)
│   ├── conductor_data/                # datos de referencia para el portal del conductor
│   └── storage/                       # catálogos, papelera y bitácora (tabla app_storage)
├── .htaccess                         # Forzado de HTTPS + configuración PHP de cPanel
└── php.ini / .user.ini                # Configuración PHP del hosting
```

## Requisitos

- Hosting compartido o VPS con **PHP 8.0+** y extensión `mysqli` habilitada.
- Base de datos **MySQL 5.7+ / MariaDB 10.3+** (se usa `JSON` nativo en la tabla `app_storage`).
- Certificado SSL activo (el `.htaccess` fuerza redirección a HTTPS).
- No requiere Node.js, Composer ni ningún proceso de build: es HTML/CSS/JS y PHP servidos directamente. El mapa operacional carga Leaflet desde CDN público solo cuando se visita esa sección.

## Instalación y despliegue

1. **Subir los archivos** a la raíz del hosting (`public_html/` en cPanel), respetando la estructura del proyecto.
2. **Crear la base de datos** en cPanel (Bases de datos MySQL) y un usuario con permisos completos sobre ella.
3. **Configurar la conexión** en `api/config.php`:
   ```php
   define('DB_HOST', 'localhost');
   define('DB_NAME', 'tu_base');
   define('DB_USER', 'tu_usuario');
   define('DB_PASS', 'tu_contraseña');
   ```
4. **Crear las tablas** (ver [Base de datos](#base-de-datos) más abajo), incluyendo la columna `rol` en `admin_users` y el usuario administrador inicial (con `rol = 'admin'`).
5. **Verificar HTTPS**: el `.htaccess` redirige automáticamente todo tráfico HTTP a HTTPS; confirma que el certificado SSL del dominio esté activo antes de publicar.
6. Acceder a `https://tu-dominio.cl/` para el panel de administración y a `https://tu-dominio.cl/conductor/` para el portal de conductores.

> El archivo `.htaccess` incluye directivas específicas generadas por cPanel (rutas de log, límites de subida, sesiones) — revísalas y ajústalas si migras a otro proveedor de hosting.

## Base de datos

El backend asume las siguientes tablas (una por módulo, todas con clave `nro` autoincremental como identificador de negocio, salvo las de soporte transversal):

| Tabla | Propósito |
|---|---|
| `admin_users` | Usuarios del panel (`email`, `password_hash`, `nombre`, **`rol`**: `admin` u `operador`). |
| `conductor_users` | Cuentas de acceso de conductores (`telefono`, `password_hash`). |
| `flota` | Vehículos de la flota. |
| `seguros` | Pólizas de seguro por vehículo. |
| `impuestos` | Pagos de impuestos por vehículo. |
| `conductores` | Fichas de conductores (enlazadas opcionalmente a `conductor_users` vía `conductor_user_id`). |
| `talleres` | Talleres externos. |
| `rutas` | Viajes/rutas, con `conductor_user_id` recalculado en cada guardado, más `estadoServicio`, `lat`, `lng` y `ubicacionTs` para el mapa operacional. |
| `rutas_ubicaciones` *(nueva)* | Historial de pings GPS por ruta (`ruta_nro`, `lat`, `lng`, `precision_m`, `creado_en`), usado para reconstruir el trayecto. |
| `multas` | Infracciones registradas. |
| `mantenimiento` | Mantenimientos preventivos/correctivos. |
| `fletes` | Registro de fletes. |
| `incidencias` *(nueva)* | Reportes de incidencias en ruta (tipo, gravedad, descripción, evidencia, estado, solución, quién la reportó). |
| `notificaciones` *(nueva)* | Avisos internos para el panel (tipo, mensaje, entidad relacionada, leída/no leída). |
| `auditoria` *(nueva)* | Registro permanente de acciones (actor, tipo de actor, acción, entidad afectada, detalle). |
| `app_storage` | Almacén clave-valor en JSON para catálogos, papelera y bitácora diaria (`storage_key`, `value`). |

Todas las consultas usan **sentencias preparadas** (`mysqli::prepare` + `bind_param`), y el guardado (`upsert_row`) calcula automáticamente el siguiente `nro` disponible cuando no se envía uno.

## API — Endpoints

Todas las rutas cuelgan de `/api/`. Los endpoints de administración requieren sesión de panel (`require_admin()`, o `require_role_admin()` cuando son exclusivos de administradores); los de conductor requieren sesión de conductor (`require_conductor()`).

**Autenticación panel (admin/operador)**
- `POST /api/login.php` · `POST /api/logout.php` · `GET /api/me.php`

**Autenticación conductor**
- `POST /api/conductor_auth/login.php`
- `POST /api/conductor_auth/register.php`
- `POST /api/conductor_auth/logout.php`
- `GET /api/conductor_auth/me.php`

**Módulos (patrón repetido para `flota`, `seguros`, `impuestos`, `conductores`, `talleres`, `rutas`, `multas`, `mantenimiento`, `fletes`, `incidencias`)**
- `GET  /api/{modulo}/list.php`
- `POST /api/{modulo}/save.php`
- `POST /api/{modulo}/delete.php`

**Rutas — seguimiento GPS**
- `GET /api/rutas/ubicaciones.php?nro=` — historial de pings de una ruta puntual, para dibujar el trayecto en el mapa.

**Portal del conductor**
- `GET  /api/conductor_rutas/list.php` — rutas del conductor autenticado.
- `POST /api/conductor_rutas/estado.php` — avanza el estado del servicio de una ruta propia.
- `POST /api/conductor_rutas/ubicacion.php` — reporta la posición GPS actual de una ruta propia activa.
- `GET  /api/conductor_incidencias/list.php` · `POST /api/conductor_incidencias/save.php` — incidencias reportadas por el conductor.
- `GET /api/conductor_data/reference.php` — catálogos de referencia para el portal.

**Notificaciones**
- `GET  /api/notificaciones/list.php` — últimas 30 notificaciones + contador de no leídas.
- `POST /api/notificaciones/marcar_leidas.php` — marca todas como leídas.

**Auditoría**
- `GET /api/auditoria_log/list.php` — últimos 500 eventos de auditoría (panel y conductor).

**Usuarios y roles** *(solo rol `admin`)*
- `GET  /api/usuarios/list.php`
- `POST /api/usuarios/save.php`
- `POST /api/usuarios/delete.php`

**Almacenamiento auxiliar (catálogos, papelera, bitácora)**
- `POST /api/storage/save.php`
- `GET  /api/storage/get_all.php`
- `POST /api/storage/reset_all.php`

Todas las respuestas son JSON. Los errores devuelven `{ "error": "mensaje" }` junto con el código HTTP correspondiente (401 no autenticado, 403 sin permisos de rol, 405 método no permitido, 409 conflicto/estado inválido, 422 datos inválidos, etc.).

## Seguridad

- Contraseñas de administradores/operadores y conductores almacenadas con `password_hash()` (bcrypt) y verificadas con `password_verify()`.
- Cookies de sesión configuradas como `httponly`, `secure` y `SameSite=Lax`, con **regeneración de ID de sesión** en cada login (mitiga session fixation).
- Mensajes de error de login **idénticos** para correo/teléfono inexistente y para contraseña incorrecta, evitando enumeración de cuentas.
- Todas las consultas SQL usan sentencias preparadas — sin concatenación directa de input del usuario.
- El campo `conductor_user_id` de una ruta **nunca lo decide el navegador**: se recalcula siempre en el servidor a partir del nombre del conductor, para impedir que un conductor se autoasigne rutas ajenas.
- Los endpoints de estado y ubicación de ruta (`estado.php`, `ubicacion.php`) verifican en el servidor que la ruta pertenezca al conductor autenticado y que siga abierta, antes de aceptar cualquier cambio.
- Las acciones reservadas a administradores (gestión de usuarios) usan `require_role_admin()`, que exige el rol `admin` guardado en sesión (nunca uno enviado por el cliente); un operador no puede acceder aunque llame el endpoint directamente.
- No se puede eliminar el propio usuario ni al último administrador restante del sistema.
- La **auditoría** registra el actor real (resuelto en el servidor a partir de la sesión) para toda acción sensible, tanto del panel como del portal del conductor.
- El `.htaccess` fuerza HTTPS en todo el sitio.

> ⚠️ **Nota sobre este repositorio:** al ser privado, `api/config.php` se mantiene con las credenciales reales de conexión a la base de datos de producción, tal como se usa en el hosting. Si en algún momento este repositorio deja de ser privado o se comparte con terceros, esas credenciales deben rotarse y moverse a variables de entorno o a un archivo de configuración fuera del control de versiones.

## Historial / migración

Este sistema reemplaza una versión previa que usaba **Supabase (PostgreSQL)** como backend, operando enteramente desde el navegador. La migración actual:

- Reemplazó el cliente `supabase-js` por un cliente propio (`apiFetch` en `js/app.js`) que respeta la misma firma `{data, error}`, minimizando cambios en la capa de UI.
- Reemplazó las políticas de *Row Level Security* de Supabase por autenticación de sesión + validación en servidor (`require_admin()`, `require_role_admin()`, `require_conductor()`, recálculo server-side de `conductor_user_id`).
- Los datos semilla originales provienen del libro de control de flota en Excel (`control-de-flota-vehicular.xlsx`) usado antes de digitalizar el proceso.
- Sobre esa base ya migrada se agregaron, en una segunda etapa: roles de usuario (admin/operador), el módulo de incidencias (panel y conductor), notificaciones internas, auditoría de acciones, y el mapa operacional con seguimiento GPS interino vía navegador del conductor.

## Licencia y uso

Software interno de **Transporte Osvaldo Gutiérrez Velásquez (Transporte OGV)** — Rut 20.752.714-9. Uso exclusivo del personal autorizado de la empresa. No está licenciado para redistribución ni uso por terceros ajenos a la organización.
