// test.js
require('dotenv').config(); // agar dotenv installed hai
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function testGemini() {
  const apiKey = process.env.GEMINI_API_KEY || "YOUR_TEST_API_KEY";
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  console.log("Testing Gemini API connection...");
  try {
    const result = await model.generateContent("Give a 1-sentence YouTube video idea about MERN Stack.");
    console.log("\nSuccess! Output:\n", result.response.text());
  } catch (err) {
    console.error("API Error:", err.message);
  }
}

testGemini();