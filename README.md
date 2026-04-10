# Lumina AI — Adaptive Learning Intelligence System

A full-stack AI-powered student performance tracking and tutoring platform.

---

## Quick Start

### 1. Prerequisites
- Node.js 18+
- MySQL 8+

### 2. Setup

```bash
# Install dependencies (includes bcrypt added in v2)
npm install

# Copy environment config and fill in your values
cp .env.example .env
```

Edit `.env` and add your API keys (see comments in the file).

### 3. Database

```bash
# Create the database and run the schema
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS adaptive_learning;"
mysql -u root -p adaptive_learning < database.sql
```

### 4. Run

```bash
# Development (auto-restarts on file change)
npm run dev

# Production
npm start
```

Open **http://localhost:8000** in your browser.

---

## API Keys

| Service | Where to get it | Required? |
|---------|----------------|-----------|
| Groq    | https://console.groq.com | ✅ Yes (AI chat, quiz, flashcards) |
| Gemini  | https://aistudio.google.com/app/apikey | Optional |
| Google OAuth | https://console.cloud.google.com | Optional (for Google Sign-In) |
| Gmail App Password | Google Account → Security → App Passwords | Optional (for real email) |

---

## Project Structure

```
├── server.js          # Express backend (all routes)
├── aiService.js       # Groq AI — chat, quiz, flashcards, study advice
├── geminiService.js   # Google Gemini AI — multimodal chat
├── database.sql       # MySQL schema, views, stored procedures, triggers
├── templates/
│   └── code.html      # Full frontend (single-page app)
├── .env.example       # Environment variable template
└── package.json
```

---

## Changes in v2 (Production-Ready)

- ✅ **bcrypt** password hashing (replaced insecure SHA-256)
- ✅ **Per-user rate limiting** (Groq AI — was global, now per-user)
- ✅ **CORS** restricted to known origins
- ✅ **Input validation** — email format, password length, semester range
- ✅ **Email** auto-falls back to Ethereal test SMTP when not configured
- ✅ `generateQuizFromFiles` import crash fixed (function didn't exist)
- ✅ `favicon.ico` returns 204 instead of 500
- ✅ Vision model fallback if Groq vision fails
- ✅ `nodemailer.getTestMessageUrl` only called for Ethereal (not real email)
- ✅ Google Client ID moved out of hardcoded HTML
- ✅ Frontend error messages improved
- ✅ Global error handler added
- ✅ `bcrypt` added to `package.json`

---

## Deployment (Railway / Render)

1. Push code to GitHub
2. Connect repo to Railway or Render
3. Add all `.env` variables in the dashboard
4. Set `FRONTEND_URL` to your deployed domain
5. The frontend is served directly by Express from `/templates/`

