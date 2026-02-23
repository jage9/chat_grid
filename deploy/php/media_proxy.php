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

$GLOBALS['CHGRID_PROXY_HEADERS_SENT'] = false;
$GLOBALS['CHGRID_PROXY_STATUS'] = 200;
$GLOBALS['CHGRID_PROXY_UP_HEADERS'] = array();

function proxy_emit_downstream_headers()
{
    if (!empty($GLOBALS['CHGRID_PROXY_HEADERS_SENT'])) {
        return;
    }

    $status = isset($GLOBALS['CHGRID_PROXY_STATUS']) ? (int) $GLOBALS['CHGRID_PROXY_STATUS'] : 200;
    if ($status < 100 || $status > 599) {
        $status = 200;
    }
    set_status($status);

    $h = isset($GLOBALS['CHGRID_PROXY_UP_HEADERS']) && is_array($GLOBALS['CHGRID_PROXY_UP_HEADERS'])
        ? $GLOBALS['CHGRID_PROXY_UP_HEADERS']
        : array();

    if (isset($h['content-type']) && $h['content-type'] !== '') {
        header('Content-Type: ' . $h['content-type']);
    } else {
        header('Content-Type: application/octet-stream');
    }
    if (isset($h['content-length']) && $h['content-length'] !== '') {
        header('Content-Length: ' . $h['content-length']);
    }
    if (isset($h['accept-ranges']) && $h['accept-ranges'] !== '') {
        header('Accept-Ranges: ' . $h['accept-ranges']);
    }
    if (isset($h['content-range']) && $h['content-range'] !== '') {
        header('Content-Range: ' . $h['content-range']);
    }
    if (isset($h['cache-control']) && $h['cache-control'] !== '') {
        header('Cache-Control: ' . $h['cache-control']);
    } else {
        header('Cache-Control: no-store');
    }

    $GLOBALS['CHGRID_PROXY_HEADERS_SENT'] = true;
}

function proxy_header_callback($ch, $line)
{
    $trimmed = trim((string) $line);
    $len = strlen($line);
    if ($trimmed === '') {
        return $len;
    }
    if (stripos($trimmed, 'HTTP/') === 0) {
        $parts = explode(' ', $trimmed);
        if (isset($parts[1]) && ctype_digit($parts[1])) {
            $GLOBALS['CHGRID_PROXY_STATUS'] = (int) $parts[1];
        }
        // New response block (redirect hop). Keep only final hop headers.
        $GLOBALS['CHGRID_PROXY_UP_HEADERS'] = array();
        return $len;
    }
    $split = explode(':', $trimmed, 2);
    if (count($split) !== 2) {
        return $len;
    }
    $name = strtolower(trim($split[0]));
    $value = trim($split[1]);
    $GLOBALS['CHGRID_PROXY_UP_HEADERS'][$name] = $value;
    return $len;
}

function proxy_write_callback($ch, $chunk)
{
    proxy_emit_downstream_headers();
    $len = strlen($chunk);
    if ($len > 0) {
        echo $chunk;
        flush();
    }
    return $len;
}

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

function parse_allowlist_suffixes($allowlistEnv)
{
    $suffixes = array();
    if ($allowlistEnv === false || trim((string) $allowlistEnv) === '') {
        return $suffixes;
    }
    $parts = explode(',', (string) $allowlistEnv);
    foreach ($parts as $part) {
        $suffix = strtolower(trim((string) $part));
        if ($suffix !== '') {
            $suffixes[] = $suffix;
        }
    }
    return $suffixes;
}

function resolve_host_ips($host)
{
    $ips = array();
    $ipv4 = @gethostbynamel($host);
    if (is_array($ipv4)) {
        foreach ($ipv4 as $ip) {
            $ip = trim((string) $ip);
            if ($ip !== '') {
                $ips[$ip] = true;
            }
        }
    }
    if (function_exists('dns_get_record')) {
        $aaaa = @dns_get_record($host, DNS_AAAA);
        if (is_array($aaaa)) {
            foreach ($aaaa as $record) {
                if (!isset($record['ipv6'])) {
                    continue;
                }
                $ip = trim((string) $record['ipv6']);
                if ($ip !== '') {
                    $ips[$ip] = true;
                }
            }
        }
    }
    return array_keys($ips);
}

function validate_public_ip($ip)
{
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
}

function validate_target_url($url, $allowlistSuffixes, &$error)
{
    $error = '';
    $parsed = parse_url($url);
    if ($parsed === false || !isset($parsed['scheme']) || !isset($parsed['host'])) {
        $error = 'invalid url';
        return false;
    }

    $scheme = strtolower((string) $parsed['scheme']);
    if ($scheme !== 'http' && $scheme !== 'https') {
        $error = 'unsupported scheme';
        return false;
    }

    $host = strtolower((string) $parsed['host']);
    if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
        $error = 'forbidden host';
        return false;
    }

    if (!empty($allowlistSuffixes)) {
        $allowed = false;
        foreach ($allowlistSuffixes as $suffix) {
            if (host_matches_suffix($host, $suffix)) {
                $allowed = true;
                break;
            }
        }
        if (!$allowed) {
            $error = 'host not allowed';
            return false;
        }
    }

    $resolved = array();
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $resolved[] = $host;
    } else {
        $resolved = resolve_host_ips($host);
    }
    if (count($resolved) === 0) {
        $error = 'dns resolution failed';
        return false;
    }
    foreach ($resolved as $ip) {
        if (!validate_public_ip($ip)) {
            $error = 'resolved ip not allowed';
            return false;
        }
    }

    return true;
}

