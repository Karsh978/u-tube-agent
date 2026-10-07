require("dotenv").config();
const express = require("express");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json());

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.static(path.join(__dirname, "netlify", "public")));

app.post("/api/generateWithGemini", async (req, res) => {
  try {
    const { topic } = req.body;
    
    // Using gemini-2.5-flash model for fast & rich responses
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