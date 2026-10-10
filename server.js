import "dotenv/config";
import express from "express";
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

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
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

/* -------------------- Prompt builder (15 scenes, time-targeted) -------------------- */
function buildPrompts(topic, targetMinutes = 1.5) {
  const now = new Date();
  const today = now.toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  const year = now.getFullYear();
  const targetSeconds = Math.round(targetMinutes * 60);

  const system = `You are an expert YouTube Content Strategist. Today's date is ${today}. Apply YouTube best practices as of ${year}. Respond with one strict, valid JSON object only: no markdown, no code fences, no commentary.`;

  const user = `Create a complete YouTube video blueprint for this topic: "${topic}"

TARGET: The video should be around ${targetSeconds} seconds total (about ${targetMinutes} minutes).

TITLE: 40-60 characters, keyword near start, honest.

DESCRIPTION: Hook + keyword in first 2 lines. Summary, chapters, CTA. End with 3 hashtags.

TAGS: 8-12 tags. Under 400 chars total.

SCRIPT OUTLINE:
- Each item is "M:SS - Section title: one-line summary".
- EXACTLY 15 sections. No more, no less.
- Total script length suited for ${targetSeconds} seconds of video.
- Start with "0:00" hook (5-15 sec payoff).
- End with CTA to next video.

THUMBNAIL IDEAS: Exactly 3 concepts.

SCENE-BY-SCENE VISUAL PROMPTS:
- EXACTLY 15 prompts. One per section.
- Format: "A [shot type] of [subject] in [setting], [lighting], [mood], [style]"
- Vary shot types and lighting across scenes.
- Each scene "duration" should be around ${Math.round(targetSeconds / 15)} seconds.
- "scene" matches timestamp. "caption": max 6 words for subtitle.

Return ONLY this JSON:
{
  "title": "string",
  "description": "string",
  "tags": ["string"],
  "scriptOutline": ["string"],
  "thumbnailIdeas": [{"text": "string", "visual": "string"}],
  "sceneByScenePrompts": [{"scene": "string", "prompt": "string", "duration": 6, "caption": "string"}]
}`;

  return { system, user };
}

