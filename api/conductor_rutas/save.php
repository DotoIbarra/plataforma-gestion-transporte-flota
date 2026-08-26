<?php
require_once __DIR__ . '/../conductor_auth.php';
require_once __DIR__ . '/../notify.php';
require_once __DIR__ . '/../auditoria.php';
require_conductor();

/**
 * IMPORTANTE — alcance deliberadamente muy angosto:
 * El conductor NUNCA puede crear rutas nuevas ni editar sus datos (fechas,
 * placa, obra, origen/destino, pesos, costos, observaciones, etc.). Todo
 * eso lo escribe el panel de administración (api/rutas/save.php). Desde la
 * app del conductor solo se puede:
 *   1) Subir/quitar la foto de inicio de ruta (fotoInicio).
 *   2) Subir/quitar la foto de Report (fotoFin), lo que cierra el servicio.
 * Cualquier otro campo que venga en el body se ignora por completo — no se
 * confía en el navegador para decidir qué se puede escribir.
 */

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

$nro = $input['nro'] ?? null;
if ($nro === null || $nro === '') {
    // Crear rutas es exclusivo del panel de administración.
    json_error('No puedes crear rutas nuevas: pide al equipo de operaciones que te la asigne', 403);
}
$nro = (int)$nro;
$myId = current_conductor_user_id();
$conn = db();

$stmt = $conn->prepare('SELECT conductor_user_id, estadoServicio, fotoInicio, fotoFin FROM rutas WHERE nro = ? LIMIT 1');
$stmt->bind_param('i', $nro);
$stmt->execute();
$existing = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$existing || (int)$existing['conductor_user_id'] !== $myId) {
    json_error('No puedes editar una ruta que no es tuya', 403);
}
if (in_array($existing['estadoServicio'] ?? '', ['Finalizado', 'Cancelado'], true)) {
    json_error('Esta ruta ya está cerrada', 409);
}

// Solo estos dos campos se aceptan del body; todo lo demás se descarta.
$fotoInicio = array_key_exists('fotoInicio', $input) ? (string)($input['fotoInicio'] ?? '') : $existing['fotoInicio'];
$fotoFin    = array_key_exists('fotoFin', $input) ? (string)($input['fotoFin'] ?? '') : $existing['fotoFin'];

// Igual criterio que en el resto del sistema: al guardar la foto de cierre
// (Report), el servicio queda automáticamente Finalizado.
$seFinalizoAhora = false;
$estadoServicio = $existing['estadoServicio'];
if (!empty($fotoFin) && !in_array($estadoServicio, ['Finalizado', 'Cancelado'], true)) {
    $estadoServicio = 'Finalizado';
    $seFinalizoAhora = true;
}

$stmt = $conn->prepare('UPDATE rutas SET fotoInicio = ?, fotoFin = ?, estadoServicio = ? WHERE nro = ?');
$stmt->bind_param('sssi', $fotoInicio, $fotoFin, $estadoServicio, $nro);
$stmt->execute();
$stmt->close();

const COLUMNS = [
    'nro', 'fechaSalida', 'fechaLlegada', 'placa', 'estado', 'estadoServicio', 'conductor',
    'origen', 'destino', 'fotoInicio', 'fotoFin', 'pesoCarga', 'costoPorKg',
    'observaciones', 'obra', 'solicitadoPor', 'nroRepor', 'nroGuia',
];
$colList = implode(', ', array_map(fn($c) => "`$c`", COLUMNS));
$stmt = $conn->prepare("SELECT $colList FROM rutas WHERE nro = ? LIMIT 1");
$stmt->bind_param('i', $nro);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();

if ($seFinalizoAhora) {
    $nombreConductor = trim($row['conductor'] ?? '') ?: 'Un conductor';
    notify('ruta_finalizada', "{$nombreConductor} finalizó la ruta #{$row['nro']} con Report", 'ruta', (int)$row['nro']);
    audit('conductor', $nombreConductor, 'cambio_estado', 'rutas', (int)$row['nro'], 'Estado ' . ($existing['estadoServicio'] ?: 'Asignado') . ' → Finalizado (Report)');
}

json_response(['ok' => true, 'row' => $row]);
