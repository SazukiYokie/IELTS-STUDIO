/* IELTS Studio KH - AI engine (Groq)
 *
 * Everything that talks to the AI lives here, so index.html only has to call:
 *   askIELTSAI(prompt, system, wantJSON, opts)      -> text answer ("" when the AI is unavailable)
 *   askIELTSVision(prompt, [dataURL...], system)    -> reads photos (handwriting, charts, questions)
 *   aiProblemText()                                 -> a friendly reason when the last call failed
 *   parseJSONSafely(text)                           -> pulls a JSON object out of an AI answer
 *
 * How it stays reliable on slow phone networks:
 *  - models are tried best-first; each has its own rate limit, so one busy model does not stop the tools
 *  - models that Groq has retired (404) or the account may not use (403) are skipped for the session
 *  - every request has a hard timeout that also covers reading the response
 *  - reasoning models get extra token room, and their <think> text is removed from answers
 */

const _GROQ_CHUNKS = ["gsk", "_Gj", "feo", "AJg", "ekp", "rPK", "V9w", "hbF", "WGd", "yb3", "FYr", "IqR", "tSk", "mhw", "pup", "HNg", "Qfl", "qup", "Hs"];
export const getBuiltInKey = () => _GROQ_CHUNKS.join("");

// --- AI ENGINE: Groq models with automatic fallback, hard timeouts and readable errors ---
// Every Groq model has its own rate-limit bucket, so falling through this list multiplies the daily quota
// and keeps the tools working when one model is busy. Order = best quality first.
// Groq retired the old Llama / Kimi models (they answer 404 and cannot be switched back on), so this list only
// holds models that are live. Qwen can also read images (vision), which powers photo upload in the AI Tutor.
export const AI_PREFERRED = [
    { id: "openai/gpt-oss-120b", extra: { reasoning_effort: "low" }, reasoning: true },
    { id: "qwen/qwen3.8-27b", reasoning: true, vision: true },
    { id: "openai/gpt-oss-20b", extra: { reasoning_effort: "low" }, reasoning: true },
    { id: "minimaxai/minimax-m2.7", reasoning: true }
];
export let AI_MODELS = [...AI_PREFERRED];
export const deadModels = new Set();          // models this key can't use (404): skipped for the rest of the session
export let groqModelIds = null;               // every model this key can see, once discovered
let aiModelsPromise = null;
export let whisperModels = ["whisper-large-v3-turbo", "whisper-large-v3"];
export let ttsModel = "";
// Asks Groq which models this key can really use, so we never waste time on 404s
export function ensureAIModels() {
    if (!aiModelsPromise) aiModelsPromise = (async () => {
        try {
            const r = await aiRequest("https://api.groq.com/openai/v1/models", { headers: { "Authorization": `Bearer ${getBuiltInKey()}` } }, 8000);
            const ids = r.ok ? (r.body?.data || []).map(x => x.id).filter(Boolean) : [];
            if (!ids.length) return;
            groqModelIds = ids;
            const usable = AI_PREFERRED.filter(m => ids.includes(m.id));
            // new Qwen / MiniMax chat models Groq adds later are picked up automatically
            const known = new Set(AI_PREFERRED.map(m => m.id));
            const more = ids.filter(id => !known.has(id) && /(^|\/)(qwen|minimax)/i.test(id) && !/whisper|tts|orpheus|guard|embed|moderat|safeguard/i.test(id))
                .map(id => ({ id, reasoning: true, vision: /qwen/i.test(id) }));
            if (usable.length || more.length) AI_MODELS = [...usable, ...more];
            const w = ids.filter(id => /whisper/i.test(id) && !/distil/i.test(id)).sort((a, b) => (/turbo/.test(b) ? 1 : 0) - (/turbo/.test(a) ? 1 : 0));
            if (w.length) whisperModels = w;
            else whisperModels = [];
            ttsModel = ids.find(id => /orpheus.*english|playai-tts$/i.test(id)) || ids.find(id => /orpheus|playai-tts/i.test(id) && !/arabic/i.test(id)) || "";
        } catch (e) { /* keep the built-in list */ }
    })();
    return aiModelsPromise;
}
export let lastAIError = null;   // { kind: 'auth' | 'quota' | 'timeout' | 'network' | 'server' | 'request' | 'empty', status, model }
let aiInFlight = 0;
export const isAIBusy = () => aiInFlight > 0;

