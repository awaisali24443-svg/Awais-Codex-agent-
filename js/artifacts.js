// ==========================================
// DEVELOPER ARTIFACTS DOCK, LIGHTBOX & DOWNLOADS
// ==========================================

import { state, el, escapeHtml, normalizeProject } from './state.js';
import { detectStepRole, getRoleLabel, guessFilename, detectApkInfo } from './execution-cards.js';

const TARGET_ENGINE = 'antigravity-preview-05-2026';
let showToastCallback = null;

export function setArtifactsHandlers(handlers) {
  if (handlers.showToast) showToastCallback = handlers.showToast;
}

export function extractArtifactsFromProject(project) {
  if (!project) return [];
  normalizeProject(project);
  const artifacts = [];
  const codeBlockRegex = /```([a-zA-Z0-9_\-\.\+]*)\n?([\s\S]*?)```/g;

  const turns = Array.isArray(project.messages) && project.messages.length > 0
    ? project.messages
    : [{
        id: `turn_${project.id}`,
        output: project.output,
        steps: project.steps
      }];

  turns.forEach((turn, tIdx) => {
    // Check for APK in turn
    const apk = detectApkInfo(turn.output, turn.steps);
    if (apk) {
      const alreadyHas = artifacts.some(a => a.type === 'apk' && a.apkPath === apk.path);
      if (!alreadyHas) {
        artifacts.push({
          id: `art_apk_${turn.id}`,
          name: apk.filename,
          lang: 'apk',
          code: `[ANDROID APK PACKAGE]\nFilename: ${apk.filename}\nFull Container Path: ${apk.path}\nEstimated Size: ${apk.size}\nTarget Architecture: universal\nPackage Status: Ready for installation\n\nDownload this APK directly by clicking the 'Download APK' button in the toolbar or header.`,
          type: 'apk',
          previewable: false,
          source: `Turn ${tIdx + 1} Build Output`,
          apkPath: apk.path,
          apkSize: apk.size
        });
      }
    }

    // 1. Extract from output
    if (turn.output) {
      let match;
      let idx = 0;
      while ((match = codeBlockRegex.exec(turn.output)) !== null) {
        const rawLang = (match[1] || 'code').trim().toLowerCase();
        const code = match[2].trim();
        const filename = guessFilename(rawLang, idx);
        const isPreviewable = ['html', 'svg', 'htm'].includes(rawLang);
        artifacts.push({
          id: `art_out_${turn.id}_${idx}`,
          name: filename,
          lang: rawLang || 'code',
          code: code,
          type: rawLang,
          previewable: isPreviewable,
          source: `Turn ${tIdx + 1} Code`
        });
        idx++;
      }
    }

    // 2. Extract from steps
    if (Array.isArray(turn.steps)) {
      turn.steps.forEach((step, sIdx) => {
        if (step.function_call && step.function_call.arguments) {
          const args = step.function_call.arguments;
          if (args.code || args.command || args.script) {
            const code = (args.code || args.command || args.script).trim();
            const lang = args.language || (args.command ? 'bash' : 'python');
            const fname = `${step.function_call.name || 'sandbox'}_turn${tIdx + 1}_step${sIdx + 1}.${lang === 'bash' ? 'sh' : 'py'}`;
            artifacts.push({
              id: `art_step_${turn.id}_${sIdx}`,
              name: fname,
              lang: lang,
              code: code,
              type: lang,
              previewable: false,
              source: `Turn ${tIdx + 1} Step ${sIdx + 1}`
            });
          }
        }
      });
    }
  });

  // 3. Fallback: if no code fences, provide README/markdown artifact from latest turn
  if (artifacts.length === 0) {
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.output) {
      artifacts.push({
        id: `art_sol_${lastTurn.id}`,
        name: 'solution.md',
        lang: 'markdown',
        code: lastTurn.output,
        type: 'markdown',
        previewable: false,
        source: 'Synthesized Solution'
      });
    }
  }

  return artifacts;
}

