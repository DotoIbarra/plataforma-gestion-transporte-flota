<?php
require_once __DIR__ . '/../auth.php';
require_role_admin();

$result = db()->query('SELECT id, email, nombre, rol FROM admin_users ORDER BY nombre ASC');
$rows = [];
while ($row = $result->fetch_assoc()) {
    $rows[] = $row;
}

json_response(['rows' => $rows]);
