# Osvaldo Gutiérrez Velásquez — Control de Flota

Aplicación web (HTML + CSS + JavaScript, sin frameworks ni build) para gestionar la flota
de principio a fin: vehículos, rutas, fletes/facturación, mantenimiento, seguros, impuestos,
multas, conductores y talleres — con fotos de las rutas, respaldo en varios formatos, guardado
automático, papelera con restauración y un registro de actividad día a día.

Tiene **dos frentes**, sobre la misma base de datos:

- **Panel web** (`index.html`) — de uso interno, los 9 módulos completos.
- **App de conductores** (`conductor/`) — cada conductor entra con su teléfono y contraseña,
  y solo ve/crea sus propias rutas desde el celular (instalable como app, sin tienda de apps).

Los datos ya no viven en el navegador: se guardan en **Supabase** (PostgreSQL en la nube), así
que el panel y la app de conductores están siempre sincronizados, en vivo, entre cualquier
computador o celular que abra el sitio.

## Contenido del proyecto

```
flota/
├── index.html                     ← panel web (interno)
├── css/style.css                   ← estilos del panel (identidad "ruta nocturna + cobre")
├── js/
│   ├── data.js                        ← catálogos iniciales (marcas, combustibles, obras, etc.)
│   ├── supabase-config.js              ← URL y anon key del proyecto Supabase
│   └── app.js                            ← lógica del panel (9 módulos + Facturas)
├── conductor/                      ← app de conductores (PWA instalable)
│   ├── index.html
│   ├── manifest.json
│   ├── css/style.css
│   └── js/
│       ├── supabase-config.js
│       └── app.js
├── supabase/
│   ├── schema.sql                     ← esquema base (tablas por módulo + app_storage)
│   └── 002_conductor_auth.sql          ← cuentas de conductor, RLS por conductor, realtime
├── INSTRUCCIONES.md                ← cómo configurar el proyecto Supabase desde cero
├── INSTRUCCIONES_CONDUCTOR.md      ← cómo activar y desplegar la app de conductores
└── README.md
```

## Arquitectura de datos (Supabase)

Cada uno de los 9 módulos operativos (`flota`, `rutas`, `fletes`, `mantenimiento`, `seguros`,
`impuestos`, `multas`, `conductores`, `talleres`) es **una tabla real de PostgreSQL**, con Row
Level Security habilitado. Además hay una tabla clave-valor, `app_storage` (columna `jsonb`),
que guarda tres bloques que no son "registros" propios de un módulo: **catálogos**, **papelera**
y **registro de actividad**.

- **`rutas` es la única tabla compartida en tiempo real** entre el panel y la app de conductores:
  cada conductor solo puede leer/crear/editar/borrar sus propias filas (impuesto por Postgres vía
  RLS, no por el frontend), y el panel se actualiza solo cuando algo cambia ahí (Supabase
  Realtime) — sin recargar la página.
- El resto de los módulos los administra únicamente el panel web.
- El detalle completo de cómo se armó esta base (por qué una tabla por módulo, cómo se vinculan
  las cuentas de conductor a su ficha existente, etc.) está en `INSTRUCCIONES.md` e
  `INSTRUCCIONES_CONDUCTOR.md`.

## Cómo abrirlo / desplegarlo

Como ahora depende de red (peticiones a Supabase), **ya no se puede abrir `index.html` con
doble clic** (`file://`) — hay que servirlo por http:

- **En local (VS Code):** instala la extensión **Live Server** y usa "Open with Live Server"
  sobre `index.html`, o corre `npx serve .` / `python3 -m http.server 8000` desde la carpeta.
- **En producción:** el sitio vive desplegado en Cloudflare (Pages/Workers) como contenido
  estático — no requiere backend propio ni Node corriendo 24/7. Ver el paso a paso de
  configuración de Supabase y despliegue en `INSTRUCCIONES.md` (panel) e
  `INSTRUCCIONES_CONDUCTOR.md` (conductores).
