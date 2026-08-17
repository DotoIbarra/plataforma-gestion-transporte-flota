<?php
/**
 * Configuración de conexión a la base de datos.
 *
 * IMPORTANTE: reemplaza estos 3 valores por los tuyos reales de WebHostChile
 * (los mismos que usaste al crear la base en cPanel → Bases de datos MySQL).
 * El host casi siempre es "localhost" en hosting compartido.
 */
define('DB_HOST', 'localhost');
define('DB_NAME', 'transpor_flota');
define('DB_USER', 'transpor_flotauser');
define('DB_PASS', '7fKW@NdcPYaZl$Nz');

// Duración de la sesión de admin, en segundos (8 horas).
define('SESSION_LIFETIME', 8 * 60 * 60);

function db(): mysqli {
    static $conn = null;
    if ($conn === null) {
        mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
        $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
        $conn->set_charset('utf8mb4');
    }
    return $conn;
}

/**
 * Responde en JSON y termina la ejecución. Todos los endpoints usan esto
 * para no repetir el mismo header/echo/exit en cada archivo.
 */
function json_response($data, int $statusCode = 200): void {
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function json_error(string $message, int $statusCode = 400): void {
    json_response(['error' => $message], $statusCode);
}
