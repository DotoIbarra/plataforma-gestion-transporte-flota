<?php
require_once __DIR__ . '/../auth.php';
require_admin();

const ALLOWED_KEYS = ['flota_catalogos_v1', 'flota_trash_v1', 'flota_log_v1'];

$placeholders = implode(',', array_fill(0, count(ALLOWED_KEYS), '?'));
$stmt = db()->prepare("SELECT storage_key, value FROM app_storage WHERE storage_key IN ($placeholders)");
$stmt->bind_param(str_repeat('s', count(ALLOWED_KEYS)), ...ALLOWED_KEYS);
$stmt->execute();
$result = $stmt->get_result();

$map = [];
while ($row = $result->fetch_assoc()) {
    // La columna es JSON nativo de MySQL: viene como texto, hay que decodificarlo
    // para no mandarle al navegador un JSON-dentro-de-JSON como si fuera texto plano.
    $decoded = json_decode($row['value'], true);
    // catalogos/trash deben viajar siempre como objeto "{}", nunca como
    // lista "[]" — json_decode(assoc:true) de un objeto vacío da un array
    // vacío en PHP, así que se fuerza de vuelta a objeto antes de responder.
    if ($row['storage_key'] !== 'flota_log_v1' && is_array($decoded) && empty($decoded)) {
        $decoded = new stdClass();
    }
    $map[$row['storage_key']] = $decoded;
}
$stmt->close();

json_response([
    'catalogos' => $map['flota_catalogos_v1'] ?? new stdClass(),
    'trash'     => $map['flota_trash_v1'] ?? new stdClass(),
    'log'       => $map['flota_log_v1'] ?? [],
]);
