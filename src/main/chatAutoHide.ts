/**
 * Hides the room chat window `hideAfterMs()` after the last reason to show it (a new line, the pointer leaving it, the
 * keyboard leaving it). Never while the pointer is over it or it has the keyboard. 0 = never hide by itself.
 */
export class ChatAutoHide {
  private timer: NodeJS.Timeout | null = null;
  private focused = false;
  private hovered = false;

  constructor(private readonly deps: { hideAfterMs(): number; hide(): void }) {}

  /** A line came in, or the window was just shown: the countdown starts again. */
  restart(): void {
    this.cancel();
    if (this.focused || this.hovered) return;
    const ms = this.deps.hideAfterMs();
    if (ms <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.hide();
    }, ms);
  }

  setFocused(on: boolean): void {
    this.focused = on;
    if (on) this.cancel();
    else this.restart();
  }

  setHovered(on: boolean): void {
    this.hovered = on;
    if (on) this.cancel();
    else this.restart();
  }

  /** The window was hidden or closed: nothing is pending, and it starts out neither focused nor hovered next time. */
  stop(): void {
    this.cancel();
    this.focused = false;
    this.hovered = false;
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
