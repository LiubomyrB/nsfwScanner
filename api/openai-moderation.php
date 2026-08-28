<?php
// Minimal transparent relay for OpenAI's Moderation API (POST /v1/moderations).
//
// Exists ONLY because OpenAI's API server doesn't send CORS headers at all — confirmed
// directly: an OPTIONS preflight to https://api.openai.com/v1/moderations 404s with no
// Access-Control-Allow-Origin under any circumstance, for any origin. That's a hard block on
// OpenAI's side; no header this app's own page sends (COOP/COEP or otherwise) can work around
// it. A browser can only reach that endpoint through something that (a) isn't itself subject
// to CORS (a server) and (b) adds CORS headers of its own to the response it hands back.
//
// This does NOT hold a server-side API key. The user's own key (typed into Settings — see
// js/openai-moderation.js) is sent from the browser as this request's own Authorization
// header and simply forwarded to OpenAI unmodified; it is never read into a variable that
// outlives this one request, never logged, and never written anywhere. If this key were
// compromised in transit it'd be exactly as compromised as it already was being sent straight
// to OpenAI — this adds a hop, not a trust boundary.
//
// Known tradeoff: Access-Control-Allow-Origin below reflects whatever Origin sent the
// request rather than a fixed allowlist, so anyone who finds this URL could relay requests
// through it using THEIR OWN OpenAI key — costs this server a little bandwidth/CPU per
// request, but never exposes anything of ours (no key of ours exists here to expose). Lock
// this down to a specific origin below if that's ever a concern.

header("Access-Control-Allow-Origin: " . ($_SERVER['HTTP_ORIGIN'] ?? '*'));
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Authorization, Content-Type");
header("Vary: Origin");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

header("Content-Type: application/json");

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(["error" => ["message" => "Method not allowed."]]);
    exit;
}

// Some server configs (notably Apache/mod_php without CGIPassAuth) don't populate
// $_SERVER['HTTP_AUTHORIZATION'] at all — see the .htaccess next to this file, which fixes
// that for Apache. getallheaders() (when available) is checked first since it's the most
// reliable source when the server does pass the header through at all.
function requestAuthorizationHeader() {
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) return $value;
        }
    }
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) return $_SERVER['HTTP_AUTHORIZATION'];
    if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) return $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    return null;
}

$authHeader = requestAuthorizationHeader();
if (!$authHeader) {
    http_response_code(401);
    echo json_encode(["error" => ["message" => "Missing Authorization header."]]);
    exit;
}

$body = file_get_contents('php://input');

$ch = curl_init('https://api.openai.com/v1/moderations');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => [
        "Authorization: " . $authHeader,
        "Content-Type: application/json",
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 30,
]);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErrno = curl_errno($ch);
$curlError = curl_error($ch);
curl_close($ch);

if ($response === false || $curlErrno) {
    http_response_code(502);
    echo json_encode(["error" => ["message" => "Upstream request to OpenAI failed: " . $curlError]]);
    exit;
}

http_response_code($httpCode ?: 502);
echo $response;
