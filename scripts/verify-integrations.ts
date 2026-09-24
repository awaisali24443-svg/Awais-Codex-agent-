/**
 * `npm run verify` — prove the credentials work, from somewhere with internet.
 *
 * The app can store a key and report that it is stored. Only the provider can
 * say whether it works, and only from a machine that can reach them: this
 * sandbox's own firewall allows github.com and the npm registry and nothing
 * else, so this script exists to be run where the app actually lives — a laptop,
 * a Render shell, or the "Verify integrations" GitHub workflow.
 *
 * Usage:
 *
 *   npm run verify                          # key + agent + WhatsApp token (read-only)
 *   npm run verify -- --send                # ...and put a test message in the chat
 *   npm run verify -- --send --text "hi"     # with your own wording
 *   npm run verify -- --whatsapp-only        # skip the mission (spends no run)
 *   npm run verify -- --prompt "say ready"   # a different smoke-test prompt
 *
 * Reads: GEMINI_API_KEY, WHATSAPP_TOKEN, GITHUB_TOKEN, ANTIGRAVITY_AGENT,
 *        ANTIGRAVITY_API_BASE, WHATSAPP_API_BASE — the same names the app uses.
 *
 * Exits 0 when every check that ran passed, 1 otherwise, so it is usable as a
 * gate in a workflow.
 */
import {
  DEFAULT_AGENT,
  checkAgent,
  checkGeminiKey,
  checkGitHubToken,
  checkWhatsAppToken,
  formatReport,
  hasFailure,
  sendWhatsAppTestMessage,
  type CheckResult,
} from '../server/verify.js';

interface Args {
  whatsappOnly: boolean;
  agentOnly: boolean;
  keyOnly: boolean;
  githubOnly: boolean;
  send: boolean;
  text?: string;
  prompt?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    whatsappOnly: false,
    agentOnly: false,
    keyOnly: false,
    githubOnly: false,
    send: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string | undefined => argv[i + 1]?.startsWith('--') ? undefined : argv[++i];

    switch (arg) {
      case '--whatsapp-only':
        args.whatsappOnly = true;
        break;
      case '--agent-only':
        args.agentOnly = true;
        break;
      case '--key-only':
        // The cheap check: one GET, no mission, no WhatsApp. For "did the key
        // survive being pasted" without spending a run.
        args.keyOnly = true;
        break;
      case '--github-only':
        args.githubOnly = true;
        break;
      case '--send':
        args.send = true;
        break;
      case '--text':
        args.text = next();
        break;
      case '--prompt':
        args.prompt = next();
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          args.help = true;
        }
    }
  }

  return args;
}

const HELP = `npm run verify — check the credentials against the real providers

  --key-only          only the Gemini key: one GET, no task (spends nothing)
  --agent-only        the key and the agent, no WhatsApp (spends one run)
  --whatsapp-only     only the WhatsApp token (no task, spends nothing)
  --github-only       only the GitHub token (no task, spends nothing)
  --send              also send a test message into the agent's chat
  --text "..."        wording for that message
  --prompt "..."      prompt for the smoke-test task
  --json              machine-readable output
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(process.argv.includes('--help') || process.argv.includes('-h') ? 0 : 2);
  }

  const geminiApiKey = (process.env.GEMINI_API_KEY ?? '').trim();
  const whatsappToken = (process.env.WHATSAPP_TOKEN ?? '').trim();
  const githubToken = (process.env.GITHUB_TOKEN ?? '').trim();
  const agent = (process.env.ANTIGRAVITY_AGENT ?? DEFAULT_AGENT).trim();

  if (!geminiApiKey && !whatsappToken && !githubToken) {
    console.error(
      'Neither GEMINI_API_KEY, WHATSAPP_TOKEN nor GITHUB_TOKEN is set. Nothing to verify.\n\n' + HELP,
    );
    process.exit(2);
  }

  if (!args.json) {
    // Say which key is being tried, by fingerprint — never the key.
    const { identify } = await import('../server/verify.js');
    console.log(`[verify] agent:      ${agent}`);
    if (geminiApiKey) console.log(`[verify] gemini key: ${identify(geminiApiKey)}`);
    if (whatsappToken) console.log(`[verify] whatsapp:   ${identify(whatsappToken)}`);
    if (githubToken) console.log(`[verify] github:     ${identify(githubToken)}`);
    console.log('[verify] each check calls the provider; nothing is simulated\n');
  }

  const results: CheckResult[] = [];

  if (args.githubOnly) {
    results.push(await checkGitHubToken({ token: githubToken }));
  } else if (!args.whatsappOnly && !args.keyOnly) {
    results.push(
      await checkGeminiKey({
        apiKey: geminiApiKey,
        apiBase: process.env.ANTIGRAVITY_API_BASE || undefined,
      }),
    );

    // Skip the mission when the key is already known bad: it would only fail
    // again, and a failed mission is still a run nobody gets back.
    const keyWorks = results[results.length - 1].verdict === 'ok';
    if (keyWorks) {
      results.push(
        await checkAgent({
          apiKey: geminiApiKey,
          agent,
          apiBase: process.env.ANTIGRAVITY_API_BASE || undefined,
          prompt: args.prompt,
        }),
      );
    }
  }

  if (args.githubOnly) {
    // handled above; nothing else runs
  } else if (args.keyOnly) {
    results.push(
      await checkGeminiKey({
        apiKey: geminiApiKey,
        apiBase: process.env.ANTIGRAVITY_API_BASE || undefined,
      }),
    );
  } else if (!args.agentOnly) {
    results.push(
      await checkWhatsAppToken({
        token: whatsappToken,
        baseUrl: process.env.WHATSAPP_API_BASE || undefined,
      }),
    );

    if (args.send && results[results.length - 1].verdict === 'ok') {
      results.push(
        await sendWhatsAppTestMessage({
          token: whatsappToken,
          baseUrl: process.env.WHATSAPP_API_BASE || undefined,
          text: args.text,
        }),
      );
    }
  }

  // The GitHub PAT check is read-only (owner resolution); exporting is
  // exercised through the app's own /api/github/* routes.
  if (!args.githubOnly && githubToken) {
    results.push(await checkGitHubToken({ token: githubToken }));
  }

  if (args.json) {
    console.log(JSON.stringify({ agent, results }, null, 2));
  } else {
    console.log(formatReport(results));
  }

  if (hasFailure(results)) process.exit(1);
  if (results.every((result) => result.verdict === 'not_configured')) process.exit(2);
}

main().catch((err: unknown) => {
  console.error('[verify] unexpected failure:', err instanceof Error ? err.message : err);
  process.exit(1);
});
