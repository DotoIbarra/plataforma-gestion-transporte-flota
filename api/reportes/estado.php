<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

/**
 * Cambia SOLO el estado de un reporte (Pendiente / En revisión / Resuelto)
 * y agrega la entrada correspondiente al historial de cambios — sin pisar
 * el resto de la fila, igual criterio que conductor_rutas/estado.php.
 */
const TABLE = 'reportes';
const ESTADOS_PERMITIDOS = ['Pendiente', 'En revisión', 'Resuelto'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$nro = $input['nro'] ?? null;
$nuevoEstado = $input['estado'] ?? null;
$usuario = $input['usuario'] ?? 'Admin';

if ($nro === null || $nro === '') {
    json_error('Falta el nro del reporte', 422);
}
if (!in_array($nuevoEstado, ESTADOS_PERMITIDOS, true)) {
    json_error('Estado inválido', 422);
}

$nro = (int)$nro;
$conn = db();

$stmt = $conn->prepare('SELECT estado, historial FROM `reportes` WHERE nro = ? LIMIT 1');
$stmt->bind_param('i', $nro);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$row) {
    json_error('Reporte no encontrado', 404);
}

$historial = json_decode($row['historial'] ?: '[]', true);
if (!is_array($historial)) $historial = [];
$historial[] = [
    'fecha' => date('c'),
    'usuario' => $usuario,
    'accion' => "Estado {$row['estado']} → {$nuevoEstado}",
];
$historialJson = json_encode($historial, JSON_UNESCAPED_UNICODE);

$stmt = $conn->prepare('UPDATE `reportes` SET estado = ?, historial = ? WHERE nro = ?');
$stmt->bind_param('ssi', $nuevoEstado, $historialJson, $nro);
$stmt->execute();
$stmt->close();

json_response(['ok' => true, 'nro' => $nro, 'estado' => $nuevoEstado, 'historial' => $historial]);
