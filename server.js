import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// dotenv is only needed locally; Vercel injects env vars itself
try { await import("dotenv/config"); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "10kb" }));

const GROQ_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PROVIDERS = {
  groq: { label: "Groq", envKey: "GROQ_API_KEY" },
  gemini: { label: "Gemini", envKey: "GEMINI_API_KEY" },
};

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ------------------------------------------------------------------ */
/* Prompt builder: rebuilt on every request so the model always gets   */
/* today's date and year. The model has no live web access, so the     */
/* best-practice rules below are what keep the output current.         */
/* ------------------------------------------------------------------ */
function buildPrompts(topic) {
  const now = new Date();
  const today = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const year = now.getFullYear();

  const system = `You are an expert YouTube Content Strategist who optimizes for audience retention, click-through rate (CTR) and search/suggested discovery. Today's date is ${today}. Apply YouTube best practices as of ${year}. Respond with one strict, valid JSON object only: no markdown, no code fences, no commentary.`;

  const user = `Create a complete YouTube video blueprint for this topic: "${topic}"

Follow these current best practices:

TITLE
- 40 to 60 characters so it is not truncated on mobile. Never exceed 100.
- Put the main keyword near the start.
- Create curiosity or a clear benefit, but the title must be honest and match the video's content. No misleading clickbait.
- Only include "${year}" if the topic is time-sensitive (roadmaps, tools, trends).

DESCRIPTION
- The first 2 lines (about 150 characters) must contain the hook and the main keyword, because only these show before "Show more".
- Then a short summary of what viewers will learn, a "Chapters" block that uses the same timestamps as scriptOutline, and one clear call to action (subscribe, comment with a question, or watch a related video).
- End with 3 relevant hashtags. Do not keyword-stuff.

TAGS
- 8 to 12 tags: 2 to 3 broad, the rest specific and long-tail, in natural search phrasing.
- No "#" symbol, and under 400 characters in total.

SCRIPT OUTLINE
- Each item is a string in the form "M:SS - Section title: one-line summary of what happens".
- Start with "0:00" and a hook that states the payoff or a bold promise within the first 5 to 15 seconds. Do not open with a long intro or channel branding.
- 6 to 9 sections. Include a pattern interrupt or open loop around the middle to hold retention, and end with a call to action that points to a next video.
- Timestamps must increase and suit a video of 8 to 12 minutes.

THUMBNAIL IDEAS
- Exactly 3 distinct concepts.
- "text": at most 4 words of large overlay text, which should add to the title and not repeat it.
- "visual": one sentence describing one clear focal point, an emotional face or a strong object, high contrast, a simple background and a 16:9 layout.

Return ONLY this JSON structure:
{
  "title": "string",
  "description": "string",
  "tags": ["string"],
  "scriptOutline": ["string"],
  "thumbnailIdeas": [
    { "text": "string", "visual": "string" }
  ]
}`;

  return { system, user };
}

/* ------------------------------------------------------------------ */
/* Safely parse and normalize model output                             */
/* ------------------------------------------------------------------ */
function parseModelJson(raw) {
  if (!raw) throw new Error("Empty response from model");
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("Model did not return valid JSON");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

function normalize(data) {
  const tags = (Array.isArray(data.tags) ? data.tags : [])
    .map((t) => str(t).replace(/^#+/, ""))
    .filter(Boolean);

  // Keep total tag length inside YouTube's 500-character limit
  const safeTags = [];
  let total = 0;
  for (const t of tags) {
    if (total + t.length + 1 > 500) break;
    safeTags.push(t);
    total += t.length + 1;
  }

  const thumbnailIdeas = (Array.isArray(data.thumbnailIdeas) ? data.thumbnailIdeas : [])
    .map((x) =>
      typeof x === "string"
        ? { text: "", visual: x.trim() }
        : { text: str(x && x.text), visual: str(x && x.visual) }
    )
    .filter((x) => x.text || x.visual)
    .slice(0, 3);

  const result = {
    title: str(data.title).slice(0, 100),
    description: str(data.description),
    tags: safeTags,
    scriptOutline: (Array.isArray(data.scriptOutline) ? data.scriptOutline : [])
      .map(str)
      .filter(Boolean),
    thumbnailIdeas,
  };

  if (!result.title || !result.scriptOutline.length) {
    throw new Error("Model response was missing required fields");
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Provider calls: each returns the raw JSON text from the model       */
/* ------------------------------------------------------------------ */
async function callGroq({ system, user, apiKey }) {
  const { default: Groq } = await import("groq-sdk"); // loaded lazily so a missing package is a handled error
  const client = new Groq({ apiKey });
  const completion = await client.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model: GROQ_MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
  });
  return completion.choices[0]?.message?.content;
}

async function callGemini({ system, user, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
    }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(json?.error?.message || `Gemini request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

const CALLERS = { groq: callGroq, gemini: callGemini };

async function generatePlan(req, res) {
  try {
    const body = req.body || {};
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic) return res.status(400).json({ error: "Topic is required" });
    if (topic.length > 200) {
      return res.status(400).json({ error: "Topic must be 200 characters or fewer" });
    }

    const provider = typeof body.provider === "string" ? body.provider.toLowerCase() : "groq";
    if (!PROVIDERS[provider]) {
      return res.status(400).json({ error: "Unsupported provider. Use 'groq' or 'gemini'." });
    }

    const customKey = typeof body.customKey === "string" ? body.customKey.trim() : "";
    if (customKey.length > 300) return res.status(400).json({ error: "API key looks invalid" });

    const { label, envKey } = PROVIDERS[provider];
    const apiKey = customKey || process.env[envKey];
    if (!apiKey) {
      return res.status(400).json({
        error: `No ${label} API key found. Paste one in the settings panel or set ${envKey} on the server.`,
      });
    }

    const { system, user } = buildPrompts(topic);
    const raw = await CALLERS[provider]({ system, user, apiKey });
    const data = normalize(parseModelJson(raw));

    res.json({ success: true, provider, data });
  } catch (error) {
    // Log the message only: never log request bodies or keys
    console.error("Generation error:", error.message);

    const msg = error.message || "Failed to generate content";
    const badKey =
      error.status === 401 || error.status === 403 || /api key (not valid|is invalid)|invalid api key/i.test(msg);
    const status = badKey ? 401 : error.status === 429 ? 429 : 500;
    res.status(status).json({
      error: badKey ? "The API key was rejected by the provider. Check it and try again." : msg,
    });
  }
}

app.post("/api/generatePlan", generatePlan);
app.post("/api/generateScript", generatePlan); // kept for older clients

// Vercel runs the exported app as a function; only listen when run directly (node server.js)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}\n`);
  });
}

export default app;