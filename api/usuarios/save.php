<?php
require_once __DIR__ . '/../auth.php';
require_role_admin();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

$id = isset($input['id']) && $input['id'] !== '' ? (int)$input['id'] : null;
$email = trim($input['email'] ?? '');
$nombre = trim($input['nombre'] ?? '');
$rol = ($input['rol'] ?? 'operador') === 'admin' ? 'admin' : 'operador';
$password = (string)($input['password'] ?? '');

if ($email === '' || $nombre === '') {
    json_error('Faltan el nombre o el correo', 422);
}
if ($id === null && $password === '') {
    json_error('Debes definir una contraseña para el usuario nuevo', 422);
}

$conn = db();

if ($id === null) {
    // Crear
    $hash = password_hash($password, PASSWORD_DEFAULT);
    $stmt = $conn->prepare('INSERT INTO admin_users (email, password_hash, nombre, rol) VALUES (?, ?, ?, ?)');
    $stmt->bind_param('ssss', $email, $hash, $nombre, $rol);
    if (!$stmt->execute()) {
        json_error('Ese correo ya está en uso', 409);
    }
    $id = $stmt->insert_id;
    $stmt->close();
} else {
    // Editar: si no se envía contraseña, se conserva la actual.
    if ($password !== '') {
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $stmt = $conn->prepare('UPDATE admin_users SET email = ?, nombre = ?, rol = ?, password_hash = ? WHERE id = ?');
        $stmt->bind_param('ssssi', $email, $nombre, $rol, $hash, $id);
    } else {
        $stmt = $conn->prepare('UPDATE admin_users SET email = ?, nombre = ?, rol = ? WHERE id = ?');
        $stmt->bind_param('sssi', $email, $nombre, $rol, $id);
    }
    if (!$stmt->execute()) {
        json_error('Ese correo ya está en uso', 409);
    }
    $stmt->close();

    // Si el usuario editado es quien tiene la sesión abierta, su rol en
    // sesión se actualiza al toque (por si se degradó a sí mismo).
    if (($_SESSION['admin_id'] ?? null) === $id) {
        $_SESSION['admin_rol'] = $rol;
    }
}

json_response(['ok' => true, 'row' => ['id' => $id, 'email' => $email, 'nombre' => $nombre, 'rol' => $rol]]);