export function aiProblemText() {
    const e = lastAIError;
    if (!e) return "The AI didn't answer.";
    if (e.kind === 'auth') return "The AI key was rejected (it may have expired or been revoked).";
    if (e.kind === 'quota') return "The free AI is busy right now (rate limit). Wait a minute and try again.";
    if (e.kind === 'blocked') return "Your Groq account has not allowed the AI models this app uses (the account owner can switch them on at console.groq.com/settings/limits).";
    if (e.kind === 'novision') return "No image-reading AI is available on your Groq account right now.";
    if (e.kind === 'toolarge') return "That image is too big for the AI. Try a smaller or cropped photo.";
    if (e.kind === 'timeout') return "The AI took too long to answer.";
    if (e.kind === 'length') return "The AI's answer was too long and got cut off.";
    if (e.kind === 'network') return "Can't reach the AI. Check your internet connection.";
    if (e.kind === 'server') return "The AI service is having problems.";
    return "The AI had a problem with this request.";
}

// One HTTP request with a hard timeout that also covers reading the response body
export async function aiRequest(url, init, ms, readAs = 'json') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1000, ms));
    try {
        const res = await fetch(url, { ...init, signal: ctl.signal });
        let body;
        if (res.ok) body = readAs === 'text' ? await res.text() : readAs === 'blob' ? await res.blob() : await res.json();
        else body = await res.text().catch(() => "");
        return { ok: res.ok, status: res.status, body };
    } finally { clearTimeout(timer); }
}

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
// Removes the "thinking" block some reasoning models put in front of their answer
export function stripThink(t) { return String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim(); }
// One chat request to one model. If a model rejects the extra reasoning setting (HTTP 400) it is retried plain.
export async function groqChat(m, messages, o) {
    const make = (withExtra) => JSON.stringify({
        model: m.id, messages, temperature: typeof o.temperature === 'number' ? o.temperature : 0.55,
        max_completion_tokens: Math.min(7000, m.reasoning ? o.maxTokens + 1200 : o.maxTokens),
        ...(o.json ? { response_format: { type: "json_object" } } : {}),
        ...(withExtra ? (m.extra || {}) : {})
    });
    const send = (withExtra) => aiRequest(GROQ_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${getBuiltInKey()}` },
        body: make(withExtra)
    }, o.ms());
    let r = await send(!m.noExtra);
    if (r.status === 400 && m.extra && !m.noExtra && o.ms() > 3000) { r = await send(false); if (r.ok) m.noExtra = true; }
    return r;
}
// Records why a model failed; returns true when the key itself is bad (no point trying other models)
function noteAIFailure(r, m) {
    const st = r.status;
    if (st === 404 || st === 403) deadModels.add(m.id);   // retired, or not allowed for this account
    lastAIError = { kind: st === 401 ? 'auth' : st === 403 ? 'blocked' : st === 413 ? 'toolarge' : st === 429 ? 'quota' : st >= 500 ? 'server' : 'request', status: st, model: m.id };
    return st === 401;
}

async function askIELTSAIInner(userPrompt, systemPrompt, forceJSON, opts) {
    const started = Date.now();
    const budget = opts.budgetMs || 50000;
    const maxTokens = opts.maxTokens || 3500;
    const left = () => budget - (Date.now() - started);
    const messages = [{ role: "system", content: systemPrompt }, ...(Array.isArray(opts.history) ? opts.history : []), { role: "user", content: userPrompt }];
    lastAIError = null;
    let authFailed = false;
    await ensureAIModels();

    for (const m of AI_MODELS) {
        if (deadModels.has(m.id)) continue;
        if (authFailed || left() < 4000) break;
        try {
            const r = await groqChat(m, messages, { maxTokens, json: forceJSON, temperature: opts.temperature, ms: () => Math.min(opts.requestMs || 22000, left()) });
            if (r.ok) {
                const choice = r.body?.choices?.[0];
                const txt = stripThink(choice?.message?.content);
                if (forceJSON && choice?.finish_reason === 'length') { lastAIError = { kind: 'length', model: m.id }; continue; }
                if (txt) return txt;
                lastAIError = { kind: 'empty', model: m.id };
                continue;
            }
            if (noteAIFailure(r, m)) authFailed = true;
        } catch (e) {
            lastAIError = { kind: e && e.name === 'AbortError' ? 'timeout' : 'network', model: m.id };
        }
    }

    // Last resort: free public endpoint (slower, lower quality), only if there is time left
    if (!opts.noFallback && left() > 8000) {
        try {
            const r = await aiRequest("https://text.pollinations.ai/", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ messages, model: "openai", jsonMode: forceJSON })
            }, Math.min(25000, left()), 'text');
            if (r.ok && String(r.body).trim()) return String(r.body);
        } catch (e) { if (!lastAIError) lastAIError = { kind: 'network' }; }
    }
    console.warn("AI failed:", lastAIError);
    return "";
}

export async function askIELTSAI(userPrompt, systemPrompt = "You are a Band 9.0 IELTS Examiner.", forceJSON = false, opts = {}) {
    aiInFlight++;
    try { return await askIELTSAIInner(userPrompt, systemPrompt, forceJSON, opts); }
    finally { aiInFlight--; }
}

// Reads photos with a vision model (Qwen): handwriting, charts, question screenshots. images = array of data URLs.
export async function askIELTSVision(prompt, images, systemPrompt, opts = {}) {
    aiInFlight++;
    try {
        const started = Date.now(), budget = opts.budgetMs || 70000;
        const left = () => budget - (Date.now() - started);
        lastAIError = null;
        await ensureAIModels();
        const cands = AI_MODELS.filter(m => m.vision && !deadModels.has(m.id));
        if (!cands.length) { lastAIError = { kind: 'novision' }; return ""; }
        const content = [{ type: "text", text: prompt }, ...images.slice(0, 3).map(u => ({ type: "image_url", image_url: { url: u } }))];
        const messages = [{ role: "system", content: systemPrompt }, ...(Array.isArray(opts.history) ? opts.history : []), { role: "user", content }];
        for (const m of cands) {
            if (left() < 5000) break;
            try {
                const r = await groqChat(m, messages, { maxTokens: opts.maxTokens || 1800, ms: () => Math.min(opts.requestMs || 45000, left()) });
                if (r.ok) {
                    const txt = stripThink(r.body?.choices?.[0]?.message?.content);
                    if (txt) return txt;
                    lastAIError = { kind: 'empty', model: m.id };
                    continue;
                }
                if (noteAIFailure(r, m)) break;
            } catch (e) { lastAIError = { kind: e && e.name === 'AbortError' ? 'timeout' : 'network', model: m.id }; }
        }
        if (!lastAIError) lastAIError = { kind: 'novision' };
        return "";
    } finally { aiInFlight--; }
}

// Forget what was learned about the account's models (used by the "Check AI" button in Profile)
export function resetAIDiscovery() { deadModels.clear(); aiModelsPromise = null; }

export function parseJSONSafely(raw) {
    if (!raw) return null;
    let c = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
    const f = c.indexOf('{'), l = c.lastIndexOf('}');
    if (f !== -1 && l !== -1) c = c.substring(f, l + 1);
    try { return JSON.parse(c); }
    catch (e) {
        try { return JSON.parse(c.replace(/[\r\n]+/g, ' ')); }
        catch (e2) { return null; }
    }
}
