# AWAIS CODEX — MOBILE-FIRST AUTONOMOUS AGENT CONTROL CENTER
## Master Implementation & Architecture Plan

---

## 1. Executive Summary

Awais Codex is a mobile-first personal control center for Google's autonomous **Antigravity** agent (`antigravity-preview-05-2026`). 

The guiding product vision is:
> **"I have an autonomous AI developer working for me in the cloud, and my phone is the control center."**  
> *(Not: "I am using a cramped desktop IDE on my phone.")*

The official Antigravity desktop IDE already handles heavyweight, mouse-and-keyboard desktop development. Awais Codex exists to provide a high-agency mobile cockpit: allowing an engineer on a phone to launch complex technical missions, monitor autonomous agent activity in real time, observe truthful progress without desktop clutter, intervene or guide the agent, and receive verifiable deliverables (such as compiled APKs, web apps, and GitHub commits).

This document provides a comprehensive audit of the existing codebase, extracts mobile interaction patterns from the **Manus Android application** (by Butterfly Effect Pte. Ltd.), and specifies the target mobile-first architecture, screen-by-screen layouts, event streaming normalizer, and file-by-file implementation roadmap.

**Strict Governance Rule**: No production code will be modified until this plan is formally reviewed and approved by the user.

---

## 2. Existing Architecture Audit

A rigorous inspection of all backend routers, client scripts, and assets in `awaisali24443-svg/Awais-Codex-agent-` reveals the following operational status across subsystems:

| Subsystem | File Reference | Status | Audit Findings & Deficiencies |
|---|---|---|---|
| **Antigravity API Client** | `antigravity-client.ts` | **WORKING** | Correctly integrates with `https://generativelanguage.googleapis.com/v1beta/interactions` and `/environments`. Clean retry with automatic stale environment recovery (`HTTP 400/404`) and storage quota auto-cleanup (`cleanupOldEnvironments`). Single-model isolation verified. |
| **Token Efficiency & Turn Continuation** | `routes/tasks.ts:20-47, 231-236` | **PARTIALLY WORKING** | **Critical Defect**: When continuing an ongoing mission, `routes/tasks.ts` passes `previous_interaction_id`, yet it *also* prepends a manually formatted `historyBlock` (up to thousands of characters) to the prompt. Antigravity already maintains dialogue state when continuing an interaction. This duplicates tokens and exhausts context windows prematurely. |
| **SSE Streaming Endpoint** | `routes/tasks.ts:200-433` | **WORKING** | Solid HTTP SSE pipeline with 15-second keep-alive heartbeats, client abort listeners, and clear error mapping (`429 quota_exceeded`, `401 auth_failed`, `404 agent_unavailable`). |
| **Event Normalization Layer** | `routes/tasks.ts`, `js/execution-cards.js` | **PARTIALLY WORKING** | Raw Antigravity SSE events (`step.start`, `step.delta`, `interaction.completed`) are passed through with minimal structuring. The frontend relies on brittle regex heuristics in `js/execution-cards.js` to guess tool types. There is no unified, high-level semantic event normalizer. |
| **Persistent Memory Engine** | `memory-engine.ts`, `routes/memory.ts` | **WORKING** | Disk-backed storage in `data/agent-memory.json` with mutex lock and Windows atomic rename safeguard (`fs.unlinkSync`). Deterministic pattern extraction without secondary model overhead. |
| **WhatsApp Gateway & Agent Tunnel** | `routes/whatsapp.ts` | **WORKING** | WebSocket tunnel pairing and Meta Cloud API Webhook routing. Open personal use mode (no admin key barrier). Background task progress updates every 10 seconds. |
| **GitHub Integration** | `routes/github.ts`, `js/github.js` | **WORKING** | Autonomous export of generated solutions and source trees into new GitHub repositories using classic or fine-grained PATs. |
| **Call Budget Server** | `call-budget-server.ts`, `routes/tasks.ts:49-53` | **WORKING** | Daily quota tracker with open personal use endpoint `/api/call-budget`. |
| **PWA & Service Worker** | `public/sw.js`, `public/manifest.json` | **WORKING** | Offline caching for static media, bypasses `/api/` dynamic requests, dark theme metadata configured. |
| **APK Generation & Deliverables** | `apk-generator.ts` | **BROKEN / UNSUITABLE** | `apk-generator.ts` generates a dummy zip container with mock DEX headers that cannot actually be installed on an Android device. Real APK generation must be executed by Antigravity running Gradle in the remote Linux sandbox. Fake APK generation should be removed or strictly demarcated as a simulated dummy. |
| **Desktop-Oriented UI Shell** | `index.html` (3,834 lines), `js/main.js` | **BROKEN FOR MOBILE** | The frontend is designed as a desktop web app: a slide-out sidebar, fixed 60px header, right-hand side artifacts dock, split-screen toggle (`sidebar-nav-split`), and chat bubbles. On a smartphone, this feels like a cramped desktop IDE rather than an agent control plane. |
| **Mobile Navigation & Ergonomics** | `index.html`, `js/main.js` | **MISSING** | Missing mobile bottom navigation bar, thumb-friendly touch targets (>= 44px), mobile safe-area insets (`env(safe-area-inset-bottom)`), pull-to-refresh, dynamic viewport height handling (`dvh`), and mobile task-card layouts. |

