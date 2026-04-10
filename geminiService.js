// ============================================================
// Gemini AI Service
// ============================================================
"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const apiKey = process.env.GEMINI_API_KEY;
let genAI = null;

if (!apiKey || apiKey === "your_gemini_api_key_here") {
  console.warn("⚠️  GEMINI_API_KEY not set — Gemini features disabled.");
} else {
  genAI = new GoogleGenerativeAI(apiKey);
  console.log("Gemini API Key loaded ✅");
}

/**
 * Get a response from Google Gemini.
 * @param {string} userMessage
 * @param {Array}  history     [{role, parts: [{text}]}]
 * @param {Array}  files       [{mimeType, data (base64)}]
 * @param {string|null} systemInstruction
 * @returns {Promise<string|null>}
 */
async function getGeminiResponse(userMessage, history = [], files = [], systemInstruction = null) {
  if (!genAI) {
    console.error("Gemini: no API client (missing or placeholder GEMINI_API_KEY)");
    return null;
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: systemInstruction ||
        "You are Lumina AI's expert Academic Strategist. Provide insightful, clear analysis.",
    });

    // Build content parts
    const contentParts = [{ text: userMessage }];
    for (const f of files) {
      if (f.data && f.mimeType) {
        contentParts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
      }
    }

    // Sanitise history (Gemini needs 'user' / 'model' roles only)
    const geminiHistory = history
      .filter(h => h.parts && h.parts.length > 0 && h.parts[0].text)
      .map(h => ({
        role:  h.role === "model" ? "model" : "user",
        parts: [{ text: h.parts[0].text }],
      }));

    const chat   = model.startChat({ history: geminiHistory, generationConfig: { maxOutputTokens: 4096 } });
    const result = await chat.sendMessage(contentParts);
    const text   = result.response.text();

    console.log("✅ Gemini response OK");
    return text;
  } catch (e) {
    console.error("Gemini error:", e.message);
    return `⚠️ Gemini service error: ${e.message}`;
  }
}

module.exports = { getGeminiResponse };
