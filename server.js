require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());

// 1. API Isolated Router
const apiRouter = express.Router();

apiRouter.get("/health", (req, res) => {
  return res.json({ 
    status: "OK", 
    hasApiKey: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }]
      })
    });

    const apiData = await response.json();

    if (!response.ok) {
      console.error("Gemini API Error:", apiData);
      return res.status(response.status).json({ 
        error: apiData.error?.message || "Gemini API returned an error." 
      });
    }

    let rawText = apiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
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

apiRouter.post("/generateWithGemini", handleGeminiRequest);
apiRouter.post("/generate", handleGeminiRequest);

// Mount API routes
app.use("/api", apiRouter);

// 2. Serve Static Frontend
const publicPath = path.join(__dirname, "netlify", "public");
app.use(express.static(publicPath));

// 3. Express 5 / Node 24 Compatible Fallback Catch-All
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "API route not found" });
  }
  
  res.sendFile(path.join(publicPath, "index.html"), (err) => {
    if (err) {
      res.status(404).send("Index HTML file not found");
    }
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;