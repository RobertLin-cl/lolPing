// An unconnected active worklet prevents Chromium from suspending an interactive audio sink during silence.
class KeepOutputActive extends AudioWorkletProcessor {
  process() {
    return true;
  }
}

registerProcessor('keep-output-active', KeepOutputActive);
