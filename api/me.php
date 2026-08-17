<?php
require_once __DIR__ . '/auth.php';
start_secure_session();

if (!is_admin_logged_in()) {
    json_response(['logged_in' => false]);
}

json_response([
    'logged_in' => true,
    'admin' => [
        'id' => $_SESSION['admin_id'],
        'email' => $_SESSION['admin_email'],
    ],
]);
