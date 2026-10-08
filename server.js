import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const handleGeminiRequest = async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic is required" });

    const promptText = `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with keys: title, description, tags (array), sceneByScenePrompts (array), and script. Output ONLY valid raw JSON without markdown blocks.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: promptText,
    });

    let rawText = response.text || "";
    rawText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

    const data = JSON.parse(rawText);
    return res.json({ success: true, data });
  } catch (error) {
    console.error("Gemini SDK Error:", error);
    return res.status(500).json({ error: error.message || "Failed to generate content." });
  }
};