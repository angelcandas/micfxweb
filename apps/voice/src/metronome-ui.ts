// The click, the tempo and the count-in, beside the recorder (plan section 9, point 3). The
// tempo is the looper's: setting or tapping it here sets the looper's too.

export interface MetronomeHooks {
  metronome(): { on: boolean; countIn: number; volume: number; bpm: number; beatsPerBar: number; countingIn: number };
  setMetronome(settings: { on?: boolean; countIn?: number; volume?: number }): void;
  setTempo(bpm: number): void;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function addMetronome(hooks: MetronomeHooks) {
  const anchor = document.querySelector("footer.recorder .record-dry");
  if (!anchor || document.querySelector(".web-metronome")) return;
  const group = html("div", "web-metronome");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Click and count-in");

  const click = html("button", "pill web-click");
  click.type = "button";
  click.title = "A click on the beat while you sing (you hear it; takes don't have it)";
  click.append(html("span", "switch"), html("span", "", "Click"));
  click.addEventListener("click", () => {
    hooks.setMetronome({ on: !hooks.metronome().on });
    render();
  });

  const bpm = Object.assign(html("input", "web-bpm"), { type: "number", min: "30", max: "300", step: "0.5" });
  bpm.setAttribute("aria-label", "Tempo (BPM)");
  bpm.title = "Tempo in beats per minute (the looper's tempo too)";
  bpm.addEventListener("change", () => {
    hooks.setTempo(Number(bpm.value) || 120);
    render();
  });
  const bpmField = html("label", "web-bpm-field");
  bpmField.append(bpm, html("span", "", "BPM"));

  const taps: number[] = [];
  const tap = html("button", "text-button web-tap", "Tap");
  tap.type = "button";
  tap.title = "Tap the beat a few times to set the tempo";
  tap.addEventListener("click", () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1]! > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 6) taps.shift();
    if (taps.length >= 2) {
      const gap = (taps[taps.length - 1]! - taps[0]!) / (taps.length - 1);
      hooks.setTempo(Math.round((60000 / gap) * 2) / 2);
      render();
    }
  });

  const countIn = html("select", "dropdown web-count-in");
  countIn.setAttribute("aria-label", "Count-in before a take");
  countIn.title = "Clicks before a take starts: the take begins on the next bar's first beat";
  for (const [value, label] of [["0", "No count-in"], ["1", "Count-in: 1 bar"], ["2", "Count-in: 2 bars"]]) countIn.append(new Option(label, value));
  countIn.addEventListener("change", () => hooks.setMetronome({ countIn: Number(countIn.value) }));

  const counting = html("span", "web-counting");
  counting.setAttribute("aria-live", "assertive");

  group.append(click, bpmField, tap, countIn, counting);
  anchor.after(group);

  const render = () => {
    const state = hooks.metronome();
    click.setAttribute("aria-pressed", String(state.on));
    if (document.activeElement !== bpm) bpm.value = String(state.bpm);
    countIn.value = String(state.countIn);
    const text = state.countingIn > 0 ? `${state.countingIn}…` : "";
    if (counting.textContent !== text) counting.textContent = text;
    counting.hidden = !text;
  };
  render();
  setInterval(render, 100);
}
