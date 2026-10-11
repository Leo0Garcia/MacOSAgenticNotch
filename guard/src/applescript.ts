// AppleScript (osascript) checks: sending as Leo, money apps, deletes, security panes.

import { checkBash, MONEY_APPS, type ShellEnv } from "./bash";
import { canDelete, resolvePath } from "./paths";
import { deny, type Denial } from "./rules";

const MESSAGING_APPS = /\b(Messages|Mail|FaceTime|WhatsApp|Telegram|Signal|Slack|Discord|Microsoft Teams|Messenger|Microsoft Outlook|Outlook|Spark|Skype|Zoom)\b/;

function tellsApp(script: string, app: RegExp): string | null {
  for (const m of script.matchAll(/\b(?:tell|application|app)\s+(?:application\s+|app\s+)?"([^"]+)"/gi)) {
    if (app.test(m[1]!)) return m[1]!;
  }
  return null;
}

export function checkAppleScript(script: string, cwd: string | null, env: ShellEnv): Denial | null {
  // do shell script "..." runs a shell command
  for (const m of script.matchAll(/do shell script\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const r = checkBash(m[1]!.replace(/\\(.)/g, "$1"), cwd, { ...env, depth: env.depth + 1 });
    if (r) return r;
  }

  const sender = tellsApp(script, /^(Messages|Mail|Microsoft Outlook|Outlook|Spark)$/i);
  if (sender && /\bsend\b/i.test(script)) {
    return deny("no-contacting-as-leo", `the script tells ${sender} to send a message`);
  }
  if (tellsApp(script, /^FaceTime$/i) || /\bfacetime(-audio)?:/i.test(script)) {
    return deny("no-contacting-as-leo", "the script starts a FaceTime call");
  }
  // UI scripting a messaging app could type and press Return in a chat.
  if (/System Events/i.test(script) && /\b(keystroke|key code|click)\b/i.test(script)) {
    const app = MESSAGING_APPS.exec(script);
    if (app) return deny("no-contacting-as-leo", `the script types or clicks inside ${app[1]}, which could send a message`);
  }

  const money = tellsApp(script, MONEY_APPS);
  if (money) return deny("no-money", `${money} is a banking, payment or trading app`);

  if (/(PrivacySecurity|preference\.security|com\.apple\.settings\.(Security|Privacy|Passwords)|Privacy_|FileVault|Firewall|Login Password|Lock Screen)/i.test(script) &&
      /\b(click|keystroke|key code|set value|reveal|perform action)\b/i.test(script)) {
    return deny("no-harm", "the script changes security or privacy settings");
  }
  if (/Keychain Access|Passwords\.app|tell application "Passwords"/i.test(script)) {
    return deny("no-harm", "the script opens Leo's saved passwords");
  }

  // Finder delete / empty trash
  if (/\bempty\b[^"\n]*\btrash\b/i.test(script)) {
    return deny("no-harm", "emptying the Trash deletes files permanently");
  }
  if (tellsApp(script, /^Finder$/i) && /\b(delete|move\b[^\n]*\bto trash)\b/i.test(script)) {
    const paths = [...script.matchAll(/POSIX file\s+"([^"]+)"/gi)].map((m) => m[1]!);
    if (paths.length === 0) return deny("no-harm", "the script deletes files in Finder that can't be checked against the allowlist");
    for (const p of paths) {
      const abs = resolvePath(p, cwd, env.ctx);
      if (!abs || !canDelete(abs, env.ctx)) {
        return deny("no-harm", `the script deletes ${p}, which isn't inside ~/Jarvis or the Jarvis repo`);
      }
    }
  }
  return null;
}
