# Control de Flota Vehicular — versión web

Aplicación web (HTML + CSS + JavaScript, sin frameworks ni build) para gestionar tu flota
de principio a fin: vehículos, rutas, mantenimiento, seguros, impuestos, multas, conductores
y talleres — con fotos de las rutas, respaldo en varios formatos, guardado automático,
papelera con restauración y un registro de actividad día a día.

## Contenido del proyecto

```
control-flota/
├── index.html          ← página principal
├── css/style.css        ← estilos
├── js/data.js             ← catálogos iniciales (marcas, combustibles, infracciones, etc.)
├── js/app.js               ← lógica de la aplicación
└── README.md
```

## Cómo abrirlo en Visual Studio Code

1. Descomprime este proyecto en una carpeta y ábrela en VS Code (`Archivo → Abrir carpeta…`).
2. Instala la extensión **Live Server** (de "Ritwick Dey") si no la tienes.
3. Clic derecho sobre `index.html` → **"Open with Live Server"**.
4. También puedes abrir `index.html` con doble clic desde el explorador de archivos —
   funciona igual, sin necesidad de Live Server. Solo el motor de Excel (para exportar/importar
   .xlsx) necesita conexión a internet la primera vez, porque se carga desde una librería pública (CDN).

## Módulos de trabajo

Todos empiezan **vacíos**: tú agregas y eliminas tus propios registros desde el primer momento.

| Módulo | Contenido |
|---|---|
| Flota de vehículos | Datos del vehículo y ciclo de mantenimiento preventivo |
| Rutas de viaje | Viajes por conductor, con **foto de inicio y foto de fin de ruta** |
| Mantenimiento | Órdenes de taller, preventivo/correctivo |
| Seguros | Pólizas y vencimientos |
| Impuestos | Pagos anuales por vehículo |
| Multas | Infracciones y saldo pendiente |
| Conductores | Datos y calificación |
| Talleres | Datos de contacto |
| **Catálogos** | Listas editables que alimentan los desplegables (marcas, combustibles, infracciones, etc.) — sección de configuración, no de registros |

## Fotos de inicio y fin de ruta

En **Rutas de viaje**, cada registro tiene dos campos de foto: al iniciar el viaje y al finalizarlo.
Sube una imagen desde el formulario (se comprime automáticamente para no ocupar demasiado espacio),
y en la tabla aparece como una miniatura — haz clic para verla en grande. Las fotos se guardan
dentro del navegador junto con el resto de los datos.

## Guardado automático

Cada vez que agregas, editas o eliminas un registro, la aplicación lo guarda sola en el
almacenamiento local del navegador — no hay botón de "guardar". Un indicador en la esquina
inferior izquierda confirma la hora del último guardado.

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

## Fórmulas reproducidas del Excel original

- **Flota:** *Falta para el próximo mantenimiento* = Ciclo − (Km actual − Km último mantenimiento).
  *Estado de mantenimiento* = "Mantener" si ese valor es ≤ 0, si no "Aun no".
- **Seguros:** *Estado de póliza* = Vencido / Por vencer (≤30 días) / Vigente, según la fecha de vencimiento.
- **Rutas:** Km recorridos, ingreso total (peso × costo/Kg), volumen de bencina (gasto ÷ precio/litro),
  rendimiento (Km/litro), gasto total y ganancia por Km.
- **Multas:** *Debe* = importe de la multa − importe pagado. *Estado* = Pagado / Debe.

## Adaptado a Chile

- Todos los montos (impuestos, seguros, multas, mantenimiento, rutas) se muestran en **formato
  chileno**: separador de miles con punto y sin decimales, por ejemplo `$ 15.000` — igual que
  Excel o cualquier sistema configurado en `es-CL`.
- El combustible se maneja en **litros**, no en galones: precio por litro, volumen en litros y
  rendimiento en **Km/litro**.
- Los catálogos de "Estaciones de servicio" y "Tipos de bencina" vienen con marcas y
  combustibles típicos de Chile (Copec, Shell, Petrobras, Terpel; Bencina 93/95/97, Diésel, GLP)
  — y, como siempre, puedes editarlos libremente desde **Catálogos** para ajustar precios y
  marcas a medida que suban o bajen.

## Personalizar

- Las listas desplegables (marcas, modelos, combustibles, infracciones, etc.) se editan desde
  **"Catálogos"** en el menú lateral — esa sección queda igual que siempre, sin registros que
  agregar o eliminar más allá de sus propios valores.
- Colores y tipografías están centralizados como variables CSS en `css/style.css`.

## Requisitos

Un navegador moderno (Chrome, Edge, Firefox). No requiere `npm install` ni backend. Solo
necesita internet la primera vez que exportas/importas un archivo Excel (.xlsx), porque el
motor que lee y escribe ese formato se carga desde una librería pública.
