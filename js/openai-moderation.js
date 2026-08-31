// @ts-nocheck — plain classic-script module; VMOpenAIModeration is wired as a window global,
// same pattern as VMDB/VMScanner/VMSnapshots/VMI18n.
//
// Thin client for OpenAI's real Moderation API (POST /v1/moderations, "omni-moderation-latest"
// — the multimodal model, which accepts image inputs alongside text). By default the relay
// itself holds the API key (see cloudflare-worker/openai-moderation-worker.js's OPENAI_API_KEY
// secret); the app's Settings dialog also lets the user optionally supply their own key
// (settings.useOwnOpenAIApiKey/openaiApiKey), which overrides the relay's stored one for that
// request. Used as an optional secondary confirmation pass after a local NudeNet scan finishes
// (see app.js's runOpenAIModerationPass): each detected scene's peak frame gets checked here,
// and the verdict is stored per-scene so the Timecodes dialog can optionally show only
// AI-confirmed scenes.
//
// Goes through a same-purpose relay rather than api.openai.com directly — OpenAI's API server
// sends no CORS headers at all (confirmed: an OPTIONS preflight to it 404s, unconditionally,
// for any origin), so a browser literally cannot call it directly, no matter what this page's
// own headers are. Two relay implementations ship with this app (see settings:
// moderationProxyMethod, which one gets used, and phpEndpointUrl() below):
//   - A Cloudflare Worker (cloudflare-worker/openai-moderation-worker.js) — the default; the
//     user deploys their own copy and pastes its URL into Settings.
//   - api/openai-moderation.php — same origin as this app, no separate deployment needed.
// Both do the exact same thing: forward this request's Authorization header straight through
// to OpenAI (when one is sent — otherwise the relay falls back to its own stored key) and add
// CORS headers to the response, without ever storing or logging a browser-supplied key
// server-side — see either file's own header comment for the full reasoning. Neither is baked
// in here — checkImage takes the endpoint to use explicitly, so this module doesn't need to
// know which relay method is configured.
(function (global) {
  const MODEL = "omni-moderation-latest";

  // Captured synchronously, at load time, the same way scanner.js resolves its own worker
  // URLs — document.currentScript is ONLY valid while this script is the one actively
  // executing; it's null (or refers to whatever else is running) by the time phpEndpointUrl()
  // below gets called later from an async context, so this can't be computed lazily inside
  // that function itself.
  const scriptBase = document.currentScript ? document.currentScript.src : document.baseURI;

  // The categories in OpenAI's own fixed taxonomy that correspond to what this app cares
  // about (see nudenet-worker.js's CONFIRM_LABELS for the equivalent NudeNet classes — the
  // two taxonomies don't line up 1:1, this endpoint doesn't accept custom category
  // definitions). "sexual/minors" is included defensively: never treat a frame as "not
  // nudity" just because the general "sexual" category didn't also fire.
  const NUDITY_CATEGORIES = ["sexual", "sexual/minors"];

  // The PHP relay's URL — this script lives in js/; api/openai-moderation.php is a sibling of
  // js/, not inside it. There's no equivalent helper for the Cloudflare Worker URL since that
  // one is inherently the user's own — see settings.cloudflareWorkerUrl instead.
  function phpEndpointUrl() {
    return new URL("../api/openai-moderation.php", scriptBase).href;
  }

  // Checks one image (a data: URL, e.g. from VMSnapshots.captureFullFrameBatch) against the
  // Moderation API, via whichever relay `endpoint` points at. Resolves { flagged, categories,
  // categoryScores } on success. Throws on any HTTP/network failure — callers decide how to
  // handle a failed check (see runOpenAIModerationPass, which leaves that scene's verdict
  // unset rather than aborting the whole pass over one bad request).
  //
  // apiKey is optional: when omitted, no Authorization header is sent at all, letting the
  // relay fall back to its own stored key (see settings.useOwnOpenAIApiKey and the Cloudflare
  // Worker's own OPENAI_API_KEY fallback) — only pass one when the user opted into supplying
  // their own, which then overrides whatever the relay has stored.
  async function checkImage(apiKey, dataUrl, endpoint) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        input: [{ type: "image_url", image_url: { url: dataUrl } }],
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const errBody = await res.json();
        detail = (errBody && errBody.error && errBody.error.message) || "";
      } catch (e) { /* response body wasn't JSON — fall back to just the status */ }
      throw new Error("OpenAI Moderation API request failed (" + res.status + ")" + (detail ? ": " + detail : ""));
    }
    const data = await res.json();
    const result = data && data.results && data.results[0];
    if (!result) throw new Error("OpenAI Moderation API returned no result.");
    const flagged = NUDITY_CATEGORIES.some((c) => result.categories && result.categories[c]);
    return { flagged, categories: result.categories, categoryScores: result.category_scores };
  }

  global.VMOpenAIModeration = { checkImage, phpEndpointUrl };
})(window);
