require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

async function checkModels() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });
    const result = await model.generateContent("Hello!");
    console.log("✅ Success! Gemini Response:", result.response.text());
  } catch (err) {
    console.error("❌ Error Details:", err.message);
  }
}

checkModels();