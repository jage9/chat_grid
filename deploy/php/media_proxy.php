<?php

/*
 * Chat Grid media proxy (compat-focused).
 *
 * Usage:
 *   /chgrid/media_proxy.php?url=<urlencoded-remote-url>
 *
 * Goals:
 * - Works on older cPanel PHP web handlers.
 * - Supports http/https upstreams.
 * - Provides same-origin endpoint for browser playback.
 */

ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

function proxy_log_path()
{
    $tmp = sys_get_temp_dir();
    if (!is_string($tmp) || $tmp === '') {
        $tmp = '/tmp';
    }
    return rtrim($tmp, '/\\') . '/chgrid_media_proxy_error.log';
}

ini_set('error_log', proxy_log_path());

function proxy_debug_log($message)
{
    $line = date('c') . ' ' . $message . PHP_EOL;
    @file_put_contents(proxy_log_path(), $line, FILE_APPEND);
}

register_shutdown_function(function () {
    $e = error_get_last();
    if (!$e) {
        return;
    }
    proxy_debug_log('FATAL: ' . json_encode($e));
});

proxy_debug_log('START method=' . (isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'unknown') . ' uri=' . (isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : ''));
header('X-ChatGrid-MediaProxy: reached');

function set_status($code)
{
    $map = array(
        200 => 'OK',
        204 => 'No Content',
        400 => 'Bad Request',
        403 => 'Forbidden',
        405 => 'Method Not Allowed',
        500 => 'Internal Server Error',
        502 => 'Bad Gateway'
    );
    $text = isset($map[$code]) ? $map[$code] : 'OK';
    header('HTTP/1.1 ' . (int) $code . ' ' . $text);
}

function send_text($code, $message)
{
    set_status($code);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message . "\n";
    exit;
}

function host_matches_suffix($host, $suffix)
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

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, HEAD, OPTIONS');
header('Access-Control-Allow-Headers: Range');

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if ($method === 'OPTIONS') {
    set_status(204);
    exit;
}
if ($method !== 'GET' && $method !== 'HEAD') {
    send_text(405, 'method not allowed');
}

$rawUrl = isset($_GET['url']) ? trim((string) $_GET['url']) : '';
if ($rawUrl === '') {
    send_text(400, 'missing url query param');
}

$parsed = parse_url($rawUrl);
if ($parsed === false || !isset($parsed['scheme']) || !isset($parsed['host'])) {
    send_text(400, 'invalid url');
}

$scheme = strtolower((string) $parsed['scheme']);
if ($scheme !== 'http' && $scheme !== 'https') {
    send_text(400, 'unsupported scheme');
}

$host = strtolower((string) $parsed['host']);
if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
    send_text(403, 'forbidden host');
}

// Optional allowlist env var: CHGRID_MEDIA_PROXY_ALLOWLIST=dropbox.com,example.com
$allowlistEnv = getenv('CHGRID_MEDIA_PROXY_ALLOWLIST');
if ($allowlistEnv !== false && trim($allowlistEnv) !== '') {
    $allowed = false;
    $parts = explode(',', (string) $allowlistEnv);
    foreach ($parts as $part) {
        $suffix = strtolower(trim((string) $part));
        if ($suffix === '') {
            continue;
        }
        if (host_matches_suffix($host, $suffix)) {
            $allowed = true;
            break;
        }
    }
    if (!$allowed) {
        send_text(403, 'host not allowed');
    }
}

// Basic SSRF guard for IPv4.
$resolved = @gethostbynamel($host);
if ($resolved === false || count($resolved) === 0) {
    send_text(502, 'dns resolution failed');
}
foreach ($resolved as $ip) {
    $ok = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
    if ($ok === false) {
        send_text(403, 'resolved ip not allowed');
    }
}

if (!function_exists('curl_init')) {
    send_text(500, 'curl extension is required');
}

$ch = curl_init();
if (!$ch) {
    send_text(500, 'proxy init failed');
}

$requestHeaders = array('Accept: */*', 'Connection: keep-alive');
$range = isset($_SERVER['HTTP_RANGE']) ? trim((string) $_SERVER['HTTP_RANGE']) : '';
if ($range !== '') {
    $requestHeaders[] = 'Range: ' . $range;
}

curl_setopt($ch, CURLOPT_URL, $rawUrl);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_MAXREDIRS, 5);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
curl_setopt($ch, CURLOPT_TIMEOUT, 45);
curl_setopt($ch, CURLOPT_HEADER, true);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_NOSIGNAL, true);
curl_setopt($ch, CURLOPT_USERAGENT, 'ChatGridMediaProxy/1.0');
curl_setopt($ch, CURLOPT_HTTPHEADER, $requestHeaders);
if ($method === 'HEAD') {
    curl_setopt($ch, CURLOPT_NOBODY, true);
}

$response = curl_exec($ch);
if ($response === false) {
    $err = curl_error($ch);
    curl_close($ch);
    send_text(502, 'upstream fetch failed: ' . $err);
}

$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
if ($status < 100 || $status > 599) {
    $status = 200;
}
$headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

$rawHeaders = substr($response, 0, $headerSize);
$body = substr($response, $headerSize);
$headerBlocks = preg_split("/\r\n\r\n|\n\n/", trim($rawHeaders));
$lastHeaderBlock = '';
if (is_array($headerBlocks) && count($headerBlocks) > 0) {
    $lastHeaderBlock = $headerBlocks[count($headerBlocks) - 1];
}

set_status($status);

$contentType = '';
$contentLength = '';
$acceptRanges = '';
$contentRange = '';
$cacheControl = '';

$lines = preg_split("/\r\n|\n/", $lastHeaderBlock);
if (is_array($lines)) {
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || stripos($line, 'HTTP/') === 0) {
            continue;
        }
        $split = explode(':', $line, 2);
        if (count($split) !== 2) {
            continue;
        }
        $name = strtolower(trim($split[0]));
        $value = trim($split[1]);
        if ($name === 'content-type') $contentType = $value;
        if ($name === 'content-length') $contentLength = $value;
        if ($name === 'accept-ranges') $acceptRanges = $value;
        if ($name === 'content-range') $contentRange = $value;
        if ($name === 'cache-control') $cacheControl = $value;
    }
}

if ($contentType !== '') {
    header('Content-Type: ' . $contentType);
} else {
    header('Content-Type: application/octet-stream');
}
if ($contentLength !== '') header('Content-Length: ' . $contentLength);
if ($acceptRanges !== '') header('Accept-Ranges: ' . $acceptRanges);
if ($contentRange !== '') header('Content-Range: ' . $contentRange);
if ($cacheControl !== '') {
    header('Cache-Control: ' . $cacheControl);
} else {
    header('Cache-Control: no-store');
}

if ($method !== 'HEAD') {
    echo $body;
}
