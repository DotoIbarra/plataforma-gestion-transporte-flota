<?php
require_once __DIR__ . '/../conductor_auth.php';
require_once __DIR__ . '/../auditoria.php';
require_conductor();

/**
 * Seguimiento GPS (interino, vía navegador): el conductor NO tiene todavía
 * un dispositivo GPS dedicado en el vehículo, así que por ahora la
 * ubicación se captura desde el navegador del teléfono con el que usa la
 * app (navigator.geolocation), mientras el servicio está activo. El día
 * que la flota tenga GPS embarcado, este mismo endpoint puede recibir los
 * pings de ese hardware en vez de (o además de) los del teléfono, sin
 * tener que tocar el resto del sistema: el mapa y la trazabilidad ya
 * quedan armados sobre esta tabla.
 *
 * Guarda la ÚLTIMA posición conocida en `rutas` (lat/lng/ubicacionTs, para
 * que el mapa operacional sea una sola consulta) y además agrega una fila
 * al historial `rutas_ubicaciones` (para poder reconstruir el recorrido).
 */

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

$nro = $input['nro'] ?? null;
$lat = $input['lat'] ?? null;
$lng = $input['lng'] ?? null;
$precision = isset($input['precision']) && $input['precision'] !== '' ? (int)$input['precision'] : null;

if ($nro === null || $nro === '' || $lat === null || $lng === null) {
    json_error('Faltan datos de ubicación', 422);
}
if (!is_numeric($lat) || !is_numeric($lng) || $lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
    json_error('Coordenadas inválidas', 422);
}

$nro = (int)$nro;
$myId = current_conductor_user_id();
$conn = db();

// Igual criterio de seguridad que en estado.php / save.php: solo puede
// mandar ubicación de una ruta que sea suya y que siga activa.
$stmt = $conn->prepare('SELECT conductor_user_id, estadoServicio FROM rutas WHERE nro = ? LIMIT 1');
$stmt->bind_param('i', $nro);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$row || (int)$row['conductor_user_id'] !== $myId) {
    json_error('No puedes actualizar la ubicación de una ruta que no es tuya', 403);
}
if (in_array($row['estadoServicio'] ?? '', ['Finalizado', 'Cancelado'], true)) {
    json_error('Esta ruta ya está cerrada', 409);
}

$stmt = $conn->prepare('UPDATE rutas SET lat = ?, lng = ?, ubicacionTs = NOW() WHERE nro = ?');
$stmt->bind_param('ddi', $lat, $lng, $nro);
$stmt->execute();
$stmt->close();

$stmt = $conn->prepare('INSERT INTO rutas_ubicaciones (ruta_nro, lat, lng, precision_m) VALUES (?, ?, ?, ?)');
$stmt->bind_param('iddi', $nro, $lat, $lng, $precision);
$stmt->execute();
$stmt->close();

json_response(['ok' => true]);
