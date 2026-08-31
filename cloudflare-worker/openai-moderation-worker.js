// @ts-nocheck — plain Worker module; `env` is Cloudflare's untyped runtime bindings object.
//
// Cloudflare Worker: transparent relay for OpenAI's Moderation API (POST /v1/moderations).
//
// Exists ONLY because OpenAI's API server doesn't send CORS headers at all — confirmed
// directly: an OPTIONS preflight to https://api.openai.com/v1/moderations 404s with no
// Access-Control-Allow-Origin under any circumstance, for any origin. That's a hard block on
// OpenAI's side; no header the app's own page sends can work around it. A browser can only
// reach that endpoint through something that (a) isn't itself subject to CORS (a server) and
// (b) adds CORS headers of its own to the response it hands back — this is that, running on
// Cloudflare's edge instead of the app's own PHP host (see api/openai-moderation.php for the
// PHP equivalent, kept as an alternative in the app's settings).
//
// By default this Worker holds its OWN OpenAI key, set as a Worker secret named
// OPENAI_API_KEY (never committed to source — see "Storing your key" below), and uses it for
// any request the app sends without its own Authorization header. The app's Settings dialog
// lets the user optionally supply their own key instead ("Use my own OpenAI API key"); when
// they do, THAT key is sent as this request's Authorization header and is forwarded to OpenAI
// unmodified, overriding the Worker's own — it is never read into a variable that outlives
// this one request, never logged, and never written anywhere (Workers have no persistent
// storage touched here at all — no KV, no Durable Objects, nothing).
//
// Known tradeoff: Access-Control-Allow-Origin below reflects whatever Origin sent the request
// rather than a fixed allowlist, and this Worker now falls back to YOUR OWN stored key for any
// request that doesn't bring its own — so anyone who discovers this Worker's URL can run
// moderation requests against YOUR OpenAI quota/bill, not just their own, for as long as
// OPENAI_API_KEY is set. If that's a concern, lock Access-Control-Allow-Origin below to your
// app's real domain, and/or don't set OPENAI_API_KEY at all (then every caller must supply
// their own key, same trust model as before this fallback existed).
//
// --- Deploying this ---
// Dashboard: Cloudflare dashboard -> Workers & Pages -> Create -> paste this file's contents
// into the editor -> Deploy. You'll get a URL like https://<name>.<your-subdomain>.workers.dev
// — paste THAT into this app's Settings dialog (Cloudflare Worker URL field).
// CLI: `npx wrangler deploy` using the wrangler.toml next to this file (edit `name` in it
// first if you want a different Worker name than "openai-moderation-worker").
//
// --- Storing your key on Cloudflare (so the app works with no key typed in) ---
// Never put the key in wrangler.toml — that file is meant to be committed to source control.
// Use one of these instead, either works:
//   CLI:       npx wrangler secret put OPENAI_API_KEY   (prompts for the value, stores it
//              encrypted server-side, never appears in logs or wrangler.toml)
//   Dashboard: Cloudflare dashboard -> Workers & Pages -> select this Worker -> Settings ->
//              Variables and Secrets -> Add -> name it OPENAI_API_KEY, paste the key, toggle
//              "Encrypt" on -> Deploy.
// Either way it shows up here as env.OPENAI_API_KEY.

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin",
  };
}

function jsonError(request, status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== "POST") {
      return jsonError(request, 405, "Method not allowed.");
    }

    // The app's own key, if the user opted into supplying one, takes priority over the
    // Worker's stored fallback — see the header comment for the override/fallback rationale.
    const authHeader = request.headers.get("Authorization")
      || (env.OPENAI_API_KEY ? "Bearer " + env.OPENAI_API_KEY : null);
    if (!authHeader) {
      return jsonError(request, 401, "No API key: this Worker has no OPENAI_API_KEY secret configured, and the request didn't supply its own Authorization header.");
    }

    const body = await request.text();

    let upstream;
    try {
      upstream = await fetch(OPENAI_MODERATION_URL, {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (err) {
      return jsonError(request, 502, "Upstream request to OpenAI failed: " + err.message);
    }

    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  },
};
