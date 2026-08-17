<?php
require_once __DIR__ . '/../conductor_auth.php';
start_conductor_session();

if (!is_conductor_logged_in()) {
    json_response(['logged_in' => false]);
}

$id = current_conductor_user_id();
$stmt = db()->prepare('SELECT nro, nombres, apellidos, telefono FROM conductores WHERE conductor_user_id = ? LIMIT 1');
$stmt->bind_param('i', $id);
$stmt->execute();
$conductor = $stmt->get_result()->fetch_assoc();
$stmt->close();

json_response([
    'logged_in' => true,
    'conductor' => array_merge(['conductor_user_id' => $id], $conductor ?? []),
]);
