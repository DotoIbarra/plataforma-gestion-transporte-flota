<?php
require_once __DIR__ . '/../auth.php';
require_admin();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

const MODULE_TABLES = [
    'flota', 'seguros', 'impuestos', 'conductores', 'talleres',
    'rutas', 'multas', 'mantenimiento', 'fletes',
];
const STORAGE_KEYS = ['flota_catalogos_v1', 'flota_trash_v1', 'flota_log_v1'];

$conn = db();
$conn->begin_transaction();

try {
    foreach (MODULE_TABLES as $table) {
        $conn->query("DELETE FROM `$table`");
    }
    $placeholders = implode(',', array_fill(0, count(STORAGE_KEYS), '?'));
    $stmt = $conn->prepare("DELETE FROM app_storage WHERE storage_key IN ($placeholders)");
    $stmt->bind_param(str_repeat('s', count(STORAGE_KEYS)), ...STORAGE_KEYS);
    $stmt->execute();
    $stmt->close();

    $conn->commit();
} catch (Throwable $e) {
    $conn->rollback();
    json_error('No se pudo borrar todo: ' . $e->getMessage(), 500);
}

json_response(['ok' => true]);
