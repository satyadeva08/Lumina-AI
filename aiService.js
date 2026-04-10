// ============================================================
// Groq AI Service (via OpenAI-compatible SDK)
// ============================================================
"use strict";

const OpenAI = require("openai");
const path   = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const apiKey = process.env.GROQ_API_KEY;
let client = null;

if (!apiKey || apiKey === "your_groq_api_key_here") {
  console.warn("⚠️  GROQ_API_KEY not set — Groq AI features disabled.");
} else {
  client = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  console.log("Groq API Key loaded ✅");
}

// ── Per-user rate limiter ─────────────────────────────────────────────────────
const RATE_LIMIT    = 30;          // requests
const RATE_WINDOW   = 60 * 1000;  // per 60 s
const userTimestamps = new Map();  // userId → timestamp[]

function isRateLimited(userId = "global") {
  const now  = Date.now();
  const list = (userTimestamps.get(userId) || []).filter(t => t > now - RATE_WINDOW);
  userTimestamps.set(userId, list);
  return list.length >= RATE_LIMIT;
}

function recordRequest(userId = "global") {
  const list = userTimestamps.get(userId) || [];
  list.push(Date.now());
  userTimestamps.set(userId, list);
}

function waitSeconds(userId = "global") {
  const list = userTimestamps.get(userId) || [];
  if (list.length === 0) return 0;
  return Math.max(0, Math.ceil((list[0] + RATE_WINDOW - Date.now()) / 1000));
}

// ── Models ────────────────────────────────────────────────────────────────────
const MODEL_VISION    = "meta-llama/llama-4-scout-17b-16e-instruct"; // llama-3.2-90b-vision-preview was decommissioned
const MODEL_TEXT      = "llama-3.3-70b-versatile";
const MODEL_FAST      = "llama-3.1-8b-instant";

// ── Main chat function ────────────────────────────────────────────────────────
/**
 * @param {string}      userMessage
 * @param {Array}       history          [{role, parts:[{text}]}]
 * @param {Array}       files            [{mimeType, data (base64)}]
 * @param {string|null} systemInstruction
 * @param {string}      [userId]         For per-user rate limiting
 */
async function getTutorResponse(userMessage, history = [], files = [], systemInstruction = null, userId = "global") {
  if (!client) return "⚠️ AI service is not configured. Please set GROQ_API_KEY in your .env file.";

  if (isRateLimited(userId)) {
    const wait = waitSeconds(userId);
    return `⏳ **Rate limit reached.** You've sent ${RATE_LIMIT} requests this minute. Please wait **${wait} seconds**.`;
  }

  const system = systemInstruction ||
    "You are Lumina AI's expert Academic Performance Strategist. Provide clear, concise, and highly actionable guidance.";

  const messages = [{ role: "system", content: system }];

  // Add history
  for (const h of history) {
    if (h.parts?.[0]?.text) {
      messages.push({
        role:    h.role === "model" ? "assistant" : "user",
        content: h.parts[0].text,
      });
    }
  }

  // Build current message
  const hasImages = files.some(f => f.mimeType?.startsWith("image/"));
  if (hasImages) {
    const parts = [{ type: "text", text: userMessage }];
    for (const f of files) {
      if (f.mimeType?.startsWith("image/") && f.data) {
        parts.push({ type: "image_url", image_url: { url: `data:${f.mimeType};base64,${f.data}` } });
      }
    }
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: userMessage });
  }

  const model = hasImages ? MODEL_VISION : MODEL_TEXT;
  recordRequest(userId);

  try {
    const res = await client.chat.completions.create({ model, messages, max_tokens: 4096 });
    const count = (userTimestamps.get(userId) || []).length;
    console.log(`✅ Groq OK (${count}/${RATE_LIMIT} req/min) model=${model}`);
    return res.choices[0].message.content;
  } catch (e) {
    console.error("Groq error:", e.message);
    if (e.status === 429) return "⚠️ API rate limit reached. Please wait a moment and try again.";
    if (e.status === 401) return "⚠️ Invalid GROQ_API_KEY. Check your .env file.";
    // Fallback to text model if vision model fails
    if (hasImages && model === MODEL_VISION) {
      try {
        console.warn("Vision model failed — falling back to text model");
        const fallback = await client.chat.completions.create({
          model: MODEL_TEXT,
          messages: messages.map(m => ({
            ...m,
            content: Array.isArray(m.content)
              ? m.content.filter(p => p.type === "text").map(p => p.text).join("\n")
              : m.content,
          })),
          max_tokens: 4096,
        });
        return fallback.choices[0].message.content;
      } catch (fe) {
        console.error("Fallback error:", fe.message);
      }
    }
    return null;
  }
}

// ── Quiz Generator ────────────────────────────────────────────────────────────
async function generateQuizFromText(text, count = 5) {
  if (!client) return null;

  const system = `You are an expert AI Exam Generator.
Generate exactly ${count} educational multiple-choice questions based on the provided material.
Return ONLY a valid JSON array — no markdown, no backticks, no commentary.
Format:
[
  {
    "question": "...",
    "options": ["A", "B", "C", "D"],
    "correct_index": 0,
    "explanation": "..."
  }
]`;

  try {
    const res = await client.chat.completions.create({
      model:       MODEL_TEXT,
      temperature: 0.6,
      max_tokens:  2048,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: `Generate a quiz from:\n\n${text.substring(0, 30000)}` },
      ],
    });
    const raw   = res.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(match ? match[0] : raw);
  } catch (e) {
    console.error("Quiz generation error:", e.message);
    return null;
  }
}

// ── Flashcard Generator ───────────────────────────────────────────────────────
async function generateFlashcards(text) {
  if (!client) return null;

  const system = `You are a Student Revision Assistant.
Summarise the main concepts into exactly 5–8 flashcards.
Return ONLY a valid JSON array — no markdown, no backticks:
[{ "question": "...", "answer": "..." }]`;

  try {
    const res = await client.chat.completions.create({
      model:       MODEL_FAST,
      temperature: 0.5,
      max_tokens:  1024,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: `Create flashcards for: ${text}` },
      ],
    });
    const raw   = res.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(match ? match[0] : raw);
  } catch (e) {
    console.error("Flashcard error:", e.message);
    return null;
  }
}

// ── AI Study Advice ───────────────────────────────────────────────────────────
async function getAIStudyAdvice(topics) {
  if (!client || !topics?.length) return null;

  const topicList = topics
    .map(t => `${t.topic_name} (score: ${t.score_percentage}%)`)
    .join(", ");

  try {
    const res = await client.chat.completions.create({
      model:       MODEL_TEXT,
      temperature: 0.7,
      max_tokens:  512,
      messages: [
        {
          role: "system",
          content: "You are Lumina AI's Academic Performance Advisor. Give a short (2–4 sentence), motivating, and highly actionable study strategy based on the student's weak topics.",
        },
        {
          role: "user",
          content: `The student struggles with: ${topicList}. What is the best study strategy for them right now?`,
        },
      ],
    });
    console.log("✅ AI study advice generated");
    return res.choices[0].message.content;
  } catch (e) {
    console.error("Study advice error:", e.message);
    return null;
  }
}

module.exports = { getTutorResponse, generateQuizFromText, generateFlashcards, getAIStudyAdvice };