---

## 3. Manus Android Research Findings

Based on analysis of the official **Manus** Android application (`tech.butterfly.app` by Butterfly Effect Pte. Ltd.) on Google Play and publicly documented mobile task flows, the core findings are classified below:

### A. Observed (Directly Verified in Mobile App & Listings)
1. **Action Engine vs. Chatbot**: Manus does not present itself as a standard conversational chatbot with text bubbles. It presents as an autonomous task execution engine.
2. **Autonomous Task Decomposition (The To-Do Plan)**: When a user assigns a mission, the agent first decomposes the objective into a discrete checklist of subtasks (e.g. *Analyze requirements → Setup scaffolding → Implement backend → Generate UI → Verify build*).
3. **Asynchronous Cloud Execution**: Tasks run asynchronously in the cloud. The user can start a mission, exit the mobile app, lock their phone, and return later. The mission status (Running, Paused, Succeeded, Failed) persists in the cloud backend.
4. **Observable Activity, Not Raw Terminal Spam**: The mobile interface does not overwhelm the user with raw terminal dumps or internal reasoning dumps. Instead, it streams observable, high-level action cards: *“⚡ Creating database schema”*, *“🔨 Running build test”*, *“📁 Generated 4 source files”*.
5. **Human-in-the-Loop Controls**: The user retains full control at all times via persistent, accessible controls: **Stop**, **Intervene / Provide Guidance**, and **Continue Mission**.
6. **Deliverable-Centric Completion**: When finished, the interface spotlights final deliverables (downloadable files, rendered web previews, repository links) above the raw execution log.

### B. Inferred (Architecturally Implied by Mobile Patterns)
1. **Navigation Structure**: Mobile-first apps of this class utilize either a clean bottom navigation bar (e.g. *Missions / Hub, New Task (+), Projects, Memory/Settings*) or a focused master-detail navigation stack where tapping a task transitions seamlessly into full-screen Mission Control.
2. **One-Handed Mobile Ergonomics**: Primary action buttons (Stop, Continue, Launch Mission) and input drawers are anchored to the bottom third of the display within natural thumb reach.
3. **Event Normalization Layer**: The backend normalizes raw container actions (e.g. `npm install`, `sed -i`, `bash exit 0`) into structured semantic events (*Status, Phase, Title, Target File, Error Message*) before emitting them to the mobile client.

