<?php
require_once __DIR__ . '/auth.php';
require_admin();

/**
 * Late de presencia del panel: app.js llama a este endpoint cada
 * HEARTBEAT_MS (ver app.js) mientras la pestaña está abierta, mandando
 * "activo" o "ausente" según si el mouse/teclado se movió en los últimos
 * 5 minutos. api/usuarios/list.php usa el tiempo transcurrido desde el
 * último heartbeat (no lo que mande el navegador) para decidir si el
 * usuario sigue realmente conectado o si el timeout lo da por
 * desconectado (pestaña cerrada, computador apagado, etc.).
 */

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$status = $input['status'] ?? 'activo';
if ($status !== 'activo' && $status !== 'ausente') {
    $status = 'activo';
}

$adminId = (int)($_SESSION['admin_id']);
$stmt = db()->prepare(
    "UPDATE admin_users SET last_heartbeat_at = NOW(), last_activity_status = ?, sesion_activa = 1 WHERE id = ?"
);
$stmt->bind_param('si', $status, $adminId);
$stmt->execute();
$stmt->close();

json_response(['ok' => true]);
