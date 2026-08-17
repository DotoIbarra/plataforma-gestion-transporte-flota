<?php
require_once __DIR__ . '/config.php';

/**
 * Helpers genéricos para los módulos "simples" (todos menos rutas, que
 * tiene reglas propias de conductores y se arma aparte).
 *
 * Cada módulo define su propia lista de columnas y llama a estas 3
 * funciones desde list.php / save.php / delete.php. Así el patrón se
 * repite igual para flota, seguros, impuestos, etc. — solo cambia la
 * lista de columnas.
 */

/** Devuelve todas las filas de una tabla, ordenadas por nro. */
function list_rows(string $table, array $columns): array {
    $colList = implode(', ', array_map(fn($c) => "`$c`", $columns));
    $result = db()->query("SELECT $colList FROM `$table` ORDER BY nro ASC");
    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }
    return $rows;
}

/**
 * Convierte un valor entrante del navegador al formato correcto según el
 * tipo de columna: numérico/fecha vacíos -> NULL; texto vacío -> ''.
 * (Mismo criterio que usamos al migrar los datos desde el JSON de Supabase.)
 */
function normalize_value(string $col, $val, array $numericCols, array $dateCols) {
    if (in_array($col, $numericCols, true)) {
        return ($val === null || $val === '') ? null : $val;
    }
    if (in_array($col, $dateCols, true)) {
        return ($val === null || $val === '') ? null : $val;
    }
    return $val === null ? '' : $val;
}

/**
 * Crea o actualiza una fila (upsert por "nro", igual que hacía Supabase).
 * Si el input no trae "nro" (o viene vacío), se calcula el siguiente
 * automáticamente como MAX(nro)+1 — igual que nextNroSafe() en el
 * frontend actual.
 *
 * $numericCols y $dateCols son subconjuntos de $columns: le dicen a esta
 * función qué columnas deben tratarse como número/fecha (para convertir
 * "" en NULL) en vez de como texto.
 *
 * Devuelve la fila final ya guardada (con el nro definitivo).
 */
function upsert_row(string $table, array $columns, array $numericCols, array $dateCols, array $input): array {
    $conn = db();

    $nro = $input['nro'] ?? null;
    if ($nro === null || $nro === '') {
        $result = $conn->query("SELECT MAX(nro) AS max_nro FROM `$table`");
        $maxNro = (int)($result->fetch_assoc()['max_nro'] ?? 0);
        $nro = $maxNro + 1;
    } else {
        $nro = (int)$nro;
    }
    $input['nro'] = $nro;

    $colList = implode(', ', array_map(fn($c) => "`$c`", $columns));
    $placeholders = implode(', ', array_fill(0, count($columns), '?'));
    $updateList = implode(', ', array_map(
        fn($c) => "`$c`=VALUES(`$c`)",
        array_filter($columns, fn($c) => $c !== 'nro')
    ));

    $sql = "INSERT INTO `$table` ($colList) VALUES ($placeholders) ON DUPLICATE KEY UPDATE $updateList";
    $stmt = $conn->prepare($sql);

    $values = [];
    $types = '';
    foreach ($columns as $col) {
        $raw = $input[$col] ?? null;
        $values[] = normalize_value($col, $raw, $numericCols, $dateCols);
        $types .= 's'; // mysqli con 's' deja que MySQL convierta al tipo real de la columna
    }
    $stmt->bind_param($types, ...$values);
    $stmt->execute();
    $stmt->close();

    // Devuelve la fila tal como quedó guardada en la base (fuente de verdad).
    $stmt2 = $conn->prepare("SELECT " . $colList . " FROM `$table` WHERE nro = ? LIMIT 1");
    $stmt2->bind_param('i', $nro);
    $stmt2->execute();
    $row = $stmt2->get_result()->fetch_assoc();
    $stmt2->close();

    return $row;
}

/** Borra una fila por su nro. */
function delete_row(string $table, int $nro): void {
    $stmt = db()->prepare("DELETE FROM `$table` WHERE nro = ?");
    $stmt->bind_param('i', $nro);
    $stmt->execute();
    $stmt->close();
}
