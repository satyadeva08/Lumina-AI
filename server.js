// ============================================================
// LUMINA AI — ADAPTIVE LEARNING BACKEND
// Production-ready Node.js / Express server
// ============================================================

"use strict";

const express     = require("express");
const cors        = require("cors");
const bcrypt      = require("bcrypt");
const path        = require("path");
const mysql       = require("mysql2/promise");
const nodemailer  = require("nodemailer");
const PDFDocument = require("pdfkit");
const pdf         = require("pdf-parse");
const crypto      = require("crypto");
require("dotenv").config();

const { getTutorResponse, generateQuizFromText, generateFlashcards, getAIStudyAdvice } = require("./aiService");
const { getGeminiResponse } = require("./geminiService");  // only import what exists
const { OAuth2Client } = require("google-auth-library");

const app         = express();
const SALT_ROUNDS = 10;

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://lumina-ai-khaki.vercel.app",   // Vercel frontend — hardcoded for reliability
  "https://lumina-ai-0nb5.onrender.com",  // Render backend itself
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS blocked: " + origin));
  },
  credentials: true,
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "templates")));
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "templates", "code.html"))
);

// ── Google OAuth ──────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── MySQL Pool ────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:               process.env.DB_HOST || "localhost",
  user:               process.env.DB_USER || "root",
  password:           process.env.DB_PASS || "",
  database:           process.env.DB_NAME || "adaptive_learning",
  port:               parseInt(process.env.DB_PORT, 10) || 3306,
  ssl:                { rejectUnauthorized: false },  // Required for Railway MySQL
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

