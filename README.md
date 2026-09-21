# Awais Codex Agent 🚀

> **Autonomous AI Engineering Agent & WhatsApp Assistant Workspace**  
> Powered strictly by the **Google Antigravity Preview Engine** (`antigravity-preview-05-2026`).

---

## 🌟 Key Features

- **Exclusive Antigravity Preview Execution**: Runs strictly on `antigravity-preview-05-2026` via API key with zero secondary or fallback models, ensuring pure, unadulterated agentic execution with tool calling, remote sandbox compilation, and step-by-step reasoning.
- **Frictionless Personal Use**: Zero administrative locks or complex authorization barriers. WhatsApp tunnel, webhooks, and local call-budget endpoints are accessible out of the box for personal workflows.
- **Manus-Style Real-Time Interface**: Live streaming SSE feedback, dynamic sub-agent status tracking, expandable thinking panel, collapsible task history, and queued task runner.
- **Persistent Cross-Session Memory**: Disk-backed memory engine (`data/agent-memory.json`) that continuously remembers user names, preferences, tech stacks, and custom directives across sessions.
- **WhatsApp Bidirectional Tunnel & Gateway**: Seamless synchronization between WhatsApp and web UI. Supports live WebSocket tunnel pairing as well as Meta Cloud API Webhooks with milestone progress broadcasts.
- **Direct GitHub Repository Export**: Export any generated solution, code files, or full workspace into a newly created GitHub repository using fine-grained or classic GitHub Personal Access Tokens (PAT).
- **In-Browser Artifact Dock & Code Viewer**: Inspect generated code, download assets, and preview web apps in real time.
- **Local APK Compiler & Packager**: Built-in ZIP/DEX package generator capable of producing standalone Android APK packages from sandbox outputs.
- **Progressive Web App (PWA)**: Installable on Android, iOS, Windows, and macOS with offline service-worker caching.

---

## 📁 Project Structure

```text
├── antigravity-client.ts     # Google Antigravity Interactions & Sandbox Environments client
├── apk-generator.ts          # Pure Node.js signed APK packager & CRC32 validator
├── call-budget-server.ts     # Server-side daily call budget tracker
├── config.ts                 # Engine configurations and API endpoints
├── memory-engine.ts          # Persistent memory store with atomic file writes & mutex locking
├── server.ts                 # Unified Express + Vite server entrypoint
│
├── routes/                   # Modular Express Routers
│   ├── github.ts             # GitHub repository export & status endpoints
│   ├── health.ts             # Health check & engine capability discovery
│   ├── memory.ts             # Memory CRUD & user profile API
│   ├── static.ts             # PWA Service Worker & Manifest delivery
│   ├── tasks.ts              # Real-time SSE /stream-task & /execute-task endpoints
│   └── whatsapp.ts           # WhatsApp Agent tunnel, Meta Webhooks & messaging
│
├── js/                       # Modular Client Application Modules
│   ├── api.js                # Error classification & API communications
│   ├── artifacts.js          # Artifact extraction, dock viewer, & code lightbox
│   ├── call-budget.js        # Client-side daily budget monitoring
│   ├── execution-cards.js    # Step cards, tool execution rendering, & APK detection
│   ├── github.js             # Client GitHub PAT management & repo export UI
│   ├── main.js               # Application bootstrap, event wiring, & settings
│   ├── memory.js             # Memory management modal controller
│   ├── queue.js              # Streaming turn execution, task queues, & retry loop
│   ├── sidebar.js            # History management, search filter, & session rename
│   ├── state.js              # Centralized UI state & DOM element bindings
│   └── thinking-panel.js     # Real-time reasoning stream & execution timer
│
├── data/                     # Persistent runtime storage
│   ├── .gitkeep              # Ensures directory exists in cloned repositories
│   └── agent-memory.example.json # Example persistent memory store schema
│
├── public/                   # Static assets, icons, and PWA manifest
├── index.html                # Single Page Application HTML shell
├── vite.config.ts            # Vite bundler configuration with PWA plugin
└── tsconfig.json             # TypeScript project configuration
```

---

## ⚙️ Configuration (`.env`)

Create a `.env` file in the root directory (see `.env.example`):

```bash
# Required: Google AI Studio API Key
GEMINI_API_KEY="your-google-ai-studio-api-key"

# Optional: Host URL for self-referential links
APP_URL="http://localhost:3000"

# Optional: GitHub Integration (Personal Access Token)
GITHUB_TOKEN="ghp_yourPersonalAccessToken"

# Optional: WhatsApp Integration (Open Personal Use)
WHATSAPP_AGENT_KEY=""
WHATSAPP_PHONE_NUMBER_ID=""
WHATSAPP_VERIFY_TOKEN="awais_codex_verify_token"
```

---

## 🚀 Getting Started

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/awaisali24443-svg/Awais-Codex-agent-.git
cd Awais-Codex-agent-

# Install dependencies
npm install
```

### 2. Development Mode

Starts the TypeScript server with live reload and Vite HMR middleware:

```bash
npm run dev
```

The application will be accessible at: `http://localhost:3000`

### 3. Production Build & Start

Compile the client bundle and bundle the backend server:

```bash
# Verify TypeScript types
npm run lint

# Build production assets
npm run build

# Start production server
npm start
```

---

## 🔒 Personal Use & Model Integrity

- **Strict Engine Isolation**: Requests strictly target `antigravity-preview-05-2026`. No silent fallbacks to generic Gemini Flash or non-preview models are permitted.
- **Unrestricted Administration**: Admin secret requirements have been set to open by default to ensure maximum convenience for personal and local workflows.
- **Safe Persistence**: Windows atomic file writes (`fs.unlinkSync` safeguard) prevent file-locking crashes when saving persistent memories.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).  
Developed with ❤️ by **Awais Ali** ([awaisali24443-svg](https://github.com/awaisali24443-svg)).
