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

const ROLES_VALIDOS = ['superadmin', 'admin', 'operador'];

$id = isset($input['id']) && $input['id'] !== '' ? (int)$input['id'] : null;
$email = trim($input['email'] ?? '');
$nombre = trim($input['nombre'] ?? '');
$rolPedido = $input['rol'] ?? 'operador';
$rol = in_array($rolPedido, ROLES_VALIDOS, true) ? $rolPedido : 'operador';
$password = (string)($input['password'] ?? '');

if ($email === '' || $nombre === '') {
    json_error('Faltan el nombre o el correo', 422);
}
if ($id === null && $password === '') {
    json_error('Debes definir una contraseña para el usuario nuevo', 422);
}

$conn = db();

// Si se está editando una cuenta existente, revisa el rol ACTUAL de esa
// cuenta antes de tocarla: nadie que no sea el Super Usuario puede editar
// (ni degradar, ni cambiarle el correo/contraseña) a una cuenta admin o
// superadmin que no sea la suya propia.
$target = null;
if ($id !== null) {
    $stmt = $conn->prepare('SELECT rol FROM admin_users WHERE id = ? LIMIT 1');
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $target = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$target) {
        json_error('Usuario no encontrado', 404);
    }
    $esUnoMismo = ((int)($_SESSION['admin_id'] ?? 0)) === $id;
    if ($target['rol'] === 'superadmin' && !is_superadmin()) {
        json_error('No puedes modificar la cuenta del Super Usuario', 403);
    }
    if ($target['rol'] === 'admin' && !is_superadmin() && !$esUnoMismo) {
        json_error('Solo el Super Usuario puede modificar cuentas de Administrador', 403);
    }
}

// Solo el Super Usuario puede otorgar los roles "superadmin" o "admin" —
// así ningún Administrador puede autoascenderse a Super Usuario, ascender
// a otra cuenta a Administrador, ni crear más Administradores por su
// cuenta. Un Administrador sigue pudiendo crear/editar cuentas de rol
// "operador", y editar su PROPIO perfil (nombre/correo/contraseña) sin
// que eso cuente como una escalada, siempre que no intente cambiar su
// propio rol actual.
$esEscalada = ($rol === 'superadmin' || $rol === 'admin')
    && (!$target || $target['rol'] !== $rol);
if ($esEscalada && !is_superadmin()) {
    json_error('Solo el Super Usuario puede asignar ese rol', 403);
}

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
