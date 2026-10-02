<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

/** Agrega un comentario a un reporte sin pisar el resto de la fila. */
const TABLE = 'reportes';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$nro = $input['nro'] ?? null;
$texto = trim($input['texto'] ?? '');
$usuario = $input['usuario'] ?? 'Admin';

if ($nro === null || $nro === '') {
    json_error('Falta el nro del reporte', 422);
}
if ($texto === '') {
    json_error('El comentario no puede estar vacío', 422);
}

$nro = (int)$nro;
$conn = db();

$stmt = $conn->prepare('SELECT comentarios FROM `reportes` WHERE nro = ? LIMIT 1');
$stmt->bind_param('i', $nro);
$stmt->execute();
$row = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$row) {
    json_error('Reporte no encontrado', 404);
}

$comentarios = json_decode($row['comentarios'] ?: '[]', true);
if (!is_array($comentarios)) $comentarios = [];
$comentarios[] = [
    'fecha' => date('c'),
    'usuario' => $usuario,
    'texto' => $texto,
];
$comentariosJson = json_encode($comentarios, JSON_UNESCAPED_UNICODE);

$stmt = $conn->prepare('UPDATE `reportes` SET comentarios = ? WHERE nro = ?');
$stmt->bind_param('si', $comentariosJson, $nro);
$stmt->execute();
$stmt->close();

json_response(['ok' => true, 'nro' => $nro, 'comentarios' => $comentarios]);
