<?php
require_once __DIR__ . '/../auth.php';
require_admin();

const ALLOWED_KEYS = ['flota_catalogos_v1', 'flota_trash_v1', 'flota_log_v1'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$key = $input['key'] ?? '';
$value = $input['value'] ?? null;

if (!in_array($key, ALLOWED_KEYS, true)) {
    json_error('Clave no permitida', 422);
}
if ($value === null) {
    json_error('Falta "value"', 422);
}

$json = json_encode($value, JSON_UNESCAPED_UNICODE);
$stmt = db()->prepare(
    'INSERT INTO app_storage (storage_key, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)'
);
$stmt->bind_param('ss', $key, $json);
$stmt->execute();
$stmt->close();

json_response(['ok' => true]);