- Antes de todo, hay que crear el proyecto en Supabase, correr `supabase/schema.sql` y completar
  `js/supabase-config.js` con la URL y la anon key — ambos pasos están detallados en
  `INSTRUCCIONES.md`.

## Módulos de trabajo

| Módulo | Contenido |
|---|---|
| Flota de vehículos | Datos del vehículo y ciclo de mantenimiento preventivo |
| Rutas de viaje | Viajes por conductor, con **foto de inicio y foto de fin de ruta** — compartido en vivo con la app de conductores |
| **Fletes** | Un registro por flete, agrupado por **obra**: descripción, lugar, tipo de flete, quién lo solicitó, N° de report, N° de guía, valor y N° de factura |
| **Facturas** (vista, no módulo) | Deriva de Fletes: lista filtrable por obra/mes/año/solicitante con el total facturado, pensada para exportar a quien cobra |
| Mantenimiento | Órdenes de taller, preventivo/correctivo |
| Seguros | Pólizas y vencimientos |
| Impuestos | Pagos anuales por vehículo |
| Multas | Infracciones y saldo pendiente |
| Conductores | Datos, calificación y (si ya se registró en la app) su cuenta vinculada |
| Talleres | Datos de contacto |
| **Catálogos** | Listas editables que alimentan los desplegables (marcas, combustibles, infracciones, obras, etc.) — sección de configuración, no de registros |

## Fotos de inicio y fin de ruta

En **Rutas de viaje** (y en **Fletes**), cada registro tiene dos campos de foto: al iniciar el
viaje y el "Report" de cierre. Sube una imagen desde el formulario (se comprime automáticamente
para no ocupar demasiado espacio), y en la tabla aparece como una miniatura — haz clic para
verla en grande. Las fotos viajan junto con el resto del registro y quedan guardadas en
Supabase, no solo en el navegador donde se subieron.

## App de conductores — "Mis Rutas"

Vive en `.../conductor/`, dentro del mismo sitio y el mismo dominio que el panel (no es una
app aparte). Cada conductor:

1. Entra a `.../conductor/`, toca **"Registrarme"** e ingresa nombre, apellido, teléfono y una
   contraseña (mínimo 8 caracteres) — la cuenta se crea con **Supabase Auth**.
2. Si ya estaba cargado en el panel (módulo **Conductores**) con ese mismo teléfono, la cuenta
   nueva se **vincula sola** a su ficha existente en vez de duplicarla.
3. Desde ahí ve y administra únicamente **sus propias** rutas: crear, editar, eliminar, con foto
   de inicio y "Report", igual que en el panel — nunca las de otro conductor.
4. Puede agregar el acceso a la pantalla de inicio del celular (Safari: Compartir → "Agregar a
   inicio"; Chrome: menú → "Instalar app") para que quede como una app normal (es una PWA
   instalable, ver `conductor/manifest.json`).

Todo lo que un conductor crea aparece de inmediato en el panel web, y viceversa, sin recargar
la página (Supabase Realtime). Detalle completo de la configuración en `INSTRUCCIONES_CONDUCTOR.md`.

## Guardado automático

Cada vez que agregas, editas o eliminas un registro, la aplicación lo guarda sola en Supabase
(la base de datos en la nube) — no hay botón de "guardar". Un indicador en la esquina inferior
izquierda confirma la hora del último guardado. Como la persistencia ya no es local, los mismos
datos se ven desde cualquier computador o celular que abra el sitio.

## Deshacer y Papelera

- Al eliminar un registro, aparece un aviso con un botón **"Deshacer"** durante unos segundos.
- Si no alcanzas a deshacer a tiempo, el registro queda disponible en **Papelera** (menú lateral,
  sección "Historial"), organizado por módulo, con la fecha y hora exacta en que se eliminó.
  Desde ahí puedes restaurarlo cuando quieras, o borrarlo definitivamente.

## Registro de actividad

