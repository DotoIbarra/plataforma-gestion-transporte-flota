<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../config.php';
require_admin();

/** Devuelve el recorrido (todos los pings de GPS) de una ruta puntual, para
 *  dibujar la línea del trayecto en el mapa operacional del admin. */

$nro = $_GET['nro'] ?? null;
if ($nro === null || $nro === '') {
    json_error('Falta el nro de la ruta', 422);
}
$nro = (int)$nro;

$stmt = db()->prepare('SELECT lat, lng, precision_m, creado_en FROM rutas_ubicaciones WHERE ruta_nro = ? ORDER BY creado_en ASC');
$stmt->bind_param('i', $nro);
$stmt->execute();
$result = $stmt->get_result();
$rows = [];
while ($row = $result->fetch_assoc()) {
    $rows[] = $row;
}
$stmt->close();

json_response(['rows' => $rows]);
