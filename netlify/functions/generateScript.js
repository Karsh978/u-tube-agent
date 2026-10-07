const { GoogleGenerativeAI } = require("@google/generative-ai");

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { topic } = JSON.parse(event.body);

    if (!topic) {
      return { statusCode: 400, body: JSON.stringify({ error: "Topic is required" }) };
    }

    // Gemini API Initialize karo (Environment variable se key lega)
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

   const prompt = `You are an expert YouTube Content Strategist. For the topic "${topic}", generate a high-converting YouTube video blueprint. Return ONLY a valid JSON object with this exact structure:
{
  "title": "A high-CTR click-worthy title (use current year, numbers, or curiosity hooks)",
  "description": "Comprehensive description with timestamps, links, hashtags, and CTA",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "scriptOutline": [
    "0:00 - Hook & Intro (Problem statement)",
    "1:00 - Setup & Architecture",
    "3:00 - Core Implementation",
    "8:00 - Pro Tips & Pitfalls",
    "10:00 - Outro & Call to Action"
  ],
  "thumbnailIdeas": [
    "Idea 1: Split screen showing before vs after code",
    "Idea 2: Clean MERN logos with glowing text"
  ]
}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // Clean JSON response
    const cleanJson = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    const data = JSON.parse(cleanJson);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, data }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};