import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "netlify", "public")));

// 1. Text & Strategy Generation Endpoint (Groq + Gemini Fallback)
app.post("/api/generatePlan", async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic is required" });

    const promptText = `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with keys: "title", "description", "tags" (array), "scenePrompts" (array of short 1-sentence visual descriptions for video generation), and "script". Output ONLY valid raw JSON.`;

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return res.status(500).json({ error: "GROQ_API_KEY is missing." });
    }

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${groqKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: promptText }],
        response_format: { type: "json_object" }
      })
    });

    const groqData = await groqRes.json();
    if (!groqRes.ok) throw new Error(groqData.error?.message || "Groq Error");

    const data = JSON.parse(groqData.choices[0].message.content);
    return res.json({ success: true, data });

  } catch (err) {
    console.error("Strategy Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/generateVideo", async (req, res) => {
  try {
    const { prompt } = req.body;
    const hfToken = process.env.HF_TOKEN;

    if (!hfToken) {
      return res.status(500).json({ error: "HF_TOKEN missing in environment variables." });
    }

    // Hugging Face Router / Inference API call
    const response = await fetch("https://router.huggingface.co/hf-inference/models/ZhengmingYu/DMAD", {
      headers: {
        Authorization: `Bearer ${hfToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({ inputs: prompt }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      return res.status(500).json({ error: `HuggingFace API Error: ${errorData}` });
    }

    // Generated video file buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Front-end ko MP4/Media format me return karna
    res.setHeader("Content-Type", "video/mp4");
    return res.send(buffer);

  } catch (error) {
    console.error("Video Generation Error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Route Alias
app.post("/api/generateScript", (req, res) => res.redirect(307, "/api/generatePlan"));
app.post("/api/generateWithGemini", (req, res) => res.redirect(307, "/api/generatePlan"));

// Static Frontend Catch-all
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "netlify", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});