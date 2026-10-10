import "dotenv/config";
import express from "express";
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const require = createRequire(import.meta.url);
const archiverModule = require("archiver");
const archiver = archiverModule.default || archiverModule;

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
console.log("🎬 FFmpeg binary:", ffmpegInstaller.path);

const app = express();
app.use(express.json({ limit: "5mb" }));

const GROQ_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PROVIDERS = {
  groq: { label: "Groq", envKey: "GROQ_API_KEY" },
  gemini: { label: "Gemini", envKey: "GEMINI_API_KEY" },
};

app.use(express.static(path.join(process.cwd(), "public")));

/* Health */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasHFKey: Boolean(process.env.HF_API_KEY),
    ffmpegPath: ffmpegInstaller.path,
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

/* -------------------- Prompt builder -------------------- */
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
- "scene" must match the timestamp from scriptOutline.
- "duration" must be a number of seconds between 5 and 15.
- ALSO return a short "caption" per scene: max 6 words, suitable for on-screen text overlay.

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
    { "scene": "string", "prompt": "string", "duration": 8, "caption": "string" }
  ]
}`;

  return { system, user };
}

/* -------------------- Parse & normalize -------------------- */
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
      caption: str(s && s.caption),
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

/* -------------------- Provider calls -------------------- */
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

/* -------------------- /api/generatePlan -------------------- */
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
      return res.status(400).json({ error: "Unsupported provider." });
    }

    const customKey = typeof body.customKey === "string" ? body.customKey.trim() : "";
    if (customKey.length > 300) return res.status(400).json({ error: "API key looks invalid" });

    const { label, envKey } = PROVIDERS[provider];
    const apiKey = customKey || process.env[envKey];
    if (!apiKey) {
      return res.status(400).json({
        error: `No ${label} API key found.`,
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
      error: badKey ? "The API key was rejected." : msg,
    });
  }
}

app.post("/api/generatePlan", generatePlan);
app.post("/api/generateScript", generatePlan);

/* -------------------- MEDIA HELPERS -------------------- */
function buildPicsumUrl(seed, width, height) {
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

async function hfTextToImage({ prompt, apiKey, model = "black-forest-labs/FLUX.1-schnell" }) {
  const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { width: 1280, height: 720 },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`HF image failed (${res.status}): ${txt.slice(0, 150)}`);
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

function aspectDims(aspect) {
  if (aspect === "9:16") return { width: 720, height: 1280 };
  if (aspect === "1:1") return { width: 1024, height: 1024 };
  return { width: 1280, height: 720 };
}

/* -------------------- /api/generateMedia -------------------- */
app.post("/api/generateMedia", async (req, res) => {
  try {
    const { prompts, aspect = "16:9", engine = "auto" } = req.body || {};

    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: "prompts[] is required" });
    }
    if (prompts.length > 20) {
      return res.status(400).json({ error: "Max 20 scenes per request" });
    }

    const dims = aspectDims(aspect);
    const hfKey = process.env.HF_API_KEY;
    const assets = [];

    for (let i = 0; i < prompts.length; i++) {
      const item = prompts[i];
      const prompt = typeof item === "string" ? item : item.prompt;
      const scene = typeof item === "object" && item.scene ? item.scene : `Scene ${i + 1}`;
      const caption = typeof item === "object" && item.caption ? item.caption : "";
      if (!prompt) continue;

      let imageUrl = null;
      let source = "picsum";

      if (hfKey && (engine === "auto" || engine === "huggingface")) {
        try {
          console.log(`[MEDIA] HF image ${i + 1}/${prompts.length}...`);
          imageUrl = await hfTextToImage({ prompt, apiKey: hfKey });
          source = "huggingface";
          console.log(`[MEDIA] HF ✓ scene ${i + 1}`);
        } catch (e) {
          console.warn(`[MEDIA] HF failed scene ${i + 1}:`, e.message);
        }
      }

      if (!imageUrl) {
        const randomSeed = Math.floor(Math.random() * 1000000);
        imageUrl = buildPicsumUrl(randomSeed, dims.width, dims.height);
        source = "picsum";
      }

      assets.push({ scene, prompt, caption, type: "image", url: imageUrl, source });

      if (source === "huggingface") await new Promise((r) => setTimeout(r, 1000));
    }

    res.json({ success: true, engine, count: assets.length, assets });
  } catch (err) {
    console.error("Media error:", err.message);
    res.status(500).json({ error: err.message || "Media generation failed" });
  }
});

/* -------------------- /api/downloadZip -------------------- */
app.post("/api/downloadZip", async (req, res) => {
  console.log("[ZIP] Request received");
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

    const zipBase = (
      typeof plan.title === "string" && plan.title.trim() ? plan.title : "badger-plan"
    )
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "badger-plan";

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipBase}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("[ZIP] error:", err.message);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    archive.pipe(res);

    archive.append(JSON.stringify(plan, null, 2), { name: "plan.json" });

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

    const results = await Promise.all(
      scenes.map(async (s, i) => {
        if (!s.prompt) return null;
        const hfKey = process.env.HF_API_KEY;
        let imageBuf = null;
        let ext = "jpg";

        if (hfKey) {
          try {
            const url = await hfTextToImage({ prompt: s.prompt, apiKey: hfKey });
            // data URL → buffer
            const b64 = url.split(",")[1];
            imageBuf = Buffer.from(b64, "base64");
          } catch (e) {
            console.warn("[ZIP] HF failed, using Picsum:", e.message);
          }
        }

        if (!imageBuf) {
          const seed = Math.floor(Math.random() * 1000000);
          try {
            const r = await fetch(buildPicsumUrl(seed, dims.width, dims.height), {
              signal: AbortSignal.timeout(60000),
            });
            if (r.ok) imageBuf = Buffer.from(await r.arrayBuffer());
          } catch (e) {
            console.warn("[ZIP] Picsum fetch failed:", e.message);
          }
        }

        if (!imageBuf) return null;

        const sceneTag =
          String(s.scene || `scene-${i + 1}`)
            .replace(/[^a-z0-9-_]+/gi, "-")
            .replace(/^-+|-+$/g, "") || `scene-${i + 1}`;
        const fname = `scenes/${String(i + 1).padStart(2, "0")}-${sceneTag}.${ext}`;
        return { fname, buf: imageBuf };
      })
    );

    let imgCount = 0;
    for (const r of results) {
      if (r) {
        archive.append(r.buf, { name: r.fname });
        imgCount++;
      }
    }

    archive.append(
      [
        "Badger — Agentic AI Studio",
        `Generated: ${new Date().toISOString()}`,
        `Title: ${plan.title || ""}`,
        `Scenes: ${scenes.length}`,
        `Images bundled: ${imgCount}`,
      ].join("\n"),
      { name: "README.txt" }
    );

    await archive.finalize();
    console.log("[ZIP] Done ✓");
  } catch (err) {
    console.error("[ZIP] error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

/* -------------------- /api/buildVideo (Ken Burns + fades) -------------------- */
app.post("/api/buildVideo", async (req, res) => {
  console.log("[VIDEO] Request received");
  const workDir = path.join(
    os.tmpdir(),
    `badger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    const { scenes, aspect = "16:9", title = "video" } = req.body || {};

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: "scenes[] is required" });
    }
    if (scenes.length > 20) {
      return res.status(400).json({ error: "Max 20 scenes per video" });
    }

    const { width, height } =
      aspect === "9:16" ? { width: 720, height: 1280 }
      : aspect === "1:1" ? { width: 1024, height: 1024 }
      : { width: 1280, height: 720 };

    console.log("[VIDEO] Scenes:", scenes.length, "| Size:", width + "x" + height);

    await fsp.mkdir(workDir, { recursive: true });

    // Download images
    console.log("[VIDEO] Downloading images...");
    const imagePaths = [];

    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      if (!s.url) continue;

      const imgPath = path.join(workDir, `scene${String(i).padStart(2, "0")}.jpg`);

      try {
        const r = await fetch(s.url, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) {
          console.warn(`[VIDEO] Scene ${i} fetch failed:`, r.status);
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        await fsp.writeFile(imgPath, buf);

        imagePaths.push({
          path: imgPath,
          duration: Math.max(4, Math.min(15, Number(s.duration) || 8)),
          caption: (s.caption || "").trim(),
        });
        console.log(`[VIDEO] Image ${i + 1}/${scenes.length} → ${Math.round(buf.length / 1024)} KB`);
      } catch (e) {
        console.warn(`[VIDEO] Scene ${i} error:`, e.message);
      }
    }

    if (imagePaths.length === 0) {
      throw new Error("No valid images could be downloaded");
    }

    // Build filter_complex with zoompan (Ken Burns) + fade + optional caption
    const filterParts = [];

    for (let i = 0; i < imagePaths.length; i++) {
      const img = imagePaths[i];
      const dur = img.duration;
      const fps = 30;
      const frames = Math.round(dur * fps);

      // Zoompan: alternate zoom-in / zoom-out per scene for variety
      // Scene 0: zoom in, Scene 1: zoom out, Scene 2: zoom in, ...
      const zoomDirection = i % 2 === 0 ? "in" : "out";
      let zoomExpr;
      if (zoomDirection === "in") {
        zoomExpr = "min(1+0.0009*on,1.18)";
      } else {
        zoomExpr = "max(1.18-0.0009*on,1)";
      }

      // Pan expression based on scene index for variety
      const panModes = ["center", "left-to-right", "right-to-left", "top-down"];
      const panMode = panModes[i % panModes.length];

      let xExpr, yExpr;
      if (panMode === "left-to-right") {
        xExpr = "(iw-iw/zoom)*on/" + frames;
        yExpr = "ih/2-(ih/zoom/2)";
      } else if (panMode === "right-to-left") {
        xExpr = "(iw-iw/zoom)*(1-on/" + frames + ")";
        yExpr = "ih/2-(ih/zoom/2)";
      } else if (panMode === "top-down") {
        xExpr = "iw/2-(iw/zoom/2)";
        yExpr = "(ih-ih/zoom)*on/" + frames;
      } else {
        xExpr = "iw/2-(iw/zoom/2)";
        yExpr = "ih/2-(ih/zoom/2)";
      }

      // Base filters: scale → zoompan → fade in/out → format
      let chain =
        `[${i}:v]` +
        `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,` +
        `crop=${width * 2}:${height * 2},` +
        `zoompan=z='${zoomExpr}':` +
        `x='${xExpr}':y='${yExpr}':` +
        `d=${frames}:` +
        `s=${width}x${height}:fps=${fps},` +
        `setsar=1,` +
        `fade=t=in:st=0:d=0.6,` +
        `fade=t=out:st=${(dur - 0.6).toFixed(2)}:d=0.6`;

      // Optional caption overlay (drawtext)
      if (img.caption) {
        const escaped = img.caption
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/:/g, "\\:")
          .replace(/[\[\]]/g, "");
        // Simple bottom-center caption
        chain +=
          `,drawtext=text='${escaped}':` +
          `fontcolor=white:fontsize=${Math.round(width / 22)}:` +
          `box=1:boxcolor=black@0.55:boxborderw=20:` +
          `x=(w-text_w)/2:y=h-text_h-60:` +
          `fontfile='C\\:/Windows/Fonts/arial.ttf'`;
      }

      chain += `,format=yuv420p[v${i}]`;
      filterParts.push(chain);
    }

    // Concat all filtered scenes
    const concatInputs = imagePaths.map((_, i) => `[v${i}]`).join("");
    filterParts.push(
      `${concatInputs}concat=n=${imagePaths.length}:v=1:a=0[outv]`
    );

    const filterComplex = filterParts.join(";");
    const outputPath = path.join(workDir, "output.mp4");

    console.log("[VIDEO] Encoding with Ken Burns + fades...");

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();

      imagePaths.forEach((img) => {
        cmd.input(img.path).inputOptions(["-loop 1", `-t ${img.duration}`]);
      });

      cmd
        .complexFilter(filterComplex)
        .outputOptions([
          "-map", "[outv]",
          "-r", "30",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "25",
          "-movflags", "+faststart",
          "-pix_fmt", "yuv420p",
        ])
        .output(outputPath)
        .on("start", () => console.log("[VIDEO] FFmpeg start"))
        .on("stderr", (line) => {
          if (line && (line.includes("Error") || line.includes("failed"))) {
            console.log("[FFMPEG]", line);
          }
        })
        .on("progress", (p) => {
          if (p.percent && Math.round(p.percent) % 20 === 0) {
            console.log(`[VIDEO] Progress: ${p.percent.toFixed(1)}%`);
          }
        })
        .on("end", () => {
          console.log("[VIDEO] Encoding done ✓");
          resolve();
        })
        .on("error", (err) => {
          console.error("[VIDEO] FFmpeg error:", err.message);
          reject(err);
        })
        .run();
    });

    const videoBuf = await fsp.readFile(outputPath);
    console.log("[VIDEO] Video size:", Math.round(videoBuf.length / 1024), "KB");

    const safeTitle = (typeof title === "string" ? title : "video")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "video";

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.mp4"`);
    res.setHeader("Content-Length", videoBuf.length);
    res.send(videoBuf);

    console.log("[VIDEO] Sent ✓");

    setTimeout(() => {
      fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }, 5000);
  } catch (err) {
    console.error("[VIDEO] Error:", err.message);
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Video build failed" });
    }
  }
});

/* -------------------- Boot -------------------- */
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`\n🦡 Badger running on http://localhost:${PORT}\n`);
  });
}

export default app;