# Control de Flota — Transporte OGV

Sistema web interno para la gestión integral de la flota vehicular de **Transporte Osvaldo Gutiérrez Velásquez (Transporte OGV)** — Rut 20.752.714-9.

Permite administrar vehículos, seguros, impuestos, conductores, talleres, rutas de viaje, multas, mantenimiento y fletes desde un panel único, además de ofrecer un portal independiente para que los conductores registren sus rutas desde el celular.

> Uso interno y exclusivo del personal autorizado de Transporte OGV.

---

## Índice

1. [Descripción general](#descripción-general)
2. [Arquitectura](#arquitectura)
3. [Módulos del sistema](#módulos-del-sistema)
4. [Portal del conductor](#portal-del-conductor)
5. [Estructura del proyecto](#estructura-del-proyecto)
6. [Requisitos](#requisitos)
7. [Instalación y despliegue](#instalación-y-despliegue)
8. [Base de datos](#base-de-datos)
9. [API — Endpoints](#api--endpoints)
10. [Seguridad](#seguridad)
11. [Historial / migración](#historial--migración)
12. [Licencia y uso](#licencia-y-uso)

---

## Descripción general

Control de Flota es una aplicación **web responsive** que digitaliza el control operativo de una flota de transporte de carga: qué vehículos existen, en qué estado están, quién los conduce, qué rutas hacen, qué documentación (seguros, impuestos, multas) está vigente o vencida, y qué mantenimiento requieren.

El sistema está pensado para dos tipos de usuarios:

- **Administradores**: acceden al panel completo (`/index.html`) con las 8 áreas de gestión, dashboard de indicadores y control total de datos.
- **Conductores**: acceden a un portal ligero tipo PWA (`/conductor/index.html`) donde solo ven y gestionan **sus propias rutas asignadas**, incluyendo carga de evidencia fotográfica.

## Arquitectura

| Capa | Tecnología |
|---|---|
| Frontend admin | HTML5 + CSS3 + JavaScript vanilla (sin frameworks ni build step) |
| Frontend conductor | HTML5 + CSS3 + JavaScript vanilla, empaquetado como PWA instalable |
| Backend | PHP 8 (API REST propia, sin frameworks) |
| Base de datos | MySQL / MariaDB (vía `mysqli`, consultas preparadas) |
| Autenticación | Sesiones nativas de PHP con cookies `httponly` + `secure`, dos ámbitos independientes (admin y conductor) |
| Hosting | cPanel / hosting compartido (WebHostChile), con Apache + `.htaccess` |

**Flujo general:** el navegador consume una API JSON propia en `/api/*` (no hay ningún framework de por medio: cada endpoint es un archivo PHP independiente). La sesión del administrador se maneja con cookie `flota_admin_sess`; la del conductor con una cookie de sesión separada, de modo que ambos accesos conviven sin interferir entre sí.

Todos los módulos "simples" (flota, seguros, impuestos, conductores, talleres, multas, mantenimiento, fletes) comparten un mismo patrón CRUD genérico (`api/crud_helpers.php`): cada endpoint solo define su tabla y columnas, y reutiliza `list_rows()` / `upsert_row()` / `delete_row()`. El módulo de **rutas** es la excepción, porque además debe:

- vincular automáticamente cada ruta al conductor correspondiente (`conductor_user_id`), buscando coincidencia por nombre completo, y
- exponer una copia filtrada de sí mismo (`api/conductor_rutas/`) para que cada conductor solo vea sus propias rutas.

> El proyecto fue migrado desde una versión anterior sobre **Supabase (PostgreSQL)** a esta arquitectura propia en PHP + MySQL. El cliente JavaScript (`apiFetch`) mantiene la misma firma `{data, error}` que usaba `supabase-js`, para no tener que reescribir toda la lógica de UI.

## Módulos del sistema

| Módulo | Ícono | Grupo | Descripción |
|---|:---:|---|---|
| **Flota de vehículos** | 🚚 | Operación | Alta de vehículos: tipo, marca/modelo, placa, N° de serie, color, año, carga máxima y estado (Disponible / En viaje / En mantenimiento / No disponible). |
| **Seguros** | 🛡️ | Cumplimiento | Póliza por vehículo, aseguradora, vigencia y estado calculado automáticamente (vigente / por vencer / vencida). |
| **Impuestos** | 🧾 | Cumplimiento | Pago de impuestos anuales por vehículo, con importe y fecha de pago. |
| **Conductores** | 🧑‍✈️ | Operación | Ficha del conductor: licencia, clase, municipalidad, controles médicos/psicotécnicos, calificación (1–5 estrellas). |
| **Talleres** | 🔧 | Operación | Directorio de talleres externos usados para mantenimiento y reparaciones. |
| **Rutas de viaje** | 🗺️ | Operación | Registro de cada viaje: origen/destino, obra, conductor, peso de carga, costo por Kg, foto de inicio y de cierre (con guía y N° de reporte). |
| **Multas** | 🚨 | Cumplimiento | Infracciones asociadas a vehículo/conductor, con estado de pago pendiente/pagado. |
| **Mantenimiento** | 🛠️ | Operación | Mantenimientos preventivos (paquetes 01–05) y correctivos, con detalle de servicios incluidos por paquete. |
| **Fletes** | 📦 | Operación | Registro comercial de fletes: tipo de vehículo usado, cliente/obra, valores asociados. |

Además, el panel incluye:

- **Dashboard** con KPIs en vivo (vehículos disponibles, deuda por multas, fletes registrados, mantenimientos en curso, ranking de obras).
- **Papelera** de elementos eliminados y **bitácora** de actividad, persistidas en la tabla `app_storage`.
- Catálogos configurables (marcas/modelos, tipos de combustible, infracciones, etc.).

## Portal del conductor

Aplicación independiente en `/conductor/`, instalable como **PWA** (`manifest.json` incluido):

- Registro y login propio por **número de teléfono** (`api/conductor_auth/`), separado del login de administradores.
- Al registrarse, el sistema enlaza automáticamente la cuenta con una ficha de conductor preexistente creada por el administrador (si el teléfono coincide), o crea una ficha básica nueva.
- Lista solo las **rutas asignadas al conductor autenticado** (`api/conductor_rutas/`).
- Permite marcar una ruta como **realizada**, adjuntando la foto de cierre (`fotoFin`) antes de habilitar el botón de confirmación.

## Estructura del proyecto

```
ControlFlotaOGV/
├── index.html                  # Panel de administración (SPA)
├── css/style.css                # Estilos del panel admin
├── js/
│   ├── app.js                   # Lógica completa del panel (módulos, dashboard, CRUD, UI)
│   └── data.js                  # Catálogos semilla (marcas, modelos, tipos, etc.)
├── conductor/                   # Portal del conductor (PWA independiente)
│   ├── index.html
│   ├── manifest.json
│   ├── css/style.css
│   └── js/app.js
├── img/                          # Logo y favicons
├── api/                          # Backend REST en PHP
│   ├── config.php                # Conexión a BD + helpers de respuesta JSON
│   ├── auth.php                  # Sesión y autenticación de administradores
│   ├── conductor_auth.php        # Sesión y autenticación de conductores
│   ├── crud_helpers.php          # CRUD genérico reutilizado por los módulos simples
│   ├── login.php / logout.php / me.php
│   ├── conductor_auth/           # login, register, logout, me (conductores)
│   ├── flota/  seguros/  impuestos/  conductores/  talleres/
│   ├── rutas/  multas/  mantenimiento/  fletes/     # list.php · save.php · delete.php
│   ├── conductor_rutas/          # vista de rutas filtrada por conductor
│   ├── conductor_data/           # datos de referencia para el portal del conductor
│   └── storage/                  # catálogos, papelera y bitácora (tabla app_storage)
├── .htaccess                     # Forzado de HTTPS + configuración PHP de cPanel
└── php.ini / .user.ini            # Configuración PHP del hosting
```

## Requisitos

- Hosting compartido o VPS con **PHP 8.0+** y extensión `mysqli` habilitada.
- Base de datos **MySQL 5.7+ / MariaDB 10.3+** (se usa `JSON` nativo en la tabla `app_storage`).
- Certificado SSL activo (el `.htaccess` fuerza redirección a HTTPS).
- No requiere Node.js, Composer ni ningún proceso de build: es HTML/CSS/JS y PHP servidos directamente.

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
4. **Crear las tablas** (ver [Base de datos](#base-de-datos) más abajo) y, si corresponde, el usuario administrador inicial en `admin_users`.
5. **Verificar HTTPS**: el `.htaccess` redirige automáticamente todo tráfico HTTP a HTTPS; confirma que el certificado SSL del dominio esté activo antes de publicar.
6. Acceder a `https://tu-dominio.cl/` para el panel de administración y a `https://tu-dominio.cl/conductor/` para el portal de conductores.

> El archivo `.htaccess` incluye directivas específicas generadas por cPanel (rutas de log, límites de subida, sesiones) — revísalas y ajústalas si migras a otro proveedor de hosting.

## Base de datos

El backend asume las siguientes tablas (una por módulo, todas con clave `nro` autoincremental como identificador de negocio):

| Tabla | Propósito |
|---|---|
| `admin_users` | Administradores del panel (`email`, `password_hash`, `nombre`). |
| `conductor_users` | Cuentas de acceso de conductores (`telefono`, `password_hash`). |
| `flota` | Vehículos de la flota. |
| `seguros` | Pólizas de seguro por vehículo. |
| `impuestos` | Pagos de impuestos por vehículo. |
| `conductores` | Fichas de conductores (enlazadas opcionalmente a `conductor_users` vía `conductor_user_id`). |
| `talleres` | Talleres externos. |
| `rutas` | Viajes/rutas, con `conductor_user_id` recalculado en cada guardado según el nombre del conductor. |
| `multas` | Infracciones registradas. |
| `mantenimiento` | Mantenimientos preventivos/correctivos. |
| `fletes` | Registro de fletes. |
| `app_storage` | Almacén clave-valor en JSON para catálogos, papelera y bitácora (`storage_key`, `value`). |

Todas las consultas usan **sentencias preparadas** (`mysqli::prepare` + `bind_param`), y el guardado (`upsert_row`) calcula automáticamente el siguiente `nro` disponible cuando no se envía uno.

## API — Endpoints

Todas las rutas cuelgan de `/api/`. Los endpoints de administración requieren sesión de admin (`require_admin()`); los de conductor requieren sesión de conductor (`require_conductor()`).

**Autenticación admin**
- `POST /api/login.php` · `POST /api/logout.php` · `GET /api/me.php`

**Autenticación conductor**
- `POST /api/conductor_auth/login.php`
- `POST /api/conductor_auth/register.php`
- `POST /api/conductor_auth/logout.php`
- `GET /api/conductor_auth/me.php`

**Módulos (patrón repetido para `flota`, `seguros`, `impuestos`, `conductores`, `talleres`, `rutas`, `multas`, `mantenimiento`, `fletes`)**
- `GET  /api/{modulo}/list.php`
- `POST /api/{modulo}/save.php`
- `POST /api/{modulo}/delete.php`

**Portal del conductor**
- `GET /api/conductor_rutas/list.php` — rutas del conductor autenticado.
- `GET /api/conductor_data/reference.php` — catálogos de referencia para el portal.

**Almacenamiento auxiliar (catálogos, papelera, bitácora)**
- `POST /api/storage/save.php`
- `GET  /api/storage/get_all.php`
- `POST /api/storage/reset_all.php`

Todas las respuestas son JSON. Los errores devuelven `{ "error": "mensaje" }` junto con el código HTTP correspondiente (401 no autenticado, 405 método no permitido, 422 datos inválidos, etc.).

## Seguridad

- Contraseñas de administradores y conductores almacenadas con `password_hash()` (bcrypt) y verificadas con `password_verify()`.
- Cookies de sesión configuradas como `httponly`, `secure` y `SameSite=Lax`, con **regeneración de ID de sesión** en cada login (mitiga session fixation).
- Mensajes de error de login **idénticos** para correo/teléfono inexistente y para contraseña incorrecta, evitando enumeración de cuentas.
- Todas las consultas SQL usan sentencias preparadas — sin concatenación directa de input del usuario.
- El campo `conductor_user_id` de una ruta **nunca lo decide el navegador**: se recalcula siempre en el servidor a partir del nombre del conductor, para impedir que un conductor se autoasigne rutas ajenas.
- El `.htaccess` fuerza HTTPS en todo el sitio.

> ⚠️ **Nota sobre este repositorio:** al ser privado, `api/config.php` se mantiene con las credenciales reales de conexión a la base de datos de producción, tal como se usa en el hosting. Si en algún momento este repositorio deja de ser privado o se comparte con terceros, esas credenciales deben rotarse y moverse a variables de entorno o a un archivo de configuración fuera del control de versiones.

## Historial / migración

Este sistema reemplaza una versión previa que usaba **Supabase (PostgreSQL)** como backend, operando enteramente desde el navegador. La migración actual:

- Reemplazó el cliente `supabase-js` por un cliente propio (`apiFetch` en `js/app.js`) que respeta la misma firma `{data, error}`, minimizando cambios en la capa de UI.
- Reemplazó las políticas de *Row Level Security* de Supabase por autenticación de sesión + validación en servidor (`require_admin()`, `require_conductor()`, recálculo server-side de `conductor_user_id`).
- Los datos semilla originales provienen del libro de control de flota en Excel (`control-de-flota-vehicular.xlsx`) usado antes de digitalizar el proceso.

## Licencia y uso

Software interno de **Transporte Osvaldo Gutiérrez Velásquez (Transporte OGV)** — Rut 20.752.714-9. Uso exclusivo del personal autorizado de la empresa. No está licenciado para redistribución ni uso por terceros ajenos a la organización.
