<?php
require_once __DIR__ . '/../conductor_auth.php';
start_conductor_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$nombres   = trim($input['nombres'] ?? '');
$apellidos = trim($input['apellidos'] ?? '');
$telefono  = normalize_phone($input['telefono'] ?? '');
$password  = (string)($input['password'] ?? '');
$password2 = (string)($input['password2'] ?? '');

if ($nombres === '' || $apellidos === '') {
    json_error('Ingresa tu nombre y apellido', 422);
}
if (!is_valid_phone($telefono)) {
    json_error('Ingresa un teléfono válido (8 a 15 dígitos)', 422);
}
if (!is_valid_password($password)) {
    json_error('La contraseña debe tener al menos 8 caracteres, con letras y números', 422);
}
if ($password !== $password2) {
    json_error('Las contraseñas no coinciden', 422);
}

$conn = db();

// ¿Ese teléfono ya tiene cuenta creada?
$stmt = $conn->prepare('SELECT id FROM conductor_users WHERE telefono = ? LIMIT 1');
$stmt->bind_param('s', $telefono);
$stmt->execute();
if ($stmt->get_result()->fetch_assoc()) {
    $stmt->close();
    json_error('Ese teléfono ya tiene una cuenta. Inicia sesión en vez de crear una nueva.', 409);
}
$stmt->close();

// Crea la cuenta de acceso (conductor_users).
$hash = password_hash($password, PASSWORD_BCRYPT);
$stmt = $conn->prepare('INSERT INTO conductor_users (telefono, password_hash) VALUES (?, ?)');
$stmt->bind_param('ss', $telefono, $hash);
$stmt->execute();
$conductorUserId = $stmt->insert_id;
$stmt->close();

// ¿Ya existía una ficha de conductor con este teléfono, creada por el admin,
// pero sin cuenta de acceso vinculada? (igual que hacía el trigger en Supabase)
$stmt = $conn->prepare('SELECT nro, nombres, apellidos FROM conductores WHERE telefono = ? AND conductor_user_id IS NULL LIMIT 1');
$stmt->bind_param('s', $telefono);
$stmt->execute();
$existing = $stmt->get_result()->fetch_assoc();
$stmt->close();

if ($existing) {
    // Vincula la ficha existente; solo completa nombres/apellidos si venían vacíos.
    $finalNombres = $existing['nombres'] !== '' ? $existing['nombres'] : $nombres;
    $finalApellidos = $existing['apellidos'] !== '' ? $existing['apellidos'] : $apellidos;
    $stmt = $conn->prepare('UPDATE conductores SET conductor_user_id = ?, nombres = ?, apellidos = ? WHERE nro = ?');
    $stmt->bind_param('issi', $conductorUserId, $finalNombres, $finalApellidos, $existing['nro']);
    $stmt->execute();
    $stmt->close();
    $conductorNro = $existing['nro'];
} else {
    // No existía: se crea una ficha de conductor nueva y básica; el admin
    // puede completar el resto de sus datos después desde el panel.
    $result = $conn->query('SELECT MAX(nro) AS max_nro FROM conductores');
    $nextNro = (int)($result->fetch_assoc()['max_nro'] ?? 0) + 1;
    $stmt = $conn->prepare('INSERT INTO conductores (nro, nombres, apellidos, telefono, conductor_user_id) VALUES (?, ?, ?, ?, ?)');
    $stmt->bind_param('isssi', $nextNro, $nombres, $apellidos, $telefono, $conductorUserId);
    $stmt->execute();
    $stmt->close();
    $conductorNro = $nextNro;
    $finalNombres = $nombres;
    $finalApellidos = $apellidos;
}

// Deja al conductor logueado de inmediato (igual que hacía Supabase al registrarse).
session_regenerate_id(true);
$_SESSION['conductor_user_id'] = $conductorUserId;

json_response([
    'ok' => true,
    'conductor' => [
        'conductor_user_id' => $conductorUserId,
        'nro' => $conductorNro,
        'nombres' => $finalNombres,
        'apellidos' => $finalApellidos,
        'telefono' => $telefono,
    ],
]);
