// Speaks sentences one after another through `say` (phase 1 TTS). With
// JARVIS_SAY="" the launcher stays silent and the app speaks from the
// `speak` events on stdout instead.

export class Speaker {
  private queue: Promise<void> = Promise.resolve();

  constructor(private cmd: string | null) {}

  say(text: string): void {
    if (!this.cmd || !text) return;
    const cmd = this.cmd;
    this.queue = this.queue.then(async () => {
      try {
        await Bun.spawn([cmd, text], { stdout: "ignore", stderr: "ignore" }).exited;
      } catch {
        // No TTS available: the text is still on stdout for the app.
      }
    });
  }

  /** Resolves when everything queued has been spoken. */
  drain(): Promise<void> {
    return this.queue;
  }
}
