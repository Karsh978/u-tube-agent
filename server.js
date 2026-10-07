require("dotenv").config();
const express = require("express");
const path = require("path");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json({ limit: "10kb" }));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

app.use(express.static(path.join(__dirname, "netlify", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "netlify", "public", "index.html"));
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

app.post("/api/generateScript", async (req, res) => {
  try {
    const topic = typeof req.body.topic === "string" ? req.body.topic.trim() : "";
    if (!topic) return res.status(400).json({ error: "Topic is required" });
    if (topic.length > 200) {
      return res.status(400).json({ error: "Topic must be 200 characters or fewer" });
    }

    const { system, user } = buildPrompts(topic);

    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      model: MODEL,
      temperature: 0.7,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content;
    const data = normalize(parseModelJson(raw));

    res.json({ success: true, data });
  } catch (error) {
    console.error("Groq Error:", error);
    res.status(500).json({ error: error.message || "Failed to generate content" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running with Groq on http://localhost:${PORT}\n`);
});