### C. Unknown (Proprietary / Internal)
1. The exact proprietary server-side task scheduler and browser automation driver used inside Manus cloud containers. *(Note: Awais Codex relies on Google's official Antigravity API and remote Linux sandbox, which already provides native tool execution, command execution, and file editing).*
2. Proprietary push notification mechanisms (e.g. Firebase Cloud Messaging vs. Web Push).

---

## 4. UX Analysis: From "Chatbot" to "Mission Control Center"

### Comparison: What Awais Codex Has Today vs. Target Mobile Vision

| Dimension | Existing Awais Codex Implementation | Target Mobile Control Center (Manus-Inspired) |
|---|---|---|
| **Mental Model** | "Chat room with execution widgets" | **"Autonomous Mission Control Center"** |
| **Primary Unit** | Chat conversation / message turn | **Autonomous Mission (Goal, Plan, Live Steps, Outcome)** |
| **Information Hierarchy** | Chronological text bubbles with nested cards | **Top: Current Activity Banner → Middle: Plan Checklist & Activity Feed → Bottom: Controls** |
| **Progress Presentation** | Small spinner and generic "Thinking..." timer | **Dynamic To-Do Checklist (Completed ✓, Running ●, Pending ○)** |
| **Raw Tool Output** | Hidden inside collapsible accordion drawers | **Clean semantic event cards with expandable details on demand** |
| **Artifact Presentation** | Right-hand desktop dock that squishes chat | **Bottom sheet modal and dedicated Deliverables summary card** |
| **Mobile Navigation** | Desktop sidebar that covers entire screen | **Bottom navigation bar & native mobile header with back button** |
| **Ergonomics** | Desktop hover states, small buttons, no safe-area padding | **44px+ touch targets, bottom-anchored actions, `dvh` viewport sizing** |

---

## 5. Target Architecture

```text
                  MOBILE CLIENT (PWA / Android Browser)
┌─────────────────────────────────────────────────────────────────────────┐
│  • Mobile Safe-Area Layout (dvh, notch/home bar padding)                │
│  • Bottom Navigation Bar (Missions Hub | New Task | Projects | Memory) │
│  • Live Mission Control View (Plan Checklist, Live Activity Hero)       │
│  • Deliverables Bottom Sheet (Artifacts, APKs, GitHub Export)           │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Touch Actions / SSE Stream
                                     ▼
                    AWAIS CODEX BACKEND (Node/Express)
┌─────────────────────────────────────────────────────────────────────────┐
│  • /api/stream-task & /api/execute-task                                 │
│  • Token Efficiency Optimizer (prevents duplicate history on continue) │
│  • EVENT NORMALIZATION LAYER:                                           │
│      Raw Antigravity SSE ──► Normalized Mission Events:                  │
│      - phase (planning | coding | building | testing | verification)    │
│      - activity_summary ("Compiling CameraService...")                   │
│      - tool_details (file created, command run, exit code)               │
│      - plan_update (step completed, next step active)                   │
│  • Persistent Memory Engine (agent-memory.json)                         │
│  • Daily Call Budget & WhatsApp Gateway                                 │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ REST / SSE (?key=GEMINI_API_KEY)
                                     ▼
                     GOOGLE ANTIGRAVITY ENGINE
┌─────────────────────────────────────────────────────────────────────────┐
│  Model: antigravity-preview-05-2026                                     │
│  Remote Linux Sandbox Environments (remote / env_id)                    │
│  Native Tool Calling: run_command, create_file, edit_file, etc.         │
│  Interaction Continuation: previous_interaction_id                      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Screen-by-Screen Mobile Specification

### Screen 1: Mission Hub (Home Screen)
- **Top App Bar**: 
  - Left: Awais Codex brand mark with live engine pill (`Antigravity 05-2026`).
  - Right: Daily call budget pill (`12/100 today`) and Quick Memory badge (`🧠`).
- **Active Mission Card (Hero Section)**:
  - If a mission is actively running in the background:
    - Glowing amber/blue status pulse: `● RUNNING (3m 14s)`.
    - Mission Objective: *"Build Android Obstacle Detection App"*.
    - Current Activity: *"⚡ Compiling Gradle debug APK..."*.
    - Progress mini-bar: `3 of 5 steps complete`.
    - Tap card → transitions directly into Screen 3 (Live Mission Control).
- **Quick Action Row**:
  - Horizontal pill buttons: `[ 📱 Android App ]`, `[ 🌐 Web App ]`, `[ 🔬 Deep Research ]`, `[ 📊 Data Pipeline ]`.
  - Tapping auto-populates objective templates in the New Mission creator.
- **Recent Missions List**:
  - Clean card list grouped by recency (Today, Yesterday, Older).
  - Each card displays: Status icon (✓ Green, ✗ Red, ⏸ Paused), Mission Title, Artifact pill (e.g. `1 APK`, `4 Files`), and timestamp.
  - Swipe left on card: Rename or Archive/Delete.
- **Bottom Navigation Bar**:
  - `[ 📋 Missions ]` (Active)
  - `[ ➕ New Mission ]` (Center elevated button)
  - `[ 📁 Projects ]`
  - `[ ⚙️ Settings ]`

### Screen 2: New Mission Creator (Task Launchpad)
- **Header**: `New Mission` with `Close (✕)` button.
- **Objective Input Area**:
  - Full-width mobile textarea with adaptive height (`min-height: 120px`).
  - Placeholder: *"Describe the mission for Antigravity (e.g., Build a native Android weather app with Compose, compile APK)..."*
- **Project / Environment Attachment**:
  - Dropdown selector: `[ 📂 New Project / Sandbox ]` or select an existing project (`[ Project: AuraSense (env_3910) ]`).
  - Allows seamless continuation within an existing remote environment without rebuilding context.
- **Attachment Tray**:
  - Horizontal chip carousel for attached files/images/specs with thumbnail and remove button (`✕`).
  - `[ 📎 Attach File / Photo ]` button opening native Android file picker.
- **Launch Action**:
  - Full-width sticky button at bottom: **`[ 🚀 Launch Mission ]`** (48px height, thumb-friendly).

### Screen 3: Live Mission Control (Running Task Cockpit)
- **Header Bar**:
  - `← Back to Hub` navigation.
  - Mission Title (single-line ellipsis with inline rename).
  - Live Connection Status pill: `● Working` (pulsing) / `⏸ Rate Limited (retry in 45s)` / `⚠️ Error`.
- **Current Activity Banner (Top Hero)**:
  - High-visibility status card explaining *WHAT NOW*:
    ```text
    ┌────────────────────────────────────────────────────────┐
    │ ⚡ CURRENT ACTIVITY                                    │
    │ Compiling Gradle project & assembling debug APK...    │
    │ Running command: ./gradlew assembleDebug              │
    └────────────────────────────────────────────────────────┘
    ```
- **Execution Plan (Dynamic To-Do Checklist)**:
  - High-level phases derived from agent milestones:
    ```text
    PLAN
    ✓ 1. Analyze architecture & requirements
    ✓ 2. Generate project structure & manifests
    ✓ 3. Implement CameraService & UI components
    ● 4. Compile Gradle build & package APK (active)
    ○ 5. Verify build outputs & export deliverables
    ```
- **Observable Activity Feed (Chronological Stream)**:
  - Real tool actions formatted as readable cards (not raw terminal spam):
    - `[ 📁 File Created ]` `app/src/main/AndroidManifest.xml`
    - `[ 📁 File Modified ]` `app/build.gradle.kts (+24 lines)`
    - `[ ⚡ Command Executed ]` `gradle wrapper` `(Exit: 0)`
  - Each item is expandable on tap to inspect exact command output or file diff if the user wants deeper technical verification.
- **Sticky Bottom Action Bar**:
  - Left: **`[ 🛑 Stop Mission ]`** (Halts stream and interrupts container execution).
  - Right: **`[ 💬 Intervene / Guide ]`** (Opens quick bottom drawer to send additional instructions to the working agent).

### Screen 4: Completed Mission & Deliverables
- **Success Banner**:
  - `✅ Mission Completed Successfully` in 4m 22s.
  - Executive summary synthesized from the completed solution.
- **Deliverables Carousel (Artifacts)**:
  - Primary deliverable card:
    ```text
    ┌────────────────────────────────────────────────────────┐
    │ 📦 app-debug.apk                                       │
    │ Android Application Package • 14.2 MB • Ready         │
    │ [ ⬇️ Download APK ]       [ 🔗 Push to GitHub ]        │
    └────────────────────────────────────────────────────────┘
    ```
  - Additional generated files: `src.zip`, `README.md`, `build.log`.
- **Mission Continuation Composer**:
  - Bottom-anchored prompt box: *"Give follow-up instructions for this project..."*
  - Uses `previous_interaction_id` and existing `environmentId` for instant, context-efficient continuation.

### Screen 5: Projects & Sandboxes Manager
- List of active remote Linux sandboxes.
- Shows sandbox creation date, storage quota status, and associated missions.
- Option to clean up or reset a sandbox environment.

### Screen 6: Memory & Settings Cockpit
- Persistent memory viewer (profile attributes, extracted preferences, directives).
- Antigravity API key configuration with connection check.
- WhatsApp gateway status (active tunnels and pairing keys).

---

## 7. Mission Lifecycle & State Machine

```text
[ DRAFT ]
    │ User enters goal & attachments
    ▼
[ QUEUED ]
    │ Added to local/server execution queue
    ▼
[ INITIALIZING ]
    │ Allocating remote sandbox or resuming environment
    ▼
[ RUNNING ] ◄────────────────────────────────────────┐
    │ SSE stream emitting normalized events          │
    ├─► [ PAUSED / RATE LIMITED ] (auto-retry countdown) ───┤
    ├─► [ INTERVENTION ] (user injects direction) ───────────┘
    ├─► [ STOPPED ] (user aborted execution)
    ├─► [ FAILED ] (quota exhausted, syntax error, build failed)
    │
    ▼
[ COMPLETED ]
    │ Deliverables ready, persistent memory updated
    ▼
[ CONTINUED ] (Starts new turn in same environment)
```

---

## 8. Streaming & Event Normalization Architecture

Currently, Antigravity sends low-level SSE blocks. We will introduce a lightweight **Event Normalizer** that maps raw events into clean, mobile-ready event models:

```typescript
export interface NormalizedMissionEvent {
  id: string;
  timestamp: number;
  type: 'activity' | 'plan' | 'output' | 'artifact' | 'status' | 'error';
  phase?: 'planning' | 'scaffolding' | 'implementation' | 'build' | 'verification';
  status: 'running' | 'completed' | 'failed';
  title: string;          // e.g. "Creating CameraService.kt"
  detail?: string;         // e.g. "Written 84 lines to /src/..."
  toolName?: string;       // e.g. "create_file", "run_command"
  rawPayload?: any;        // Available if user taps "Show Technical Details"
}
```

### Event Normalization Logic:
1. When a `step.start` or `step.delta` contains `create_file` or `edit_file`:
   - Title: `Creating ${filename}` or `Editing ${filename}`
   - Phase: `implementation`
2. When `step` contains `run_command`:
   - If command contains `gradle`, `build`, `mvn`, `npm run build`: Title: `Building & compiling application...`, Phase: `build`
   - If command contains `test`, `pytest`, `jest`: Title: `Running test suite...`, Phase: `verification`
   - If command contains `git`: Title: `Version control operation...`
3. When `thought` summary arrives:
   - Sets observable activity stage (e.g. `Analyzing dependency requirements...`).
   - Does **not** dump unformatted internal monologue.
4. When tool output matches `.apk`, `.zip`, `.tar`:
   - Emits `artifact` event immediately to populate the Deliverables tray.

---

## 9. Backend Changes (Conservative & Non-Destructive)

We preserve existing routers and infrastructure while applying targeted fixes:

1. **Token Efficiency & Context De-duplication (`routes/tasks.ts`)**:
   - Update `buildContextualPrompt()`: If `previousInteractionId` is present, **do not** inject the huge historical dialogue block. Let the Antigravity session maintain context natively.
   - Keep memory directives concise and focused.
2. **Normalized SSE Stream Enhancement (`routes/tasks.ts`)**:
   - In `/api/stream-task`, emit normalized `event: mission.activity` events alongside standard SSE so the mobile client can render high-level cards without client-side guessing.
3. **True Build Artifact Handling (`routes/tasks.ts` & `apk-generator.ts`)**:
   - Deprecate mock/fake APK generation. If Antigravity fails to produce an APK in the sandbox, report the build log truthfully rather than returning a corrupt dummy zip.

---

## 10. Frontend Changes (Mobile-First Redesign)

1. **HTML Architecture (`index.html`)**:
   - Replace the desktop layout with a mobile viewport container:
     - `meta viewport: width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`
   - Implement the **Bottom Navigation Bar** (`nav.mobile-nav-bar`).
   - Replace the desktop side-dock with a mobile **Artifacts Bottom Sheet**.
2. **Mobile CSS Architecture (`css/mobile.css` or embedded within stylesheet)**:
   - CSS custom properties for safe-area insets (`env(safe-area-inset-top)`, `env(safe-area-inset-bottom)`).
   - High-contrast, clean dark theme (background `#0d0d12`, surface `#16161f`, accent `#3b82f6`).
   - Elimination of desktop hover requirements; all active states use `:active` touch feedback.
   - Elimination of horizontal overflow and desktop split screens.
3. **Client Modular Refactoring (`js/`)**:
   - `js/mobile-nav.js`: Handles screen routing (Hub ↔ New Mission ↔ Live Mission ↔ Deliverables).
   - `js/mission-view.js`: Renders the Live Mission Cockpit (Plan Checklist, Current Activity Hero, Activity Stream).
   - `js/artifacts-sheet.js`: Handles the mobile Deliverables drawer and downloads.
   - `js/state.js` & `js/queue.js`: Preserved and enhanced with normalized mission event processing.

---

## 11. File-by-File Implementation Map

| File | Action | Purpose |
|---|---|---|
| `routes/tasks.ts` | **MODIFY** | Fix prompt token duplication on continuation; emit normalized mission activity events. |
| `antigravity-client.ts` | **PRESERVE** | Keep existing Antigravity interactions client intact. |
| `memory-engine.ts` | **PRESERVE** | Keep existing persistent memory system intact. |
| `routes/whatsapp.ts` | **PRESERVE** | Keep existing open personal use WhatsApp gateway intact. |
| `index.html` | **MODIFY** | Refactor DOM layout into mobile-first screens (Hub, Launchpad, Live Mission Cockpit, Bottom Nav, Artifacts Sheet). |
| `js/state.js` | **MODIFY** | Add mobile view state (`activeScreen: 'hub' | 'new_mission' | 'mission_control' | 'projects' | 'settings'`). |
| `js/queue.js` | **MODIFY** | Connect normalized mission events to the live mobile plan checklist and activity feed. |
| `js/execution-cards.js` | **MODIFY** | Clean up desktop-style code editors; render mobile-native action cards. |
| `js/artifacts.js` | **MODIFY** | Switch from desktop right-dock to mobile-native bottom sheet modal. |
| `js/sidebar.js` | **REPLACE / ADAPT** | Transition desktop sidebar history into the mobile Mission Hub list. |
| `public/manifest.json` | **VERIFY** | Ensure `display: standalone`, `orientation: portrait`, and theme colors match mobile UX. |

---

## 12. Testing & Verification Strategy

| Test Area | Verification Procedure | Acceptance Criteria |
|---|---|---|
| **Mobile Viewport & Scaling** | Test on 360px, 390px, and 412px viewports in Chrome DevTools mobile emulation and real Android devices. | Zero horizontal scroll, touch targets >= 44px, safe area padding respected on notched screens. |
| **Virtual Keyboard Handling** | Focus input on mobile; verify viewport adjustment with `interactive-widget=resizes-content`. | Bottom input stays above soft keyboard without covering active mission content. |
| **SSE Stream Reliability** | Launch a multi-step mission; simulate network throttling (3G/4G). | Events stream smoothly; keep-alives prevent dropouts; reconnects resume gracefully. |
| **Token Efficiency on Continuation** | Start Mission Turn 1, then continue with Turn 2 in the same environment. | Turn 2 does not resend Turn 1's history block; uses `previous_interaction_id` natively. |
| **Stop & Intervene** | Tap "Stop Mission" during an active tool call. | Backend aborts fetch, terminates container call, and reflects "Stopped by user" in UI. |
| **Completed Deliverables** | Build an app or script; view deliverables. | Artifacts appear in bottom sheet; APK / Zip / Code download triggers cleanly. |
| **WhatsApp Continuity** | Send a task via WhatsApp; open mobile web app. | Task appears in mobile Mission Hub with live status synchronized. |
| **TypeScript & Build** | Run `npm run lint` and `npm run build`. | Clean compilation with **0 TypeScript errors** and successful Vite/esbuild bundles. |

---

## 13. Rollout Phases

1. **Phase 1: Backend Optimization & Token Efficiency**
   - Eliminate history duplication when `previous_interaction_id` is supplied.
   - Verify normalized SSE stream emission.
2. **Phase 2: Mobile Information Architecture & Layout Shell**
   - Implement mobile header, Bottom Navigation Bar, and Screen router.
   - Retain full functionality of history and settings in mobile format.
3. **Phase 3: Live Mission Control & Dynamic Plan Checklist**
   - Build Screen 3 (Live Mission Control): Current Activity Banner, Plan Checklist, and observable activity feed.
4. **Phase 4: Deliverables Bottom Sheet & Artifact Handling**
   - Replace desktop right-dock with mobile touch-friendly bottom sheet.
   - Connect download handlers and GitHub repository export.
5. **Phase 5: Mobile Ergonomics & Verification Hardening**
   - Touch tuning, soft keyboard adjustments, safe-area inset testing, and end-to-end mission verification.

---

## 14. Risks & Mitigations

1. **Risk: Soft Keyboard Covers Action Controls on Android Chrome**  
   *Mitigation*: Use CSS `100dvh` (dynamic viewport height) and `viewport-fit=cover` with `interactive-widget=resizes-content` in the viewport meta tag.
2. **Risk: Loss of Streaming State on Mobile Network Drop**  
   *Mitigation*: The backend retains the latest turn state and interaction ID. When the mobile client reconnects, it retrieves current turn progress seamlessly.
3. **Risk: Context Exhaustion on Long Missions**  
   *Mitigation*: By relying on Antigravity's native `previous_interaction_id` and sandbox continuation instead of manually injecting prior turns, token consumption is minimized.

---

## 15. Open Questions for Human Review

1. **Navigation Paradigm**: Do you prefer the **Bottom Navigation Bar** (*Missions Hub, New Mission, Projects, Settings*) or a **Floating Action Button (+)** that opens a modal drawer? *(Plan recommends Bottom Navigation for one-handed mobile ergonomics).*
2. **Activity Feed Verbosity**: Should technical command logs (e.g. exit codes, compiler stdout) be completely hidden behind a "View Details" tap, or show 1-2 preview lines by default? *(Plan recommends 1-line clean summary with tap-to-expand).*

---

## 16. Explicit Approval Checkpoint

> [!IMPORTANT]
> **GOVERNANCE NOTICE**: In strict accordance with the prompt's instructions:
> - **NO production code has been modified.**
> - **NO files have been touched prior to review.**
> - Implementation will commence incrementally **only after you provide explicit approval** of this plan.
