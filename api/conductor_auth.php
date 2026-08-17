<?php
require_once __DIR__ . '/config.php';

/**
 * Sesión separada de la del admin (cookie distinta: "flota_conductor_sess"),
 * para que un admin logueado y un conductor logueado en el mismo navegador
 * no se pisen entre sí.
 */
function start_conductor_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;

    session_set_cookie_params([
        'lifetime' => SESSION_LIFETIME,
        'path'     => '/',
        'secure'   => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_name('flota_conductor_sess');
    session_start();
}

function is_conductor_logged_in(): bool {
    start_conductor_session();
    return !empty($_SESSION['conductor_user_id']);
}

function require_conductor(): void {
    if (!is_conductor_logged_in()) {
        json_error('No autenticado', 401);
    }
}

/** El id del conductor logueado (conductor_users.id), o null si no hay sesión. */
function current_conductor_user_id(): ?int {
    start_conductor_session();
    return isset($_SESSION['conductor_user_id']) ? (int)$_SESSION['conductor_user_id'] : null;
}

function normalize_phone(string $raw): string {
    return preg_replace('/\D/', '', $raw);
}

function is_valid_phone(string $digits): bool {
    return (bool)preg_match('/^[0-9]{8,15}$/', $digits);
}

function is_valid_password(string $pw): bool {
    return strlen($pw) >= 8 && strlen($pw) <= 72
        && preg_match('/[A-Za-z]/', $pw)
        && preg_match('/[0-9]/', $pw);
}
