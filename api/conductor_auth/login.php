<?php
require_once __DIR__ . '/../conductor_auth.php';
start_conductor_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$telefono = normalize_phone($input['telefono'] ?? '');
$password = (string)($input['password'] ?? '');

if (!is_valid_phone($telefono) || $password === '') {
    json_error('Ingresa tu teléfono y contraseña', 422);
}

$stmt = db()->prepare('SELECT id, password_hash FROM conductor_users WHERE telefono = ? LIMIT 1');
$stmt->bind_param('s', $telefono);
$stmt->execute();
$user = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$user || !password_verify($password, $user['password_hash'])) {
    json_error('Teléfono o contraseña incorrectos', 401);
}

$stmt = db()->prepare('SELECT nro, nombres, apellidos, telefono FROM conductores WHERE conductor_user_id = ? LIMIT 1');
$stmt->bind_param('i', $user['id']);
$stmt->execute();
$conductor = $stmt->get_result()->fetch_assoc();
$stmt->close();

session_regenerate_id(true);
$_SESSION['conductor_user_id'] = $user['id'];

json_response([
    'ok' => true,
    'conductor' => array_merge(['conductor_user_id' => $user['id']], $conductor ?? []),
]);
