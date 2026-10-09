import "dotenv/config"; // loads .env locally; Vercel injects env vars itself
import express from "express";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const archiverModule = require("archiver");
const archiver = archiverModule.default || archiverModule;   // ✅ dono cases handle
const app = express();
app.use(express.json({ limit: "10kb" }));

const GROQ_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PROVIDERS = {
  groq: { label: "Groq", envKey: "GROQ_API_KEY" },
  gemini: { label: "Gemini", envKey: "GEMINI_API_KEY" },
};

app.use(express.static(path.join(process.cwd(), "public")));

/* ------------------------------------------------------------------ */
/* Health check                                                        */
/* ------------------------------------------------------------------ */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasHFKey: Boolean(process.env.HF_API_KEY),
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

/* ------------------------------------------------------------------ */
/* Prompt builder                                                      */
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

SCENE-BY-SCENE VISUAL PROMPTS
- Match each scriptOutline section with ONE visual prompt.
- Each prompt must be a cinematic English sentence usable by a text-to-image / text-to-video model.
- Format: "A [shot type] of [subject] in [setting], [lighting], [mood], [style]"
- Example: "A cinematic close-up shot of a futuristic AI laboratory, neon blue lighting, moody atmosphere, ultra-realistic 8k"
- "scene" must match the timestamp from scriptOutline (e.g. "0:00").
- "duration" must be a number of seconds (between 5 and 15).

Return ONLY this JSON structure:
{
  "title": "string",
  "description": "string",
  "tags": ["string"],
  "scriptOutline": ["string"],
  "thumbnailIdeas": [
    { "text": "string", "visual": "string" }
  ],
  "sceneByScenePrompts": [
    { "scene": "string", "prompt": "string", "duration": 8 }
  ]
}`;

  return { system, user };
}

/* ------------------------------------------------------------------ */
/* Parse & normalize                                                   */
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

  const sceneByScenePrompts = (Array.isArray(data.sceneByScenePrompts)
    ? data.sceneByScenePrompts
    : []
  )
    .map((s) => ({
      scene: str(s && s.scene),
      prompt: str(s && s.prompt),
      duration: Number.isFinite(s && s.duration) ? Number(s.duration) : 8,
    }))
    .filter((s) => s.prompt);

  const result = {
    title: str(data.title).slice(0, 100),
    description: str(data.description),
    tags: safeTags,
    scriptOutline: (Array.isArray(data.scriptOutline) ? data.scriptOutline : [])
      .map(str)
      .filter(Boolean),
    thumbnailIdeas,
    sceneByScenePrompts,
  };

  if (!result.title || !result.scriptOutline.length) {
    throw new Error("Model response was missing required fields");
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Provider calls                                                      */
/* ------------------------------------------------------------------ */
async function callGroq({ system, user, apiKey }) {
  const { default: Groq } = await import("groq-sdk");
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

/* ------------------------------------------------------------------ */
/* /api/generatePlan                                                   */
/* ------------------------------------------------------------------ */
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
    console.error("Generation error:", error.message);

    const msg = error.message || "Failed to generate content";
    const badKey =
      error.status === 401 ||
      error.status === 403 ||
      /api key (not valid|is invalid)|invalid api key/i.test(msg);
    const status = badKey ? 401 : error.status === 429 ? 429 : 500;
    res.status(status).json({
      error: badKey ? "The API key was rejected by the provider. Check it and try again." : msg,
    });
  }
}

app.post("/api/generatePlan", generatePlan);
app.post("/api/generateScript", generatePlan);

/* ------------------------------------------------------------------ */
/* Media helpers                                                       */
/* ------------------------------------------------------------------ */
function buildPollinationsImageUrl(prompt, { width = 1280, height = 720, seed, model = "flux" } = {}) {
  const encoded = encodeURIComponent(prompt);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    nologo: "true",
  });
  if (seed) params.set("seed", String(seed));
  return `https://image.pollinations.ai/prompt/${encoded}?${params.toString()}`;
}

