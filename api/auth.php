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

/** Rol del admin actualmente logueado ('superadmin' | 'admin' | 'operador'), o null si no hay sesión. */
function current_admin_rol(): ?string {
    start_secure_session();
    return $_SESSION['admin_rol'] ?? null;
}

/** True si el admin logueado es específicamente el Super Usuario (el programador). */
function is_superadmin(): bool {
    return current_admin_rol() === 'superadmin';
}

/**
 * Corta la ejecución con 403 si el admin logueado no tiene rol "admin" o
 * "superadmin". Se usa en endpoints reservados para administración general
 * (gestión de usuarios, catálogos sensibles, etc.), no para
 * operadores/despachadores. El Super Usuario siempre pasa este chequeo,
 * porque tiene todos los permisos de un Administrador y más.
 * Siempre llamar DESPUÉS de require_admin() (exige sesión antes que rol).
 */
function require_role_admin(): void {
    require_admin();
    $rol = current_admin_rol();
    if ($rol !== 'admin' && $rol !== 'superadmin') {
        json_error('No tienes permisos de administrador para esta acción', 403);
    }
}

/**
 * Corta la ejecución con 403 si el admin logueado no es el Super Usuario.
 * Reservado para lo más delicado del sistema: acciones destructivas
 * irreversibles (borrar todo y reiniciar) y la gestión de cuentas con rol
 * "admin" o "superadmin" (ni un Administrador puede tocar esas cuentas).
 * Siempre llamar DESPUÉS de require_admin().
 */
function require_role_superadmin(): void {
    require_admin();
    if (!is_superadmin()) {
        json_error('Esta acción está reservada para el Super Usuario', 403);
    }
}
