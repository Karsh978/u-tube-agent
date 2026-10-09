import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "netlify", "public")));

// Universal AI Plan Generation Endpoint with Dynamic Key Swapping
app.post("/api/generatePlan", async (req, res) => {
  try {
    const { topic, provider, customKey, model } = req.body;

    if (!topic) return res.status(400).json({ error: "Topic is required" });

    // Determine Provider (default to 'groq')
    const selectedProvider = (provider || req.headers["x-provider"] || "groq").toLowerCase();

    // Determine API Key (Client dynamic key takes priority over Server env key)
    const apiKey = (customKey || req.headers["x-api-key"] || 
                   (selectedProvider === "gemini" ? process.env.GEMINI_API_KEY : process.env.GROQ_API_KEY) || "").trim();

    if (!apiKey) {
      return res.status(400).json({ 
        error: `No API key provided for ${selectedProvider.toUpperCase()}. Pass it from Frontend UI or configure Environment Variables.` 
      });
    }

    const promptText = `You are an expert YouTube Creator. Generate a complete video strategy for topic: "${topic}". Return strict JSON with keys: "title", "description", "tags" (array of strings), "sceneByScenePrompts" (array of strings), and "script" (string). Output ONLY valid raw JSON without markdown code blocks.`;

    let generatedText = null;

    // --- PROVIDER 1: GROQ CLOUD ---
    if (selectedProvider === "groq") {
      // Direct Single Model Call to avoid deprecated model loops
      const targetModel = model || "llama-3.3-70b-versatile";

      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: targetModel,
            messages: [{ role: "user", content: promptText }],
            temperature: 0.7,
            response_format: { type: "json_object" }
          })
        });

        const data = await response.json();
        if (response.ok && data.choices?.[0]?.message?.content) {
          generatedText = data.choices[0].message.content;
          console.log(`[Groq Success] Model used: ${targetModel}`);
        } else {
          return res.status(502).json({ error: `Groq Error (${targetModel}): ${data.error?.message || "Model request failed"}` });
        }
      } catch (err) {
        return res.status(502).json({ error: `Groq Network Error: ${err.message}` });
      }
    } 

    // --- PROVIDER 2: GOOGLE GEMINI ---
    else if (selectedProvider === "gemini") {
      const targetModel = model || "gemini-1.5-flash";
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(502).json({ error: data.error?.message || "Gemini API Call Failed" });
      }

      generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    } else {
      return res.status(400).json({ error: "Unsupported AI Provider specified." });
    }

    // Clean JSON Response
    let cleanedText = generatedText.trim();
    if (cleanedText.startsWith("```")) {
      cleanedText = cleanedText.replace(/^```(json)?/i, "").replace(/```\$/, "").trim();
    }

    const parsedData = JSON.parse(cleanedText);
    return res.json({ success: true, provider: selectedProvider, data: parsedData });

  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

// Route Aliases
app.post("/api/generateScript", (req, res) => res.redirect(307, "/api/generatePlan"));
app.post("/api/generateWithGemini", (req, res) => res.redirect(307, "/api/generatePlan"));
app.post("/api/generate", (req, res) => res.redirect(307, "/api/generatePlan"));

// Static Fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "netlify", "public", "index.html"));
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));