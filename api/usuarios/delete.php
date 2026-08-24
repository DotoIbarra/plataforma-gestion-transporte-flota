<?php
require_once __DIR__ . '/../auth.php';
require_role_admin();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$id = isset($input['id']) ? (int)$input['id'] : null;
if (!$id) {
    json_error('Falta el id a eliminar', 422);
}

if ($id === (int)($_SESSION['admin_id'] ?? 0)) {
    json_error('No puedes eliminar tu propio usuario', 422);
}

$conn = db();

$stmt = $conn->prepare("SELECT rol FROM admin_users WHERE id = ? LIMIT 1");
$stmt->bind_param('i', $id);
$stmt->execute();
$target = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$target) {
    json_error('Usuario no encontrado', 404);
}

if ($target['rol'] === 'admin') {
    $stmt = $conn->prepare("SELECT COUNT(*) AS total FROM admin_users WHERE rol = 'admin'");
    $stmt->execute();
    $totalAdmins = (int)($stmt->get_result()->fetch_assoc()['total'] ?? 0);
    $stmt->close();
    if ($totalAdmins <= 1) {
        json_error('No puedes eliminar al único administrador restante', 422);
    }
}

$stmt = $conn->prepare('DELETE FROM admin_users WHERE id = ?');
$stmt->bind_param('i', $id);
$stmt->execute();
$stmt->close();

json_response(['ok' => true]);
