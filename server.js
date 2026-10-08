import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "netlify", "public")));

// Strategy Generator using Active Groq Models (2026 Updated)
app.post("/api/generatePlan", async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic is required" });

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return res.status(500).json({ error: "GROQ_API_KEY missing in environment variables." });
    }

    const promptText = `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with keys: "title", "description", "tags" (array of strings), "sceneByScenePrompts" (array of strings), and "script" (string). Output ONLY valid raw JSON without markdown code blocks.`;

    // Active supported Groq models
    const groqModels = [
      "llama-3.1-8b-instant",
      "llama-3.3-70b-versatile",
      "llama-3.1-70b-versatile"
    ];

    let generatedText = null;
    let lastError = null;

    for (const model of groqModels) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: promptText }],
            temperature: 0.7,
            response_format: { type: "json_object" }
          })
        });

        const data = await response.json();
        if (response.ok && data.choices?.[0]?.message?.content) {
          generatedText = data.choices[0].message.content;
          console.log(`Successfully generated using Groq model: ${model}`);
          break;
        } else {
          console.warn(`Groq model ${model} failed:`, data.error?.message || "Unknown error");
          lastError = data.error?.message;
        }
      } catch (err) {
        console.warn(`Fetch error on Groq model ${model}:`, err.message);
        lastError = err.message;
      }
    }

    if (!generatedText) {
      return res.status(503).json({ error: lastError || "Failed to generate strategy with Groq models." });
    }

    let cleanedText = generatedText.trim();
    if (cleanedText.startsWith("```")) {
      cleanedText = cleanedText.replace(/^```(json)?/i, "").replace(/```\$/, "").trim();
    }

    const data = JSON.parse(cleanedText);
    return res.json({ success: true, data });

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: error.message || "Failed to process request." });
  }
});

// Route Aliases
app.post("/api/generateScript", (req, res) => res.redirect(307, "/api/generatePlan"));
app.post("/api/generateWithGemini", (req, res) => res.redirect(307, "/api/generatePlan"));
app.post("/api/generate", (req, res) => res.redirect(307, "/api/generatePlan"));

// Safe Fallback Middleware for Static Frontend
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "netlify", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});