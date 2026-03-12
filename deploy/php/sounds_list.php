<?php

/*
 * Chat Grid sounds list endpoint.
 *
 * Returns a JSON array of filenames found in sounds/widgets/ relative to
 * the document root. Filters to .ogg, .mp3, and .wav files.
 * Returns [] if the directory does not exist or contains no audio files.
 */

header('Content-Type: application/json');
header('Cache-Control: no-store');

$dir = rtrim($_SERVER['DOCUMENT_ROOT'] ?? '', '/') . '/sounds/widgets';

if (!is_dir($dir)) {
    echo '[]';
    exit;
}

$files = scandir($dir);
if ($files === false) {
    echo '[]';
    exit;
}

$allowed = ['ogg', 'mp3', 'wav'];
$results = [];

foreach ($files as $file) {
    if ($file === '.' || $file === '..') {
        continue;
    }
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if (in_array($ext, $allowed, true)) {
        $results[] = $file;
    }
}

sort($results);
echo json_encode($results, JSON_UNESCAPED_SLASHES);