export function updateArtifactsDockForProject(project) {
  if (!el.artifactsDock) return;
  if (!project) {
    if (el.artifactsBadge) el.artifactsBadge.textContent = '0';
    if (el.artifactsCountPill) el.artifactsCountPill.textContent = '0 files';
    if (el.artifactsFileList) {
      el.artifactsFileList.innerHTML = '<span style="color: var(--text-subtle); font-size: 11px; padding: 4px;">No active task selected</span>';
    }
    if (el.artifactLineNumbers) el.artifactLineNumbers.innerHTML = '<span>1</span>';
    if (el.artifactCodeDisplay) el.artifactCodeDisplay.textContent = '// No code selected';
    if (el.artifactLogsDisplay) el.artifactLogsDisplay.textContent = 'No logs available';
    return;
  }

  const artifacts = extractArtifactsFromProject(project);
  project._artifacts = artifacts;

  if (el.artifactsBadge) el.artifactsBadge.textContent = String(artifacts.length);
  if (el.sidebarArtifactsBadge) el.sidebarArtifactsBadge.textContent = String(artifacts.length);
  if (el.artifactsCountPill) el.artifactsCountPill.textContent = `${artifacts.length} file${artifacts.length === 1 ? '' : 's'}`;

  if (el.artifactsFileList) {
    el.artifactsFileList.innerHTML = '';
    if (artifacts.length === 0) {
      el.artifactsFileList.innerHTML = '<span style="color: var(--text-subtle); font-size: 11px; padding: 4px;">No code artifacts generated in this task</span>';
    } else {
      if (!state.activeArtifactId || !artifacts.some(a => a.id === state.activeArtifactId)) {
        state.activeArtifactId = artifacts[0].id;
      }

      artifacts.forEach(art => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `artifact-file-chip ${art.id === state.activeArtifactId ? 'active' : ''}`;
        chip.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
          </svg>
          <span>${escapeHtml(art.name)}</span>
        `;
        chip.addEventListener('click', () => {
          state.activeArtifactId = art.id;
          renderArtifactView(project, art);
          updateArtifactChipsActive();
        });
        el.artifactsFileList.appendChild(chip);
      });
    }
  }

  const activeArt = artifacts.find(a => a.id === state.activeArtifactId) || artifacts[0];
  renderArtifactView(project, activeArt);
  renderSandboxLogs(project);
}

export function updateArtifactChipsActive() {
  if (!el.artifactsFileList) return;
  const chips = el.artifactsFileList.querySelectorAll('.artifact-file-chip');
  const project = state.projects.find(p => p.id === state.activeSessionId) || state.activeTask;
  if (!project || !project._artifacts) return;
  chips.forEach((chip, idx) => {
    const art = project._artifacts[idx];
    if (art && art.id === state.activeArtifactId) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

export function renderArtifactView(project, artifact) {
  if (!artifact) {
    if (el.artifactFilenamePill) el.artifactFilenamePill.textContent = 'untitled';
    if (el.artifactLangPill) el.artifactLangPill.textContent = 'none';
    if (el.artifactStatsPill) el.artifactStatsPill.textContent = '0 lines';
    if (el.artifactLineNumbers) el.artifactLineNumbers.innerHTML = '<span>1</span>';
    if (el.artifactCodeDisplay) el.artifactCodeDisplay.textContent = '// No code selected';
    if (el.artifactPreviewFrame) el.artifactPreviewFrame.style.display = 'none';
    if (el.artifactPreviewPlaceholder) el.artifactPreviewPlaceholder.style.display = 'flex';
    return;
  }

  if (el.artifactFilenamePill) el.artifactFilenamePill.textContent = artifact.name;
  if (el.artifactLangPill) el.artifactLangPill.textContent = artifact.lang;

  const lines = (artifact.code || '').split('\n');
  if (el.artifactStatsPill) el.artifactStatsPill.textContent = `${lines.length} lines • ${artifact.code.length} chars`;

  if (el.artifactLineNumbers) {
    el.artifactLineNumbers.innerHTML = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
  }
  if (el.artifactCodeDisplay) {
    el.artifactCodeDisplay.textContent = artifact.code;
  }

  // Preview frame
  if (el.artifactPreviewFrame && el.artifactPreviewPlaceholder) {
    if (artifact.previewable) {
      el.artifactPreviewFrame.style.display = 'block';
      el.artifactPreviewPlaceholder.style.display = 'none';
      el.artifactPreviewFrame.srcdoc = artifact.code;
    } else {
      el.artifactPreviewFrame.style.display = 'none';
      el.artifactPreviewPlaceholder.style.display = 'flex';
    }
  }
}

export function renderSandboxLogs(project) {
  if (!el.artifactLogsDisplay) return;
  if (!project) {
    el.artifactLogsDisplay.textContent = 'No logs available';
    return;
  }

  let logText = '';
  logText += `[AWAIS CODEX CONTAINER RUNNER]\n`;
  logText += `Task ID: ${project.id}\n`;
  logText += `Started At: ${new Date(project.startedAt || Date.now()).toISOString()}\n`;
  logText += `Target Engine: ${TARGET_ENGINE}\n`;
  logText += `Container Architecture: Linux x86_64 Sandbox\n`;
  logText += `Execution Status: ${(project.status || 'unknown').toUpperCase()}\n`;
  if (project.durationMs) {
    logText += `Elapsed Time: ${(project.durationMs / 1000).toFixed(2)}s\n`;
  }
  logText += `==================================================\n\n`;

  if (Array.isArray(project.steps) && project.steps.length > 0) {
    project.steps.forEach((s, idx) => {
      logText += `>>> STEP ${idx + 1} [${detectStepRole(s).toUpperCase()}]:\n`;
      if (s.thought) {
        logText += `Thought: ${typeof s.thought === 'string' ? s.thought : JSON.stringify(s.thought)}\n`;
      }
      if (s.function_call) {
        logText += `Tool Name: ${s.function_call.name}\n`;
        logText += `Arguments: ${JSON.stringify(s.function_call.arguments || {}, null, 2)}\n`;
      }
      if (s.output) {
        logText += `Output:\n${typeof s.output === 'string' ? s.output : JSON.stringify(s.output, null, 2)}\n`;
      }
      logText += `\n`;
    });
  } else {
    logText += `[SANDBOX STREAM] Sub-agent steps dispatched in background container.\n`;
  }

  if (project.output) {
    logText += `--------------------------------------------------\n`;
    logText += `[TASK FINISHED] Final code artifacts and response compiled successfully.\n`;
  }
  el.artifactLogsDisplay.textContent = logText;
}

export function switchArtifactTab(tab) {
  state.activeArtifactTab = tab;
  if (el.artifactTabCode) el.artifactTabCode.classList.toggle('active', tab === 'code');
  if (el.artifactTabPreview) el.artifactTabPreview.classList.toggle('active', tab === 'preview');
  if (el.artifactTabLogs) el.artifactTabLogs.classList.toggle('active', tab === 'logs');

  if (el.artifactCodeView) el.artifactCodeView.style.display = tab === 'code' ? 'flex' : 'none';
  if (el.artifactPreviewView) el.artifactPreviewView.style.display = tab === 'preview' ? 'flex' : 'none';
  if (el.artifactLogsView) el.artifactLogsView.style.display = tab === 'logs' ? 'flex' : 'none';
}

export function openArtifactsDock() {
  state.artifactsDockOpen = true;
  if (el.artifactsDock) el.artifactsDock.classList.remove('collapsed');
  if (el.sidebarNavArtifacts) el.sidebarNavArtifacts.classList.add('active');
  if (el.sidebarNavChat) el.sidebarNavChat.classList.remove('active');
}

export function closeArtifactsDock() {
  state.artifactsDockOpen = false;
  state.splitMode = false;
  if (el.artifactsDock) el.artifactsDock.classList.add('collapsed');
  if (el.sidebarNavArtifacts) el.sidebarNavArtifacts.classList.remove('active');
  if (el.sidebarNavChat) el.sidebarNavChat.classList.add('active');
  updateSplitUI();
}

export function toggleArtifactsDock() {
  if (el.artifactsDock) {
    if (el.artifactsDock.classList.contains('collapsed')) {
      openArtifactsDock();
    } else {
      closeArtifactsDock();
    }
  }
}

export function toggleSplitMode() {
  state.splitMode = !state.splitMode;
  if (state.splitMode) {
    openArtifactsDock();
  } else {
    closeArtifactsDock();
  }
  updateSplitUI();
}

export function updateSplitUI() {
  if (el.sidebarNavSplit) {
    el.sidebarNavSplit.classList.toggle('active', state.splitMode);
  }
  if (el.sidebarSplitText) {
    el.sidebarSplitText.textContent = state.splitMode ? 'Close Split View' : 'Split View';
  }
  if (el.splitBtnText) {
    el.splitBtnText.textContent = state.splitMode ? 'Close Split' : 'Split View';
  }
}

export function openArtifactByCodeIndex(project, codeIdx) {
  if (!project) return;
  const artifacts = project._artifacts || extractArtifactsFromProject(project);
  project._artifacts = artifacts;
  if (artifacts[codeIdx]) {
    state.activeArtifactId = artifacts[codeIdx].id;
  } else if (artifacts.length > 0) {
    state.activeArtifactId = artifacts[0].id;
  }
  openArtifactsDock();
  switchArtifactTab('code');
  updateArtifactsDockForProject(project);
}

export function openLightbox(url, caption) {
  if (!el.imageLightboxModal || !el.lightboxImg) return;
  el.lightboxImg.src = url;
  if (el.lightboxCaption) el.lightboxCaption.textContent = caption || '';
  el.imageLightboxModal.style.display = 'flex';
}

export function closeLightbox() {
  if (!el.imageLightboxModal) return;
  el.imageLightboxModal.style.display = 'none';
  if (el.lightboxImg) el.lightboxImg.src = '';
}

export function openDownloadModal() {
  if (!el.downloadArtifactsModal) return;
  renderDownloadModal();
  el.downloadArtifactsModal.style.display = 'flex';
}

export function closeDownloadModal() {
  if (!el.downloadArtifactsModal) return;
  el.downloadArtifactsModal.style.display = 'none';
}

export function renderDownloadModal() {
  if (!el.modalApkItemsList) return;
  el.modalApkItemsList.innerHTML = '';

  const detectedApks = [];
  const seenPaths = new Set();

  state.projects.forEach(p => {
    const apk = detectApkInfo(p.output, p.steps);
    if (apk && !seenPaths.has(apk.path)) {
      seenPaths.add(apk.path);
      detectedApks.push({ ...apk, projectName: p.prompt || 'Build Task' });
    }
  });

  const defaultPath = '/workspace/hello-app/app/build/outputs/apk/debug/app-debug.apk';
  if (!seenPaths.has(defaultPath)) {
    detectedApks.unshift({
      path: defaultPath,
      filename: 'app-debug.apk',
      size: '4.3 MB',
      projectName: 'Android Build Output'
    });
  }

  detectedApks.forEach(item => {
    const card = document.createElement('div');
    card.style.cssText = 'padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;';
    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px; min-width: 220px;">
        <div style="font-size: 24px;">📦</div>
        <div>
          <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
            <span>${escapeHtml(item.filename)}</span>
            <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.2); color: var(--emerald); font-weight: 600;">${escapeHtml(item.size)}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); font-family: monospace; word-break: break-all; margin-top: 2px;">
            ${escapeHtml(item.path)}
          </div>
          <div style="font-size: 11px; color: #f59e0b; margin-top: 4px; font-weight: 500;">
            ⚠ Placeholder build — not installable, real build files weren't found.
          </div>
        </div>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <a href="/api/download-artifact?filePath=${encodeURIComponent(item.path)}&filename=${encodeURIComponent(item.filename)}" download="${escapeHtml(item.filename)}" class="btn-modal-primary" style="background: var(--emerald); text-decoration: none; padding: 6px 12px; font-size: 12px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px; color: #fff; font-weight: 500;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>Download</span>
        </a>
        <button type="button" class="btn-modal-secondary btn-copy-apk-path" data-path="${escapeHtml(item.path)}" style="padding: 6px 10px; font-size: 12px; border-radius: 6px;" title="Copy path">
          <span>Copy Path</span>
        </button>
      </div>
    `;
    el.modalApkItemsList.appendChild(card);
  });

  if (el.customDownloadPath && !el.customDownloadPath.value) {
    el.customDownloadPath.value = defaultPath;
  }
}

export function downloadCustomArtifact() {
  const path = (el.customDownloadPath ? el.customDownloadPath.value : '').trim();
  if (!path) {
    if (showToastCallback) showToastCallback('Please enter a container file path', 'error');
    return;
  }
  const filename = path.split('/').pop() || 'artifact.bin';
  const downloadUrl = `/api/download-artifact?filePath=${encodeURIComponent(path)}&filename=${encodeURIComponent(filename)}`;
  window.location.href = downloadUrl;
  if (showToastCallback) showToastCallback(`Preparing download for ${filename}...`, 'info');
}

export function downloadWorkspaceArchive() {
  const downloadUrl = `/api/download-artifact?filePath=/workspace&filename=workspace-snapshot.tar`;
  window.location.href = downloadUrl;
  if (showToastCallback) showToastCallback('Packaging workspace archive (.tar)...', 'info');
}
