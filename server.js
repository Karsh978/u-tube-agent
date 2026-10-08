require("dotenv").config();
const express = require("express");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json());

// Fallback to prevent crash if key is missing on startup
const apiKey = process.env.GEMINI_API_KEY || "DUMMY_KEY";
const ai = new GoogleGenAI({ apiKey });

app.use(express.static(path.join(__dirname, "netlify", "public")));

app.post("/api/generateWithGemini", async (req, res) => {
  try {
    const { topic } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is missing in environment variables." });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with title, description, tags, sceneByScenePrompts (for video generation), and script.`,
      config: { responseMimeType: "application/json" }
    });

    const data = JSON.parse(response.text);
    res.json({ success: true, data });
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Dynamic PORT setup for Render / Vercel / Local
const PORT = process.env.PORT || 5000;

// Listen on 0.0.0.0 so Render can route traffic
if (process.env.NODE_ENV !== "production" || process.env.RENDER) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

module.exports = app;