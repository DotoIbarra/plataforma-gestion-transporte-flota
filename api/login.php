<?php
require_once __DIR__ . '/auth.php';
start_secure_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$email = trim($input['email'] ?? '');
$password = (string)($input['password'] ?? '');

if ($email === '' || $password === '') {
    json_error('Correo y contraseña son obligatorios', 422);
}

$stmt = db()->prepare('SELECT id, email, password_hash, nombre, rol FROM admin_users WHERE email = ? LIMIT 1');
$stmt->bind_param('s', $email);
$stmt->execute();
$result = $stmt->get_result();
$admin = $result->fetch_assoc();
$stmt->close();

// Mensaje idéntico si el correo no existe o si la contraseña es incorrecta:
// así nadie puede usar el login para adivinar qué correos existen.
if (!$admin || !password_verify($password, $admin['password_hash'])) {
    json_error('Correo o contraseña incorrectos', 401);
}

// Session fixation: se regenera el ID de sesión al loguearse.
session_regenerate_id(true);
$_SESSION['admin_id'] = $admin['id'];
$_SESSION['admin_email'] = $admin['email'];
$_SESSION['admin_rol'] = $admin['rol'] ?: 'admin';
$_SESSION['admin_nombre'] = $admin['nombre'] ?: $admin['email'];

json_response([
    'ok' => true,
    'admin' => [
        'id' => $admin['id'],
        'email' => $admin['email'],
        'nombre' => $admin['nombre'],
        'rol' => $admin['rol'] ?: 'admin',
    ],
]);
