require("dotenv").config();
const express = require("express");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json());

// Initialize Gemini Client safely
const apiKey = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey });

app.use(express.static(path.join(__dirname, "netlify", "public")));

const handleGeminiRequest = async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ 
        error: "GEMINI_API_KEY environment variable is missing in Render/Vercel settings." 
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with title, description, tags, sceneByScenePrompts (for video generation), and script.`,
      config: { responseMimeType: "application/json" }
    });

    const textResponse = response.text;
    const data = JSON.parse(textResponse);
    
    return res.json({ success: true, data });
  } catch (error) {
    console.error("Gemini Route Error:", error);
    return res.status(500).json({ 
      error: error.message || "Failed to generate video strategy from Gemini API." 
    });
  }
};

// Supporting both endpoints so frontend won't break
app.post("/api/generateWithGemini", handleGeminiRequest);
app.post("/api/generate", handleGeminiRequest);

// Dynamic PORT
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;