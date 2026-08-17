<?php
require_once __DIR__ . '/config.php';

/**
 * Arranca la sesión PHP con configuración seguros para producción (https).
 * Se llama al principio de TODOS los endpoints (login, logout, y cualquier
 * endpoint futuro que necesite saber quién está conectado).
 */
function start_secure_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;

    session_set_cookie_params([
        'lifetime' => SESSION_LIFETIME,
        'path'     => '/',
        'secure'   => true,      // la cookie solo viaja por HTTPS
        'httponly' => true,      // JavaScript no puede leer la cookie (protege contra XSS)
        'samesite' => 'Lax',
    ]);
    session_name('flota_admin_sess');
    session_start();
}

/** True si hay un admin con sesión activa ahora mismo. */
function is_admin_logged_in(): bool {
    start_secure_session();
    return !empty($_SESSION['admin_id']);
}

/**
 * Corta la ejecución con 401 si no hay un admin logueado. Cada endpoint
 * que solo el panel de admin debe poder usar (crear/editar/borrar en
 * cualquier módulo) empieza llamando a esta función.
 */
function require_admin(): void {
    if (!is_admin_logged_in()) {
        json_error('No autenticado', 401);
    }
}
