// @ts-nocheck — plain classic-script module; VMOpenAIModeration is wired as a window global,
// same pattern as VMDB/VMScanner/VMSnapshots/VMI18n.
//
// Thin client for OpenAI's real Moderation API (POST /v1/moderations, "omni-moderation-latest"
// — the multimodal model, which accepts image inputs alongside text), using the user's own
// key (see app.js's settings: openaiModerationEnabled/openaiApiKey). Used as an optional
// secondary confirmation pass after a local NudeNet scan finishes (see app.js's
// runOpenAIModerationPass): each detected scene's peak frame gets checked here, and the
// verdict is stored per-scene so the Timecodes dialog can optionally show only AI-confirmed
// scenes.
//
// Goes through api/openai-moderation.php (same origin) rather than api.openai.com directly —
// OpenAI's API server sends no CORS headers at all (confirmed: an OPTIONS preflight to it
// 404s, unconditionally, for any origin), so a browser literally cannot call it directly, no
// matter what this page's own headers are. That PHP file is a transparent relay: it forwards
// this request's Authorization header (the user's key) straight through to OpenAI and adds
// CORS headers to the response, without ever storing or logging the key server-side — see
// its own header comment for the full reasoning.
(function (global) {
  // Resolved relative to this script's own location (same reasoning as scanner.js's worker
  // URLs) so it keeps working regardless of what directory index.html is served from.
  const scriptBase = document.currentScript ? document.currentScript.src : document.baseURI;
  // This script lives in js/; api/openai-moderation.php is a sibling of js/, not inside it.
  const ENDPOINT = new URL("../api/openai-moderation.php", scriptBase).href;
  const MODEL = "omni-moderation-latest";

  // The categories in OpenAI's own fixed taxonomy that correspond to what this app cares
  // about (see nudenet-worker.js's CONFIRM_LABELS for the equivalent NudeNet classes — the
  // two taxonomies don't line up 1:1, this endpoint doesn't accept custom category
  // definitions). "sexual/minors" is included defensively: never treat a frame as "not
  // nudity" just because the general "sexual" category didn't also fire.
  const NUDITY_CATEGORIES = ["sexual", "sexual/minors"];

  // Checks one image (a data: URL, e.g. from VMSnapshots.captureFullFrameBatch) against the
  // Moderation API. Resolves { flagged, categories, categoryScores } on success. Throws on
  // any HTTP/network failure — callers decide how to handle a failed check (see
  // runOpenAIModerationPass, which leaves that scene's verdict unset rather than aborting the
  // whole pass over one bad request).
  async function checkImage(apiKey, dataUrl) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
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

  global.VMOpenAIModeration = { checkImage };
})(window);
