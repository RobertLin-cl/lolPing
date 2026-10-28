/**
 * Shows the room panel only once its key has been held for `holdMs()`, so a quick tap is just a key press in the app
 * underneath (the helper lets the key through). 0 shows it at once.
 */
export class PanelHold {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: { holdMs(): number; show(): void; hide(): void }) {}

  /** The key went down. The helper reports each press once, never its repeats. */
  down(): void {
    this.cancel();
    const ms = this.deps.holdMs();
    if (ms <= 0) {
      this.deps.show();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.show();
    }, ms);
  }

  /** The key came up, or the panel has to go now: a show still waiting is dropped and a shown panel hides. */
  up(): void {
    this.cancel();
    this.deps.hide();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
