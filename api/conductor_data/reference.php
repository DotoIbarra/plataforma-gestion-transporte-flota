<?php
require_once __DIR__ . '/../conductor_auth.php';
require_conductor();

// Lista de vehículos (solo para elegir placa en el formulario de ruta).
$result = db()->query("SELECT placa, marca, modelo FROM flota ORDER BY placa ASC");
$flota = [];
while ($row = $result->fetch_assoc()) {
    $flota[] = $row;
}

// Mismo catálogo de obras/estados que usa el panel admin.
$stmt = db()->prepare("SELECT value FROM app_storage WHERE storage_key = 'flota_catalogos_v1' LIMIT 1");
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();
$catalogos = $row ? json_decode($row['value'], true) : new stdClass();
if (is_array($catalogos) && empty($catalogos)) $catalogos = new stdClass();

json_response(['flota' => $flota, 'catalogos' => $catalogos]);
