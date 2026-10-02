<?php
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/auditoria.php';
start_secure_session();

// Hay que leer quién es ANTES de vaciar $_SESSION más abajo.
$adminId = $_SESSION['admin_id'] ?? null;
$adminNombre = $_SESSION['admin_nombre'] ?? null;

if ($adminId) {
    // Presencia: deja de contar como "conectado"/"ausente" de inmediato,
    // aunque el navegador se haya cerrado sin avisar el último heartbeat
    // no queda pendiente hasta que expire por timeout.
    $stmtP = db()->prepare('UPDATE admin_users SET sesion_activa = 0 WHERE id = ?');
    $stmtP->bind_param('i', $adminId);
    $stmtP->execute();
    $stmtP->close();

    // Auditoría: queda constancia de cuándo cerró sesión. Nunca debe
    // tumbar el logout si falla.
    audit('admin', $adminNombre ?: 'Admin', 'logout', 'sesion', (int)$adminId);
}

$_SESSION = [];
if (ini_get('session.use_cookies')) {
    $params = session_get_cookie_params();
    setcookie(session_name(), '', time() - 42000,
        $params['path'], $params['domain'], $params['secure'], $params['httponly']);
}
session_destroy();

json_response(['ok' => true]);