function resolve_redirect_url($baseUrl, $location)
{
    $location = trim((string) $location);
    if ($location === '') {
        return '';
    }
    $target = parse_url($location);
    if ($target !== false && isset($target['scheme']) && isset($target['host'])) {
        return $location;
    }

    $base = parse_url($baseUrl);
    if ($base === false || !isset($base['scheme']) || !isset($base['host'])) {
        return '';
    }
    $scheme = strtolower((string) $base['scheme']);
    $host = (string) $base['host'];
    $port = isset($base['port']) ? ':' . (int) $base['port'] : '';

    if (strpos($location, '//') === 0) {
        return $scheme . ':' . $location;
    }

    $path = isset($base['path']) ? (string) $base['path'] : '/';
    if ($path === '') {
        $path = '/';
    }
    if ($location[0] === '/') {
        return $scheme . '://' . $host . $port . $location;
    }

    $dir = preg_replace('#/[^/]*$#', '/', $path);
    if ($dir === null || $dir === '') {
        $dir = '/';
    }
    return $scheme . '://' . $host . $port . $dir . $location;
}

function resolve_safe_redirect_chain($initialUrl, $allowlistSuffixes, $requestHeaders, $maxRedirects, &$error)
{
    $error = '';
    $currentUrl = $initialUrl;
    for ($hop = 0; $hop <= $maxRedirects; $hop += 1) {
        if (!validate_target_url($currentUrl, $allowlistSuffixes, $error)) {
            return '';
        }

        $GLOBALS['CHGRID_PROXY_STATUS'] = 200;
        $GLOBALS['CHGRID_PROXY_UP_HEADERS'] = array();
        $GLOBALS['CHGRID_PROXY_HEADERS_SENT'] = false;

        $ch = curl_init();
        if (!$ch) {
            $error = 'proxy init failed';
            return '';
        }

        curl_setopt($ch, CURLOPT_URL, $currentUrl);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        curl_setopt($ch, CURLOPT_MAXREDIRS, 0);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
        curl_setopt($ch, CURLOPT_TIMEOUT, 20);
        curl_setopt($ch, CURLOPT_HEADER, false);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_NOSIGNAL, true);
        curl_setopt($ch, CURLOPT_USERAGENT, 'ChatGridMediaProxy/1.0');
        curl_setopt($ch, CURLOPT_HTTPHEADER, $requestHeaders);
        curl_setopt($ch, CURLOPT_HEADERFUNCTION, 'proxy_header_callback');
        curl_setopt($ch, CURLOPT_NOBODY, true);

        $ok = curl_exec($ch);
        if ($ok === false) {
            $error = 'upstream fetch failed: ' . curl_error($ch);
            curl_close($ch);
            return '';
        }
        curl_close($ch);

        $status = isset($GLOBALS['CHGRID_PROXY_STATUS']) ? (int) $GLOBALS['CHGRID_PROXY_STATUS'] : 200;
        if ($status < 300 || $status >= 400) {
            return $currentUrl;
        }
        if ($hop >= $maxRedirects) {
            $error = 'too many redirects';
            return '';
        }
        $headers = isset($GLOBALS['CHGRID_PROXY_UP_HEADERS']) ? $GLOBALS['CHGRID_PROXY_UP_HEADERS'] : array();
        $location = isset($headers['location']) ? (string) $headers['location'] : '';
        $nextUrl = resolve_redirect_url($currentUrl, $location);
        if ($nextUrl === '') {
            $error = 'redirect location missing or invalid';
            return '';
        }
        $currentUrl = $nextUrl;
    }
    $error = 'too many redirects';
    return '';
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

// Optional allowlist env var: CHGRID_MEDIA_PROXY_ALLOWLIST=dropbox.com,example.com
$allowlistEnv = getenv('CHGRID_MEDIA_PROXY_ALLOWLIST');
$allowlistSuffixes = parse_allowlist_suffixes($allowlistEnv);

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

$resolveError = '';
$finalUrl = resolve_safe_redirect_chain($rawUrl, $allowlistSuffixes, $requestHeaders, 5, $resolveError);
if ($finalUrl === '') {
    if (strpos($resolveError, 'invalid url') === 0 || strpos($resolveError, 'unsupported scheme') === 0) {
        send_text(400, $resolveError);
    }
    if (
        strpos($resolveError, 'forbidden host') === 0 ||
        strpos($resolveError, 'host not allowed') === 0 ||
        strpos($resolveError, 'resolved ip not allowed') === 0
    ) {
        send_text(403, $resolveError);
    }
    if (strpos($resolveError, 'proxy init failed') === 0) {
        send_text(500, $resolveError);
    }
    send_text(502, $resolveError !== '' ? $resolveError : 'redirect resolution failed');
}

curl_setopt($ch, CURLOPT_URL, $finalUrl);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_MAXREDIRS, 0);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
curl_setopt($ch, CURLOPT_TIMEOUT, 0);
curl_setopt($ch, CURLOPT_HEADER, false);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
curl_setopt($ch, CURLOPT_NOSIGNAL, true);
curl_setopt($ch, CURLOPT_USERAGENT, 'ChatGridMediaProxy/1.0');
curl_setopt($ch, CURLOPT_HTTPHEADER, $requestHeaders);
curl_setopt($ch, CURLOPT_HEADERFUNCTION, 'proxy_header_callback');
curl_setopt($ch, CURLOPT_WRITEFUNCTION, 'proxy_write_callback');
if ($method === 'HEAD') {
    curl_setopt($ch, CURLOPT_NOBODY, true);
}

$ok = curl_exec($ch);
if ($ok === false) {
    $err = curl_error($ch);
    curl_close($ch);
    send_text(502, 'upstream fetch failed: ' . $err);
}

if ($method === 'HEAD') {
    proxy_emit_downstream_headers();
}

curl_close($ch);
