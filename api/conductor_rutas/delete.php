<?php
require_once __DIR__ . '/../conductor_auth.php';
require_conductor();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$nro = $input['nro'] ?? null;
if ($nro === null || $nro === '') {
    json_error('Falta el nro a eliminar', 422);
}
$nro = (int)$nro;
$myId = current_conductor_user_id();

$stmt = db()->prepare('DELETE FROM rutas WHERE nro = ? AND conductor_user_id = ?');
$stmt->bind_param('ii', $nro, $myId);
$stmt->execute();
$deleted = $stmt->affected_rows;
$stmt->close();

if ($deleted === 0) {
    json_error('No puedes borrar una ruta que no es tuya (o no existe)', 403);
}

json_response(['ok' => true]);
