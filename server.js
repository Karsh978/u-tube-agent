import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static assets from netlify/public
app.use(express.static(path.join(__dirname, "netlify", "public")));

// Gemini Generation Handler with active model fallbacks
const handleGeminiRequest = async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY missing in environment variables!");
      return res.status(500).json({ 
        error: "GEMINI_API_KEY missing in Render environment variables." 
      });
    }

    const promptText = `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with keys: title, description, tags (array), sceneByScenePrompts (array), and script. Output ONLY valid raw JSON without markdown blocks.`;

    const models = [
      "gemini-2.5-flash",
      "gemini-3.1-pro-preview"
    ];

    let apiData = null;
    let lastError = null;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }]
          })
        });

        const data = await response.json();

        if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          apiData = data;
          console.log(`Successfully generated using model: ${model}`);
          break;
        } else {
          console.warn(`Model ${model} failed:`, data.error?.message || "Invalid response");
          lastError = data.error?.message || "Model request failed";
        }
      } catch (err) {
        console.warn(`Fetch error on model ${model}:`, err.message);
        lastError = err.message;
      }
    }

    if (!apiData) {
      return res.status(503).json({ 
        error: lastError || "All Gemini models are busy. Please try again later." 
      });
    }

    let rawText = apiData.candidates[0].content.parts[0].text;
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

    const data = JSON.parse(rawText);
    return res.json({ success: true, data });

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ 
      error: error.message || "Failed to process request on server." 
    });
  }
};

// Route Registration
app.post("/api/generateScript", handleGeminiRequest);
app.post("/api/generateWithGemini", handleGeminiRequest);
app.post("/api/generate", handleGeminiRequest);
app.post("/api/generatePlan", handleGeminiRequest);

// Catch-all route to render netlify/public/index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "netlify", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});