async function hfTextToVideo({ prompt, apiKey, model }) {
  const res = await fetch(
    `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "video/mp4",
      },
      body: JSON.stringify({ inputs: prompt }),
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`HuggingFace failed (${res.status}): ${txt.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:video/mp4;base64,${buf.toString("base64")}`;
}

function aspectDims(aspect) {
  if (aspect === "9:16") return { width: 720, height: 1280 };
  if (aspect === "1:1") return { width: 1024, height: 1024 };
  return { width: 1280, height: 720 };
}

/* ------------------------------------------------------------------ */
/* /api/generateMedia — Pollinations (images) OR HuggingFace (videos)  */
/* ------------------------------------------------------------------ */
app.post("/api/generateMedia", async (req, res) => {
  try {
    const { prompts, aspect = "16:9", engine = "pollinations" } = req.body || {};

    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: "prompts[] is required" });
    }
    if (prompts.length > 20) {
      return res.status(400).json({ error: "Max 20 scenes per request" });
    }

    const dims = aspectDims(aspect);
    const assets = [];

    if (engine === "huggingface") {
      const apiKey =
        (typeof req.body.hfKey === "string" && req.body.hfKey.trim()) ||
        process.env.HF_API_KEY;
      if (!apiKey) {
        return res.status(400).json({
          error: "HF_API_KEY missing. Set it in .env or paste in settings.",
        });
      }
      const model = process.env.HF_VIDEO_MODEL || "damo-vilab/text-to-video-ms-1.7b";

      // Videos are slow; cap at 6 per request
      const limited = prompts.slice(0, 6);
      for (let i = 0; i < limited.length; i++) {
        const item = limited[i];
        const prompt = typeof item === "string" ? item : item.prompt;
        const scene = typeof item === "object" && item.scene ? item.scene : `Scene ${i + 1}`;
        if (!prompt) continue;
        try {
          const url = await hfTextToVideo({ prompt, apiKey, model });
          assets.push({ scene, prompt, type: "video", url });
        } catch (e) {
          console.warn("HF scene failed:", scene, e.message);
          // fall back to Pollinations image for this scene
          assets.push({
            scene,
            prompt,
            type: "image",
            url: buildPollinationsImageUrl(prompt, { ...dims, seed: 1000 + i }),
            fallback: true,
          });
        }
      }
    } else {
      // pollinations (default)
      for (let i = 0; i < prompts.length; i++) {
        const item = prompts[i];
        const prompt = typeof item === "string" ? item : item.prompt;
        const scene = typeof item === "object" && item.scene ? item.scene : `Scene ${i + 1}`;
        if (!prompt) continue;
        assets.push({
          scene,
          prompt,
          type: "image",
          url: buildPollinationsImageUrl(prompt, { ...dims, seed: 1000 + i }),
        });
      }
    }

    res.json({ success: true, engine, count: assets.length, assets });
  } catch (err) {
    console.error("Media error:", err.message);
    res.status(500).json({ error: err.message || "Media generation failed" });
  }
});

/* ------------------------------------------------------------------ */
/* /api/downloadZip — bundles images + script + metadata               */
/* ------------------------------------------------------------------ */
app.post("/api/downloadZip", async (req, res) => {
  try {
    const { plan, aspect = "16:9" } = req.body || {};
    if (!plan || typeof plan !== "object") {
      return res.status(400).json({ error: "plan object is required" });
    }

    const dims = aspectDims(aspect);
    const scenes = Array.isArray(plan.sceneByScenePrompts) ? plan.sceneByScenePrompts : [];
    if (!scenes.length) {
      return res.status(400).json({ error: "No scenes in plan" });
    }

    // ---- FIXED: single, clean slug for the whole ZIP ----
    const zipBase = (typeof plan.title === "string" && plan.title.trim()
      ? plan.title
      : "badger-plan"
    )
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "badger-plan";

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${zipBase}.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      console.error("Zip error:", err.message);
      if (!res.headersSent) res.status(500).end();
    });
    archive.on("warning", (err) => {
      console.warn("Zip warning:", err.message);
    });

    archive.pipe(res);

    // 1. Metadata JSON
    archive.append(JSON.stringify(plan, null, 2), { name: "plan.json" });

    // 2. Script as text
    const scriptTxt = [
      `TITLE: ${plan.title || ""}`,
      "",
      `DESCRIPTION:`,
      plan.description || "",
      "",
      `TAGS: ${(plan.tags || []).map((t) => "#" + t).join(" ")}`,
      "",
      `SCRIPT OUTLINE:`,
      (plan.scriptOutline || []).map((s, i) => `${i + 1}. ${s}`).join("\n"),
      "",
      `SCENE PROMPTS:`,
      scenes.map((s) => `[${s.scene}] (${s.duration || 8}s) ${s.prompt}`).join("\n"),
    ].join("\n");
    archive.append(scriptTxt, { name: "script.txt" });

    // 3. Fetch each image and add
    let imgCount = 0;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      if (!s.prompt) continue;
      const url = buildPollinationsImageUrl(s.prompt, { ...dims, seed: 1000 + i });
      try {
        const r = await fetch(url);
        if (!r.ok) {
          console.warn("Image fetch failed:", s.scene, r.status);
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());

        // ---- FIXED: safe per-scene filename ----
        const sceneTag = String(s.scene || `scene-${i + 1}`)
          .replace(/[^a-z0-9-_]+/gi, "-")
          .replace(/^-+|-+$/g, "") || `scene-${i + 1}`;
        const fname = `scenes/${String(i + 1).padStart(2, "0")}-${sceneTag}.jpg`;

        archive.append(buf, { name: fname });
        imgCount++;
      } catch (e) {
        console.warn("Scene fetch failed:", s.scene, e.message);
      }
    }

    archive.append(
      [
        "Badger — Agentic AI Studio",
        `Generated: ${new Date().toISOString()}`,
        `Title: ${plan.title || ""}`,
        `Scenes: ${scenes.length}`,
        `Images bundled: ${imgCount}`,
        "",
        "Contents:",
        "  plan.json      — full structured plan",
        "  script.txt     — human-readable script",
        "  scenes/*.jpg   — one image per scene prompt",
      ].join("\n"),
      { name: "README.txt" }
    );

    await archive.finalize();
  } catch (err) {
    console.error("Zip error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`\n🦡 Badger running on http://localhost:${PORT}\n`);
  });
}

export default app;