require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, "netlify", "public")));

const handleGeminiRequest = async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing in environment variables!");
      return res.status(500).json({ 
        error: "GEMINI_API_KEY missing. Please add GEMINI_API_KEY in Render Environment settings." 
      });
    }

    const promptText = `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with keys: title, description, tags (array), sceneByScenePrompts (array), and script. Do not add markdown formatting or extra text. Output ONLY valid raw JSON.`;

    // Direct Gemini REST API Call (Reliable & No SDK version bugs)
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
      console.error("Gemini API Error Response:", apiData);
      return res.status(response.status).json({ 
        error: apiData.error?.message || "Gemini API returned an error." 
      });
    }

    // Extract text output from Gemini response
    let rawText = apiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    // Clean up codeblock markers ```json ... ``` if model wraps them
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

// Handle both API routes
app.post("/api/generateWithGemini", handleGeminiRequest);
app.post("/api/generate", handleGeminiRequest);

// Health check endpoint to verify server status
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", hasApiKey: !!process.env.GEMINI_API_KEY });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;