La sección **"Registro de actividad"** (menú lateral) muestra, agrupado por día ("Hoy", "Ayer",
fechas anteriores), cada registro creado, editado, eliminado o restaurado — con la hora exacta y
un resumen de qué cambió. Es tu bitácora diaria de todo lo que pasó en el sistema.

## Exportar e importar

Desde el Panel general (todo el sistema) o desde cualquier módulo (solo esos registros),
puedes elegir el formato:

- **JSON** — respaldo exacto, ideal para restaurar todo tal cual en otro equipo.
- **CSV** — para abrir en Excel/Sheets o cualquier hoja de cálculo.
- **Excel (.xlsx)** — el reporte más completo: al exportar "todo el sistema" genera un libro con
  una hoja de **Resumen** (indicadores del día), una hoja por cada módulo, una hoja de
  **Actividad de hoy** y una hoja de **Papelera** con lo eliminado hasta el momento.

Para importar, el botón **"Importar"** acepta archivos **JSON, CSV, Excel (.xlsx/.xls/.xlsm) y
OpenDocument (.ods)** — no se aceptan imágenes ni archivos de texto plano (.txt). Si subes un
respaldo JSON completo, restaura todo el sistema; si subes un CSV o una hoja de un solo módulo,
elige a qué módulo se añaden esos registros; si subes un Excel con varias hojas (como el que
genera la propia app), reconoce automáticamente a qué módulo pertenece cada hoja.

> Nota: por ser un formato de texto/celdas, el CSV y el Excel no pueden llevar las fotos de las
> rutas — ahí se indica "Adjunta" como referencia. Las fotos viajan completas únicamente en el
> respaldo JSON.

## Fórmulas y campos calculados

- **Seguros:** *Estado de póliza* = Vencido / Por vencer (≤30 días) / Vigente, según la fecha de vencimiento.
- **Rutas:** *Ingreso total* = peso de la carga (Kg) × costo por Kg. *Estado* = "✔ Completado" en
  cuanto se sube la foto de cierre ("Report"), si no "Pendiente".
- **Fletes:** *Mes* y *Año* se calculan solos a partir de la fecha "Realizado", para poder
  filtrar la vista de Facturas por período.
- **Mantenimiento:** *Días en taller* = fecha de salida − fecha de entrada.
- **Multas:** *Debe* = importe de la multa − importe pagado. *Estado* = Pagado / Debe.

## Adaptado a Chile

- Todos los montos (impuestos, seguros, multas, mantenimiento, rutas, fletes) se muestran en
  **formato chileno**: separador de miles con punto y sin decimales, por ejemplo `$ 15.000` —
  igual que Excel o cualquier sistema configurado en `es-CL`.
- Los catálogos de "Estaciones de servicio" y "Tipos de bencina" (Copec, Shell, Petrobras,
  Terpel; Bencina 93/95/97, Diésel, GLP) siguen disponibles en **Catálogos** para quien los
  necesite, aunque hoy ningún módulo los usa directamente — Rutas y Fletes se enfocan en el
  ingreso de la carga transportada, no en el consumo de combustible.

## Personalizar

- Las listas desplegables (marcas, modelos, combustibles, infracciones, obras, etc.) se editan
  desde **"Catálogos"** en el menú lateral — esa sección queda igual que siempre, sin registros
  que agregar o eliminar más allá de sus propios valores.
- Colores y tipografías están centralizados como variables CSS en `css/style.css` (identidad
  actual: fondo frío tipo asfalto + acento cobre, tipografía condensada para títulos). La app de
  conductores tiene su propia hoja en `conductor/css/style.css`.

## Requisitos

Un navegador moderno (Chrome, Edge, Firefox). No requiere `npm install` ni backend propio — el
backend es Supabase. A diferencia de una app 100% local, **siempre necesita internet**, porque
cada lectura y escritura viaja a Supabase (ya no queda un respaldo funcional en el navegador si
no hay conexión). El motor de Excel (para exportar/importar .xlsx) también se carga desde una
librería pública la primera vez.
