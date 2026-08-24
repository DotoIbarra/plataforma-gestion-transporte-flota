<?php
require_once __DIR__ . '/../conductor_auth.php';
require_once __DIR__ . '/../notify.php';
require_once __DIR__ . '/../auditoria.php';
require_conductor();

/**
 * Cambia SOLO el estado del servicio de una ruta propia (nunca el resto de
 * sus columnas, a diferencia de save.php que reescribe la fila completa).
 * Flujo permitido desde la app del conductor:
 *   Asignado -> Aceptado -> En ruta -> En destino
 * y, en cualquier punto antes de Finalizado, también se puede Cancelar.
 * "Finalizado" no se pone desde acá: se marca solo al guardar la foto de
 * cierre (Report) en conductor_rutas/save.php.
 */
const SECUENCIA = ['Asignado', 'Aceptado', 'En ruta', 'En destino'];
const ESTADOS_PERMITIDOS = ['Aceptado', 'En ruta', 'En destino', 'Cancelado'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$nro = $input['nro'] ?? null;
$nuevoEstado = $input['estadoServicio'] ?? null;

if ($nro === null || $nro === '') {
    json_error('Falta el nro de la ruta', 422);
}
if (!in_array($nuevoEstado, ESTADOS_PERMITIDOS, true)) {
    json_error('Estado inválido', 422);
}

$nro = (int)$nro;
$myId = current_conductor_user_id();
$conn = db();

$stmt = $conn->prepare('SELECT estadoServicio, conductor_user_id FROM rutas WHERE nro = ? LIMIT 1');
$stmt->bind_param('i', $nro);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$row || (int)$row['conductor_user_id'] !== $myId) {
    json_error('No puedes modificar una ruta que no es tuya', 403);
}

$actual = $row['estadoServicio'] ?: 'Asignado';
if (in_array($actual, ['Finalizado', 'Cancelado'], true)) {
    json_error('Esta ruta ya está cerrada', 409);
}

$idxActual = array_search($actual, SECUENCIA, true);
$idxNuevo  = array_search($nuevoEstado, SECUENCIA, true);
$esAvance      = $idxActual !== false && $idxNuevo !== false && $idxNuevo === $idxActual + 1;
$esCancelacion = $nuevoEstado === 'Cancelado';

if (!$esAvance && !$esCancelacion) {
    json_error("No se puede pasar de \"$actual\" a \"$nuevoEstado\"", 422);
}

$stmt = $conn->prepare('UPDATE rutas SET estadoServicio = ? WHERE nro = ?');
$stmt->bind_param('si', $nuevoEstado, $nro);
$stmt->execute();
$stmt->close();

$stmtNombre = $conn->prepare('SELECT nombres, apellidos FROM conductores WHERE conductor_user_id = ? LIMIT 1');
$stmtNombre->bind_param('i', $myId);
$stmtNombre->execute();
$perfil = $stmtNombre->get_result()->fetch_assoc();
$stmtNombre->close();
$nombreConductor = trim(($perfil['nombres'] ?? '') . ' ' . ($perfil['apellidos'] ?? '')) ?: 'Un conductor';

$etiquetas = ['Aceptado' => 'aceptó', 'En ruta' => 'inició', 'En destino' => 'llegó a destino en', 'Cancelado' => 'canceló'];
$verbo = $etiquetas[$nuevoEstado] ?? 'actualizó';
notify('estado_ruta', "$nombreConductor $verbo la ruta #$nro", 'ruta', $nro);
audit('conductor', $nombreConductor, 'cambio_estado', 'rutas', $nro, "Estado {$actual} → {$nuevoEstado}");

json_response(['ok' => true, 'nro' => $nro, 'estadoServicio' => $nuevoEstado]);
