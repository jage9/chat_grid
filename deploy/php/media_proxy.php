<?php
declare(strict_types=1);

/**
 * Lightweight audio/media proxy for Chat Grid radio streams.
 *
 * Usage:
 *   /chgrid/media_proxy.php?url=<urlencoded-remote-stream-url>
 *
 * Notes:
 * - Supports upstream http/https URLs.
 * - Intended for same-origin browser playback to avoid client-side CORS limits.
 * - Includes simple SSRF protections (scheme checks + private/reserved IP blocking).
 * - Optional host allowlist via env CHGRID_MEDIA_PROXY_ALLOWLIST, comma-separated.
 */

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, HEAD, OPTIONS');
header('Access-Control-Allow-Headers: Range');

/**
 * PHP-version-safe suffix check (avoid str_ends_with dependency).
 */
function host_matches_suffix(string $host, string $suffix): bool
{
    if ($suffix === '') {
        return false;
    }
    if ($host === $suffix) {
        return true;
    }
    $needle = '.' . $suffix;
    if (strlen($host) < strlen($needle)) {
        return false;
    }
    return substr($host, -strlen($needle)) === $needle;
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
    http_response_code(405);
    header('Content-Type: text/plain; charset=utf-8');
    echo "method not allowed\n";
    exit;
}

$rawUrl = isset($_GET['url']) ? trim((string) $_GET['url']) : '';
if ($rawUrl === '') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "missing url query param\n";
    exit;
}

$parsed = parse_url($rawUrl);
if ($parsed === false || !isset($parsed['scheme'], $parsed['host'])) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "invalid url\n";
    exit;
}

$scheme = strtolower((string) $parsed['scheme']);
if ($scheme !== 'http' && $scheme !== 'https') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo "unsupported scheme\n";
    exit;
}

$host = strtolower((string) $parsed['host']);
if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "forbidden host\n";
    exit;
}

/**
 * Optional host allowlist, comma-separated suffixes.
 * Example:
 *   CHGRID_MEDIA_PROXY_ALLOWLIST=dropbox.com,dropboxusercontent.com,stream0.wfmu.org
 */
$allowlistEnv = getenv('CHGRID_MEDIA_PROXY_ALLOWLIST');
if ($allowlistEnv !== false && trim($allowlistEnv) !== '') {
    $allowlist = array_values(array_filter(array_map(
        static fn(string $v): string => strtolower(trim($v)),
        explode(',', (string) $allowlistEnv)
    )));
    $allowed = false;
    foreach ($allowlist as $suffix) {
        if ($suffix === '') {
            continue;
        }
        if (host_matches_suffix($host, $suffix)) {
            $allowed = true;
            break;
        }
    }
    if (!$allowed) {
        http_response_code(403);
        header('Content-Type: text/plain; charset=utf-8');
        echo "host not allowed\n";
        exit;
    }
}

// Resolve and block private/reserved targets (basic SSRF guard).
$resolved = @gethostbynamel($host);
if ($resolved === false || count($resolved) === 0) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo "dns resolution failed\n";
    exit;
}
foreach ($resolved as $ip) {
    $ok = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
    if ($ok === false) {
        http_response_code(403);
        header('Content-Type: text/plain; charset=utf-8');
        echo "resolved ip not allowed\n";
        exit;
    }
}

if (!function_exists('curl_init')) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "curl extension is required\n";
    exit;
}

$ch = curl_init($rawUrl);
if ($ch === false) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "proxy init failed\n";
    exit;
}

$upstreamHeaders = [];
$statusCode = 200;
$sentContentType = false;
$headersSent = false;

curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_HTTPGET => true,
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER => false,
    CURLOPT_NOSIGNAL => true,
    CURLOPT_USERAGENT => 'ChatGridMediaProxy/1.0',
    CURLOPT_HTTPHEADER => [
        'Accept: */*',
        'Connection: keep-alive',
    ],
    CURLOPT_HEADERFUNCTION => static function ($curl, $headerLine) use (&$upstreamHeaders, &$statusCode, &$sentContentType): int {
        $trimmed = trim($headerLine);
        $length = strlen($headerLine);
        if ($trimmed === '') {
            return $length;
        }
        if (stripos($trimmed, 'HTTP/') === 0) {
            $parts = explode(' ', $trimmed);
            if (isset($parts[1]) && ctype_digit($parts[1])) {
                $statusCode = (int) $parts[1];
            }
            return $length;
        }
        $split = explode(':', $trimmed, 2);
        if (count($split) !== 2) {
            return $length;
        }
        $name = strtolower(trim($split[0]));
        $value = trim($split[1]);
        $upstreamHeaders[$name] = $value;
        if ($name === 'content-type') {
            $sentContentType = true;
        }
        return $length;
    },
]);

if (isset($_SERVER['HTTP_RANGE']) && $_SERVER['HTTP_RANGE'] !== '') {
    curl_setopt($ch, CURLOPT_RANGE, (string) $_SERVER['HTTP_RANGE']);
}

if ($_SERVER['REQUEST_METHOD'] === 'HEAD') {
    curl_setopt($ch, CURLOPT_NOBODY, true);
}

/**
 * Emit downstream headers exactly once (before body bytes).
 */
$emitHeaders = static function () use (&$headersSent, &$statusCode, &$upstreamHeaders, &$sentContentType, $ch): void {
    if ($headersSent) {
        return;
    }
    if ($statusCode < 200 || $statusCode >= 600) {
        $statusCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($statusCode < 200 || $statusCode >= 600) {
            $statusCode = 200;
        }
    }
    http_response_code($statusCode);

    if ($sentContentType && isset($upstreamHeaders['content-type'])) {
        header('Content-Type: ' . $upstreamHeaders['content-type']);
    } else {
        header('Content-Type: application/octet-stream');
    }

    if (isset($upstreamHeaders['content-length'])) {
        header('Content-Length: ' . $upstreamHeaders['content-length']);
    }
    if (isset($upstreamHeaders['accept-ranges'])) {
        header('Accept-Ranges: ' . $upstreamHeaders['accept-ranges']);
    }
    if (isset($upstreamHeaders['content-range'])) {
        header('Content-Range: ' . $upstreamHeaders['content-range']);
    }
    if (isset($upstreamHeaders['cache-control'])) {
        header('Cache-Control: ' . $upstreamHeaders['cache-control']);
    } else {
        header('Cache-Control: no-store');
    }
    $headersSent = true;
};

// Stream output incrementally.
curl_setopt($ch, CURLOPT_WRITEFUNCTION, static function ($curl, $chunk) use ($emitHeaders): int {
    $emitHeaders();
    $len = strlen($chunk);
    if ($len > 0) {
        echo $chunk;
        flush();
    }
    return $len;
});

$ok = curl_exec($ch);
if ($ok === false) {
    $err = curl_error($ch);
    curl_close($ch);
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo "upstream fetch failed: " . $err . "\n";
    exit;
}

$emitHeaders();

curl_close($ch);