/* -------------------- Parse & normalize -------------------- */
function parseModelJson(raw) {
  if (!raw) throw new Error("Empty response");
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
    if (s === -1 || e <= s) throw new Error("Invalid JSON");
    return JSON.parse(cleaned.slice(s, e + 1));
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

function normalize(data, targetSeconds) {
  const tags = (Array.isArray(data.tags) ? data.tags : [])
    .map((t) => str(t).replace(/^#+/, "")).filter(Boolean);

  const safeTags = [];
  let total = 0;
  for (const t of tags) {
    if (total + t.length + 1 > 500) break;
    safeTags.push(t); total += t.length + 1;
  }

  const thumbnailIdeas = (Array.isArray(data.thumbnailIdeas) ? data.thumbnailIdeas : [])
    .map((x) => typeof x === "string" ? { text: "", visual: x.trim() }
      : { text: str(x?.text), visual: str(x?.visual) })
    .filter((x) => x.text || x.visual).slice(0, 3);

  const sceneByScenePrompts = (Array.isArray(data.sceneByScenePrompts)
    ? data.sceneByScenePrompts : []
  ).map((s) => ({
    scene: str(s?.scene),
    prompt: str(s?.prompt),
    caption: str(s?.caption),
    duration: Number.isFinite(s?.duration) ? Number(s.duration) : 6,
  })).filter((s) => s.prompt);

  // ⚙️ Enforce 15 scenes exactly — pad or trim
  while (sceneByScenePrompts.length < 15) {
    const idx = sceneByScenePrompts.length;
    sceneByScenePrompts.push({
      scene: `Scene ${idx + 1}`,
      prompt: `A cinematic shot related to the topic, scene ${idx + 1}, varied lighting and mood, ultra-realistic`,
      caption: "",
      duration: 6,
    });
  }
  const trimmed = sceneByScenePrompts.slice(0, 15);

  // ⚙️ Scale durations so total ~ targetSeconds
  const sumDur = trimmed.reduce((a, b) => a + b.duration, 0) || 1;
  const scale = targetSeconds / sumDur;
  trimmed.forEach((s) => {
    s.duration = Math.max(3, Math.min(15, Math.round(s.duration * scale * 10) / 10));
  });

  const result = {
    title: str(data.title).slice(0, 100),
    description: str(data.description),
    tags: safeTags,
    scriptOutline: (Array.isArray(data.scriptOutline) ? data.scriptOutline : [])
      .map(str).filter(Boolean),
    thumbnailIdeas,
    sceneByScenePrompts: trimmed,
  };

  if (!result.title || !result.scriptOutline.length) {
    throw new Error("Missing required fields");
  }
  return result;
}

/* -------------------- Provider calls -------------------- */
async function callGroq({ system, user, apiKey }) {
  const { default: Groq } = await import("groq-sdk");
  const client = new Groq({ apiKey });
  const completion = await client.chat.completions.create({
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    model: GROQ_MODEL, temperature: 0.7,
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
    const err = new Error(json?.error?.message || `Gemini failed (${response.status})`);
    err.status = response.status; throw err;
  }
  return (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

const CALLERS = { groq: callGroq, gemini: callGemini };

/* -------------------- /api/generatePlan -------------------- */
async function generatePlan(req, res) {
  try {
    const body = req.body || {};
    const topic = str(body.topic);
    if (!topic) return res.status(400).json({ error: "Topic is required" });
    if (topic.length > 200) return res.status(400).json({ error: "Topic too long" });

    const targetMinutes = Math.max(0.5, Math.min(5, Number(body.targetMinutes) || 1.5));
    const targetSeconds = Math.round(targetMinutes * 60);

    const provider = (body.provider || "groq").toLowerCase();
    if (!PROVIDERS[provider]) return res.status(400).json({ error: "Unsupported provider" });

    const customKey = str(body.customKey);
    const { label, envKey } = PROVIDERS[provider];
    const apiKey = customKey || process.env[envKey];
    if (!apiKey) return res.status(400).json({ error: `No ${label} API key found.` });

    const { system, user } = buildPrompts(topic, targetMinutes);
    const raw = await CALLERS[provider]({ system, user, apiKey });
    const data = normalize(parseModelJson(raw), targetSeconds);

    const totalDur = data.sceneByScenePrompts.reduce((a, b) => a + b.duration, 0);
    console.log(`[PLAN] ${data.sceneByScenePrompts.length} scenes | Total ≈ ${Math.round(totalDur)}s (target ${targetSeconds}s)`);

    res.json({ success: true, provider, data, totalDuration: totalDur });
  } catch (error) {
    console.error("Generation error:", error.message);
    const msg = error.message || "Failed to generate";
    const badKey = error.status === 401 || error.status === 403;
    res.status(badKey ? 401 : 500).json({ error: badKey ? "API key rejected." : msg });
  }
}

app.post("/api/generatePlan", generatePlan);
app.post("/api/generateScript", generatePlan);

/* ==================== MEDIA HELPERS ==================== */
function buildPicsumUrl(seed, width, height) {
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

async function hfTextToImage({ prompt, apiKey, model = "black-forest-labs/FLUX.1-schnell" }) {
  const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: prompt }),
  });
  if (!res.ok) throw new Error(`HF image failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

function aspectDims(aspect) {
  if (aspect === "9:16") return { width: 720, height: 1280 };
  if (aspect === "1:1") return { width: 1024, height: 1024 };
  return { width: 1280, height: 720 };
}

/* ==================== /api/generateMedia ==================== */
app.post("/api/generateMedia", async (req, res) => {
  try {
    const { prompts, aspect = "16:9", engine = "auto" } = req.body || {};
    if (!Array.isArray(prompts) || !prompts.length) {
      return res.status(400).json({ error: "prompts[] required" });
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

      if (hfKey && (engine === "auto" || engine === "huggingface")) {
        try {
          imageUrl = await hfTextToImage({ prompt, apiKey: hfKey });
        } catch (e) {
          console.warn(`HF failed scene ${i + 1}:`, e.message);
        }
      }

      if (!imageUrl) {
        const seed = Math.floor(Math.random() * 1000000);
        imageUrl = buildPicsumUrl(seed, dims.width, dims.height);
      }

      assets.push({ scene, prompt, caption, type: "image", url: imageUrl });
      if (hfKey && engine !== "pollinations") await new Promise((r) => setTimeout(r, 400));
    }

    res.json({ success: true, engine, count: assets.length, assets });
  } catch (err) {
    console.error("Media error:", err.message);
    res.status(500).json({ error: err.message || "Media generation failed" });
  }
});

/* ==================== /api/downloadZip ==================== */
app.post("/api/downloadZip", async (req, res) => {
  try {
    const { plan, aspect = "16:9" } = req.body || {};
    if (!plan || typeof plan !== "object") {
      return res.status(400).json({ error: "plan required" });
    }

    const dims = aspectDims(aspect);
    const scenes = Array.isArray(plan.sceneByScenePrompts) ? plan.sceneByScenePrompts : [];
    if (!scenes.length) return res.status(400).json({ error: "No scenes" });

    const zipBase = (str(plan.title) || "badger-plan")
      .replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60).toLowerCase() || "badger-plan";

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipBase}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("[ZIP] error:", err.message);
      if (!res.headersSent) res.status(500).end(); else res.end();
    });
    archive.pipe(res);

    archive.append(JSON.stringify(plan, null, 2), { name: "plan.json" });

    const scriptTxt = [
      `TITLE: ${plan.title || ""}`,
      "", `DESCRIPTION:`, plan.description || "",
      "", `TAGS: ${(plan.tags || []).map((t) => "#" + t).join(" ")}`,
      "", `SCRIPT OUTLINE:`,
      (plan.scriptOutline || []).map((s, i) => `${i + 1}. ${s}`).join("\n"),
      "", `SCENE PROMPTS:`,
      scenes.map((s) => `[${s.scene}] (${s.duration || 6}s) ${s.prompt}`).join("\n"),
    ].join("\n");
    archive.append(scriptTxt, { name: "script.txt" });

    const hfKey = process.env.HF_API_KEY;
    const results = await Promise.all(scenes.map(async (s, i) => {
      if (!s.prompt) return null;
      let buf = null;

      if (hfKey) {
        try {
          const url = await hfTextToImage({ prompt: s.prompt, apiKey: hfKey });
          buf = Buffer.from(url.split(",")[1], "base64");
        } catch (e) { console.warn("[ZIP] HF failed:", e.message); }
      }

      if (!buf) {
        const seed = Math.floor(Math.random() * 1000000);
        try {
          const r = await fetch(buildPicsumUrl(seed, dims.width, dims.height), {
            signal: AbortSignal.timeout(60000),
          });
          if (r.ok) buf = Buffer.from(await r.arrayBuffer());
        } catch (e) { console.warn("[ZIP] Picsum failed:", e.message); }
      }

      if (!buf) return null;

      const sceneTag = String(s.scene || `scene-${i + 1}`)
        .replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || `scene-${i + 1}`;
      return { fname: `scenes/${String(i + 1).padStart(2, "0")}-${sceneTag}.jpg`, buf };
    }));

    let imgCount = 0;
    for (const r of results) {
      if (r) { archive.append(r.buf, { name: r.fname }); imgCount++; }
    }

    archive.append(
      `Badger — AI Video Studio\nGenerated: ${new Date().toISOString()}\nTitle: ${plan.title || ""}\nScenes: ${scenes.length}\nImages: ${imgCount}`,
      { name: "README.txt" }
    );

    await archive.finalize();
    console.log("[ZIP] Done ✓");
  } catch (err) {
    console.error("[ZIP] error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message }); else res.end();
  }
});

/* ==================== VOICEOVER (msedge-tts) ==================== */
async function generateVoiceover({ text, outPath, voice = "en-US-AriaNeural" }) {
  console.log("[VOICE] Generating:", voice, "| text length:", text.length);

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const { audioStream } = tts.toStream(text.slice(0, 2000));

  const chunks = [];
  const audio = await new Promise((resolve, reject) => {
    audioStream.on("data", (c) => chunks.push(c));
    audioStream.on("end", () => resolve(Buffer.concat(chunks)));
    audioStream.on("error", reject);
    setTimeout(() => reject(new Error("TTS timeout after 30s")), 30000);
  });

  if (!audio || audio.length < 100) {
    throw new Error("TTS returned empty audio");
  }

  await fsp.writeFile(outPath, audio);
  console.log("[VOICE] Saved:", Math.round(audio.length / 1024), "KB");
  return outPath;
}

/* ==================== /api/buildVideo ==================== */
app.post("/api/buildVideo", async (req, res) => {
  console.log("[VIDEO] Request received");
  const workDir = path.join(os.tmpdir(),
    `badger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  try {
    const {
      scenes, aspect = "16:9", title = "video",
      voiceover = true, voice = "en-US-AriaNeural",
    } = req.body || {};

    if (!Array.isArray(scenes) || !scenes.length) {
      return res.status(400).json({ error: "scenes[] required" });
    }
    if (scenes.length > 25) return res.status(400).json({ error: "Max 25 scenes" });

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
        if (!r.ok) { console.warn(`Scene ${i} fetch failed:`, r.status); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        await fsp.writeFile(imgPath, buf);
        const dur = Math.max(3, Math.min(15, Number(s.duration) || 6));
        imagePaths.push({
          path: imgPath,
          duration: dur,
          caption: str(s.caption),
        });
        console.log(`Image ${i + 1}/${scenes.length} → ${Math.round(buf.length / 1024)} KB (dur: ${dur}s)`);
      } catch (e) {
        console.warn(`Scene ${i} error:`, e.message);
      }
    }

    if (imagePaths.length === 0) throw new Error("No valid images");

    // Build concat.txt
    const concatPath = path.join(workDir, "concat.txt");
    let concatContent = "";
    for (const img of imagePaths) {
      const absPath = img.path.replace(/\\/g, "/");
      concatContent += `file '${absPath}'\n`;
      concatContent += `duration ${img.duration}\n`;
    }
    const lastImg = imagePaths[imagePaths.length - 1].path.replace(/\\/g, "/");
    concatContent += `file '${lastImg}'\n`;

    await fsp.writeFile(concatPath, concatContent, "utf8");

    const totalDur = imagePaths.reduce((a, b) => a + b.duration, 0);
    console.log("[VIDEO] Concat ready | Total video duration:", Math.round(totalDur), "s");

    const outputPath = path.join(workDir, "video-no-audio.mp4");

    console.log("[VIDEO] Encoding with FFmpeg...");

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions([
          `-vf`, `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x0B0D12,eq=contrast=1.08:saturation=1.15,format=yuv420p`,
          "-r", "30",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "26",
          "-movflags", "+faststart",
          "-pix_fmt", "yuv420p",
        ])
        .output(outputPath)
        .on("start", () => console.log("[VIDEO] FFmpeg started"))
        .on("stderr", (line) => {
          if (line && (line.includes("Error") || line.includes("failed"))) {
            console.log("[FFMPEG]", line);
          }
        })
        .on("progress", (p) => {
          if (p.percent && Math.round(p.percent) % 25 === 0) {
            console.log(`[VIDEO] Progress: ${p.percent.toFixed(1)}%`);
          }
        })
        .on("end", () => { console.log("[VIDEO] Video encoded ✓"); resolve(); })
        .on("error", (err) => { console.error("[VIDEO] FFmpeg error:", err.message); reject(err); })
        .run();
    });

    // Voiceover + merge
    let finalPath = outputPath;

    if (voiceover) {
      try {
        // Use full prompt + caption for longer audio
        const voScript = scenes
          .map((s) => {
            const c = str(s.caption);
            const p = str(s.prompt);
            return c ? `${c}. ${p}` : p;
          })
          .filter(Boolean)
          .join(". ");

        if (voScript.length > 5) {
          console.log("[VOICE] Voiceover requested, script length:", voScript.length);
          const audioPath = path.join(workDir, "voiceover.mp3");

          const voiceoverPromise = generateVoiceover({
            text: voScript,
            outPath: audioPath,
            voice,
          });

          const voiceoverTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Voiceover total timeout 40s")), 40000)
          );

          try {
            await Promise.race([voiceoverPromise, voiceoverTimeout]);
            console.log("[VOICE] Audio ready");

            const mergedPath = path.join(workDir, "video-final.mp4");
            console.log("[VIDEO] Merging audio + video...");

            await new Promise((resolve) => {
              ffmpeg()
                .input(outputPath)
                .input(audioPath)
                .outputOptions([
                  "-c:v", "copy",
                  "-c:a", "aac",
                  "-b:a", "128k",
                  "-map", "0:v:0",
                  "-map", "1:a:0",
                  "-movflags", "+faststart",
                ])
                .output(mergedPath)
                .on("end", () => { console.log("[VIDEO] Audio merged ✓"); resolve(); })
                .on("error", (err) => {
                  console.error("[VIDEO] Merge error:", err.message);
                  resolve();
                })
                .run();
            });

            if (fs.existsSync(mergedPath)) {
              finalPath = mergedPath;
            }
          } catch (voiceErr) {
            console.warn("[VOICE] Failed — using silent video:", voiceErr.message);
          }
        }
      } catch (e) {
        console.warn("[VIDEO] Voiceover failed:", e.message);
      }
    }

    const videoBuf = await fsp.readFile(finalPath);
    console.log("[VIDEO] Final size:", Math.round(videoBuf.length / 1024), "KB");

    const safeTitle = (str(title) || "video")
      .replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "")
      .slice(0, 60).toLowerCase() || "video";

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
    if (!res.headersSent) res.status(500).json({ error: err.message || "Video build failed" });
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