pool.query("SELECT 1")
  .then(async () => {
    console.log("🗄️  Database connected ✅");
    // Auto-migrate: add teacher_email column if it does not exist
    try {
      await pool.query(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS teacher_email VARCHAR(150) DEFAULT NULL
      `);
      console.log("✅ students.teacher_email column verified");
    } catch (e) {
      // MySQL < 8.0 does not support IF NOT EXISTS on ALTER — try the check manually
      try {
        const [cols] = await pool.query(`
          SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'teacher_email'
        `);
        if (cols.length === 0) {
          await pool.query("ALTER TABLE students ADD COLUMN teacher_email VARCHAR(150) DEFAULT NULL");
          console.log("✅ Added teacher_email column to students table");
        }
      } catch (e2) {
        console.warn("⚠️  Could not auto-migrate teacher_email column:", e2.message);
      }
    }
  })
  .catch(err => console.error("❌ Database error:", err.message));

// ── Email Transporter ─────────────────────────────────────────────────────────
let transporter  = null;
let useEthereal  = false;

async function initMailer() {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
      host:   "smtp.gmail.com",
      port:   465,
      secure: true,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    transporter.verify(err => {
      if (err) console.error("❌ Email error:", err.message,
        "\n💡 Use a Gmail App Password — not your normal password.");
      else console.log("📧 Email ready ✅");
    });
  } else {
    const test = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host:   "smtp.ethereal.email",
      port:   587,
      secure: false,
      auth: { user: test.user, pass: test.pass },
    });
    useEthereal = true;
    console.log("📧 Email in TEST mode (Ethereal) — set EMAIL_USER + EMAIL_PASS for real sending.");
  }
}
initMailer().catch(console.error);

// ── Helpers ───────────────────────────────────────────────────────────────────
const hashPassword   = plain       => bcrypt.hash(plain, SALT_ROUNDS);
const verifyPassword = (plain, h)  => bcrypt.compare(plain, h);
const isValidEmail   = email       => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

async function parsePdf(buffer) {
  const parser = typeof pdf === "function" ? pdf
    : (pdf && typeof pdf.default === "function" ? pdf.default : null);
  if (!parser) throw new Error("pdf-parse not available");
  const data = await parser(buffer);
  return data.text || "";
}

// =============================================================================
// ROUTES
// =============================================================================

// ── Public Config ─────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

// ── Student Auth ──────────────────────────────────────────────────────────────
app.post("/register", async (req, res) => {
  const { name = "", email = "", password = "", department = "", semester = 1 } = req.body;
  if (!name.trim())          return res.status(400).json({ error: "Name is required" });
  if (!isValidEmail(email))  return res.status(400).json({ error: "Invalid email address" });
  if (password.length < 6)   return res.status(400).json({ error: "Password must be at least 6 characters" });
  const sem = parseInt(semester, 10);
  if (sem < 1 || sem > 8)   return res.status(400).json({ error: "Semester must be 1–8" });

  try {
    const [result] = await pool.execute(
      "INSERT INTO students (name, email, password_hash, department, semester) VALUES (?, ?, ?, ?, ?)",
      [name.trim(), email.trim().toLowerCase(), await hashPassword(password), department.trim(), sem]
    );
    return res.status(201).json({ message: "Registered successfully", student_id: result.insertId });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email already registered" });
    console.error("Register:", e.message);
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

app.post("/login", async (req, res) => {
  const { email = "", password = "" } = req.body;
  if (!email.trim() || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const [rows] = await pool.execute(
      "SELECT student_id, name, email, department, semester, password_hash FROM students WHERE email=?",
      [email.trim().toLowerCase()]
    );
    if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash)))
      return res.status(401).json({ error: "Invalid email or password" });
    const { password_hash, ...user } = rows[0];
    return res.json(user);
  } catch (e) {
    return res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/auth/google", async (req, res) => {
  const { token } = req.body;
  if (!token)            return res.status(400).json({ error: "No token provided" });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "Google OAuth not configured on server" });
  try {
    const ticket  = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email   = payload.email.trim().toLowerCase();
    const name    = payload.name.trim();
    let [rows] = await pool.execute(
      "SELECT student_id, name, email, department, semester FROM students WHERE email=?", [email]
    );
    if (rows.length === 0) {
      const dummy = await hashPassword(crypto.randomBytes(16).toString("hex"));
      const [result] = await pool.execute(
        "INSERT INTO students (name, email, password_hash, department, semester) VALUES (?, ?, ?, ?, ?)",
        [name, email, dummy, "N/A", 1]
      );
      rows = [{ student_id: result.insertId, name, email, department: "N/A", semester: 1 }];
    }
    return res.json(rows[0]);
  } catch (e) {
    console.error("Google auth:", e.message);
    return res.status(401).json({ error: "Invalid Google token" });
  }
});

// ── Teacher Auth ──────────────────────────────────────────────────────────────
app.post("/api/teacher/register", async (req, res) => {
  const { name = "", email = "", password = "" } = req.body;
  if (!name.trim())         return res.status(400).json({ error: "Name required" });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });
  if (password.length < 6)  return res.status(400).json({ error: "Password must be at least 6 characters" });
  try {
    const [result] = await pool.execute(
      "INSERT INTO teachers (name, email, password_hash) VALUES (?, ?, ?)",
      [name.trim(), email.trim().toLowerCase(), await hashPassword(password)]
    );
    return res.status(201).json({ teacher_id: result.insertId, name, email });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email already registered" });
    return res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/teacher/login", async (req, res) => {
  const { email = "", password = "" } = req.body;
  if (!email.trim() || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const [rows] = await pool.execute(
      "SELECT teacher_id, name, email, department, password_hash FROM teachers WHERE email=?",
      [email.trim().toLowerCase()]
    );
    if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash)))
      return res.status(401).json({ error: "Invalid email or password" });
    const { password_hash, ...teacher } = rows[0];
    return res.json({ role: "teacher", ...teacher });
  } catch (e) {
    return res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/teacher/profile/:teacher_id", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT teacher_id, name, email, department FROM teachers WHERE teacher_id=?",
      [req.params.teacher_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Teacher not found" });
    return res.json(rows[0]);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.put("/api/teacher/profile/:teacher_id", async (req, res) => {
  const { teacher_id } = req.params;
  const { name = "", email = "", department = "", password = "" } = req.body;
  try {
    if (email && !isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });
    if (email) {
      const [dup] = await pool.execute(
        "SELECT teacher_id FROM teachers WHERE email=? AND teacher_id!=?",
        [email.trim().toLowerCase(), teacher_id]
      );
      if (dup.length > 0) return res.status(409).json({ error: "Email already in use" });
    }
    let q = "UPDATE teachers SET name=?, department=?";
    let args = [name.trim(), department.trim()];
    if (email)    { q += ", email=?";         args.push(email.trim().toLowerCase()); }
    if (password) { q += ", password_hash=?"; args.push(await hashPassword(password)); }
    q += " WHERE teacher_id=?";
    args.push(teacher_id);
    await pool.execute(q, args);
    return res.json({ message: "Teacher profile updated" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get("/api/teacher/:email/students", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT student_id, name, email, department, semester FROM students WHERE teacher_email=?",
      [req.params.email]
    );
    return res.json(rows);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── Students ──────────────────────────────────────────────────────────────────
app.get("/students", async (_req, res) => {
  try {
    const [rows] = await pool.execute("SELECT student_id, name, email, teacher_email FROM students");
    return res.json(rows.map(r => ({ id: r.student_id, name: r.name, email: r.email, teacher_email: r.teacher_email })));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.put("/students/:student_id", async (req, res) => {
  const { student_id } = req.params;
  const { name = "", email = "", department = "", semester = 1, teacher_email = null, password = "" } = req.body;
  try {
    if (email && !isValidEmail(email)) return res.status(400).json({ error: "Invalid email" });
    if (email) {
      const [dup] = await pool.execute(
        "SELECT student_id FROM students WHERE email=? AND student_id!=?",
        [email.trim().toLowerCase(), student_id]
      );
      if (dup.length > 0) return res.status(409).json({ error: "Email already in use" });
    }
    let q = "UPDATE students SET name=?, department=?, semester=?, teacher_email=?";
    let args = [name.trim(), department.trim(), parseInt(semester, 10), teacher_email];
    if (email)    { q += ", email=?";         args.push(email.trim().toLowerCase()); }
    if (password) { q += ", password_hash=?"; args.push(await hashPassword(password)); }
    q += " WHERE student_id=?";
    args.push(student_id);
    await pool.execute(q, args);
    return res.json({ message: "Profile updated" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── Subjects & Topics ─────────────────────────────────────────────────────────
app.get("/subjects", async (_req, res) => {
  try {
    const [rows] = await pool.execute("SELECT subject_id, name FROM subjects ORDER BY name");
    return res.json(rows);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/subjects", async (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Subject name required" });
  try {
    const [r] = await pool.execute("INSERT INTO subjects (name) VALUES (?)", [name]);
    return res.status(201).json({ subject_id: r.insertId, name });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get("/topics", async (req, res) => {
  const { subject_id } = req.query;
  try {
    const [rows] = subject_id
      ? await pool.execute("SELECT topic_id, topic_name FROM topics WHERE subject_id=? ORDER BY topic_name", [subject_id])
      : await pool.execute("SELECT topic_id, topic_name FROM topics ORDER BY topic_name");
    return res.json(rows);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/topics", async (req, res) => {
  const { subject_id } = req.body;
  const topicName = (req.body.topic_name || "").trim();
  if (!subject_id || !topicName) return res.status(400).json({ error: "subject_id and topic_name required" });
  try {
    const [r] = await pool.execute("INSERT INTO topics (subject_id, topic_name) VALUES (?, ?)", [subject_id, topicName]);
    return res.status(201).json({ topic_id: r.insertId, topic_name: topicName });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── Scores & Performance ──────────────────────────────────────────────────────
app.post("/scores", async (req, res) => {
  const { student_id, topic_id, marks, max_marks, exam_date = null } = req.body;
  if (!student_id || !topic_id || marks === undefined || !max_marks)
    return res.status(400).json({ error: "student_id, topic_id, marks, and max_marks are required" });
  if (Number(marks) < 0 || Number(marks) > Number(max_marks))
    return res.status(400).json({ error: "marks must be between 0 and max_marks" });
  try {
    await pool.execute(
      "INSERT INTO scores (student_id, topic_id, marks_obtained, max_marks, exam_date) VALUES (?, ?, ?, ?, ?)",
      [student_id, topic_id, marks, max_marks, exam_date || new Date().toISOString().slice(0, 10)]
    );
    return res.json({ message: "Score added successfully" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get("/performance", async (req, res) => {
  const { student_id } = req.query;
  try {
    let q = "SELECT * FROM student_performance_summary";
    const args = [];
    if (student_id) { q += " WHERE student_id=?"; args.push(student_id); }
    const [rows] = await pool.execute(q, args);
    return res.json(rows);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── AI Recommendations ────────────────────────────────────────────────────────
app.get("/api/recommendations/:student_id", async (req, res) => {
  const { student_id } = req.params;
  try {
    await pool.execute("CALL generate_study_roadmap(?)", [student_id]);
    const [rows] = await pool.execute(
      `SELECT t.topic_name, sp.score_percentage
       FROM study_plan sp JOIN topics t ON sp.topic_id = t.topic_id
       WHERE sp.student_id=? AND sp.status='pending'
       ORDER BY sp.priority_score DESC LIMIT 3`,
      [student_id]
    );
    if (rows.length === 0)
      return res.json({ status: "success", advice: "You're doing great! No critical weak areas found." });
    const advice = await getAIStudyAdvice(rows);
    return res.json({ status: "success", topics: rows, advice: advice || "Focus on reviewing your weak topics." });
  } catch (e) {
    console.error("Recommendations:", e.message);
    return res.status(500).json({ status: "error", message: e.message });
  }
});

// ── AI Quiz ───────────────────────────────────────────────────────────────────
app.post("/api/generate-quiz", async (req, res) => {
  const { topic = "", files = [], count = 5 } = req.body;
  let sourceText = topic;
  try {
    for (const file of files) {
      if (file.mimeType === "application/pdf" && file.data) {
        try {
          const text = await parsePdf(Buffer.from(file.data, "base64"));
          sourceText += `\n\n--- From ${file.name || "PDF"} ---\n${text}`;
        } catch (e) { console.error("PDF parse:", e.message); }
      }
    }
    if (!sourceText.trim()) return res.status(400).json({ error: "Topic or PDF content required" });
    const quiz = await generateQuizFromText(sourceText, count);
    if (quiz) return res.json({ status: "success", quiz });
    return res.status(500).json({ error: "Failed to generate quiz" });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── AI Flashcards ─────────────────────────────────────────────────────────────
app.post("/api/generate-flashcards", async (req, res) => {
  const { topic } = req.body;
  if (!topic?.trim()) return res.status(400).json({ error: "Topic required" });
  const cards = await generateFlashcards(topic);
  if (cards) return res.json({ status: "success", flashcards: cards });
  return res.status(500).json({ error: "Failed to generate flashcards" });
});

// ── AI Chat ───────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message = "", history = [], files = [], systemInstruction = null } = req.body;
  if (!message.trim() && files.length === 0)
    return res.status(400).json({ error: "Message or files required" });

  let sourceText = message;
  const imageFiles = [];
  try {
    for (const file of files) {
      if (file.mimeType === "application/pdf" && file.data) {
        try {
          const text = await parsePdf(Buffer.from(file.data, "base64"));
          sourceText += `\n\n--- PDF Content ---\n${text}`;
        } catch (e) { console.error("Chat PDF:", e.message); }
      } else if (file.mimeType?.startsWith("image/")) {
        imageFiles.push(file);
      }
    }
    const reply = await getTutorResponse(sourceText, history, imageFiles, systemInstruction);
    if (reply) return res.json({ status: "success", reply });
    return res.status(500).json({ status: "error", message: "AI service temporarily unavailable." });
  } catch (e) {
    console.error("Chat:", e.message);
    return res.status(500).json({ status: "error", message: e.message });
  }
});

// ── Email Report ──────────────────────────────────────────────────────────────
app.post("/api/send-report", async (req, res) => {
  const {
    studentName   = "Student",
    teacherEmail,
    stats         = {},
    weakTopics    = [],
    reportType    = "dashboard",
    quizTopic     = "",
    quizScore     = 0,
    quizTotal     = 0,
    quizQuestions = [],
  } = req.body;

  if (!teacherEmail || !isValidEmail(teacherEmail))
    return res.status(400).json({ error: "Valid teacher email required" });
  if (!transporter)
    return res.status(503).json({ error: "Email service initialising — try again in a moment." });

  try {
    // Build PDF
    const doc     = new PDFDocument({ margin: 50 });
    const buffers = [];
    doc.on("data", c => buffers.push(c));
    const pdfReady = new Promise(resolve => doc.on("end", () => resolve(Buffer.concat(buffers))));

    const isQuiz = reportType === "quiz";
    doc.fillColor("#1a1a2e").fontSize(24).text(isQuiz ? "Quiz Performance Report" : "Academic Progress Report", { align: "center" });
    doc.moveDown();
    doc.fontSize(13).fillColor("#444").text(`Student: ${studentName}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    if (isQuiz) doc.text(`Topic: ${quizTopic}`);
    doc.moveDown();
    doc.rect(50, doc.y, 500, 2).fill("#eee");
    doc.moveDown();

    if (isQuiz) {
      const pct = quizTotal > 0 ? Math.round((quizScore / quizTotal) * 100) : 0;
      doc.fillColor("#1a1a2e").fontSize(18).text(`Result: ${quizScore} / ${quizTotal} (${pct}%)`);
      doc.moveDown();
      doc.fontSize(14).fillColor("#333").text("Detailed Review:");
      doc.moveDown(0.5);
      quizQuestions.forEach((q, i) => {
        const ok = q.selected === q.correct;
        doc.fontSize(11).fillColor("#333").text(`${i + 1}. ${q.question}`);
        doc.fontSize(10).fillColor(ok ? "#2a9d8f" : "#e63946").text(`   Your Answer: ${q.selectedText || "N/A"} ${ok ? "✓" : "✗"}`);
        if (!ok) doc.fillColor("#555").text(`   Correct: ${q.correctText}`);
        if (q.explanation) doc.fontSize(9).fillColor("#777").text(`   Note: ${q.explanation}`);
        doc.moveDown(0.4);
      });
    } else {
      doc.fillColor("#1a1a2e").fontSize(18).text("Performance Snapshot");
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor("#333")
        .text(`Overall Average: ${stats.overall_avg ?? "N/A"}%`)
        .text(`Strong Topics: ${stats.strong_count ?? "N/A"}`)
        .text(`Critical Areas: ${stats.critical_count ?? "N/A"}`);
      doc.moveDown();
      if (weakTopics.length > 0) {
        doc.fontSize(16).fillColor("#1a1a2e").text("Priority Weak Topics");
        doc.moveDown(0.3);
        weakTopics.forEach(t => doc.fontSize(11).fillColor("#e63946").text(`• ${t.topic_name}: ${t.score_pct}%`));
      }
    }

    doc.moveDown(2);
    doc.fontSize(10).fillColor("#aaa").text("Generated by Lumina AI Adaptive Learning System", { align: "center" });
    doc.end();
    const pdfBuffer = await pdfReady;

    // Send email
    const info = await transporter.sendMail({
      from:    `"Lumina AI Insights" <${process.env.EMAIL_USER || 'noreply@lumina.ai'}>`,
      to:      teacherEmail,
      subject: isQuiz ? `[Quiz Result] ${quizTopic} — ${studentName}` : `[Progress Report] ${studentName}`,
      html: `<div style="font-family:sans-serif;max-width:600px;color:#333">
        <h2 style="color:#1a1a2e">${isQuiz ? "Quiz Performance Summary" : "Academic Progress Update"}</h2>
        <p>Report for <strong>${studentName}</strong>.</p>
        <div style="background:#f8f9fa;padding:20px;border-radius:8px;margin:20px 0">
          <p>Score: <strong style="font-size:22px;color:#1a1a2e">
            ${isQuiz ? `${quizScore}/${quizTotal}` : `${stats.overall_avg ?? "N/A"}%`}
          </strong></p>
        </div>
        <p>A detailed PDF is attached.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="font-size:11px;color:#aaa">Sent automatically by Lumina AI.</p>
      </div>`,
      attachments: [{ filename: `${reportType}_Report_${studentName.replace(/\s+/g, "_")}.pdf`, content: pdfBuffer }],
    });

    const preview = useEthereal ? nodemailer.getTestMessageUrl(info) : null;
    console.log("✅ Report email sent", preview ? `(preview: ${preview})` : "");
    return res.json({ message: "Email sent!", ...(preview && { preview_url: preview }) });

  } catch (err) {
    console.error("Email/PDF:", err.message);
    return res.status(500).json({ error: "Failed to send report: " + err.message });
  }
});

// ── Error Handlers ────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("Unhandled:", err.message);
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 8000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Lumina AI → http://localhost:${PORT}`));