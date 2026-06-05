import { describe, it, expect } from 'vitest';
import { submitLikelyDropped } from './control-tools.js';

// Cold-start submit-drop detector (prompt_pane self-heal). The signature of a
// dropped submit is: the turn settled, but the only thing that came back was our
// own keystrokes echoed into the input box — no reply followed.
describe('submitLikelyDropped', () => {
  const TEXT = 'hey there, what are you working on?';

  it('flags a dropped submit: delta is just the echo + a little status chrome', () => {
    // What the pane emits when the CR is swallowed: the text redrawn in the input
    // box, plus the status line repainting. No assistant reply.
    const delta = `❯ ${TEXT}\n  [Sonnet 4.6 high] Admin | ctx 0%  ⏵⏵ auto mode on`;
    expect(submitLikelyDropped(delta, TEXT, true, false)).toBe(true);
  });

  it('does NOT flag a real turn: the reply dwarfs the echo', () => {
    const reply =
      'I am refactoring the auth middleware to pull the token verification into a ' +
      'shared helper so the three route handlers stop duplicating it. About halfway.';
    const delta = `❯ ${TEXT}\n● ${reply}`;
    expect(submitLikelyDropped(delta, TEXT, true, false)).toBe(false);
  });

  it('never flags a still-working agent (timedOut ⇒ output never went quiet)', () => {
    const delta = `❯ ${TEXT}\n● `; // reply has begun but not settled
    expect(submitLikelyDropped(delta, TEXT, false, true)).toBe(false);
  });

  it('never flags an unsettled read', () => {
    const delta = `❯ ${TEXT}`;
    expect(submitLikelyDropped(delta, TEXT, false, false)).toBe(false);
  });

  it('is robust to the echo wrapping / box-drawing noise inside the typed text', () => {
    // The TUI can interleave border glyphs and newlines as it wraps a long line;
    // normalizing to alphanumerics still recognizes the echo as our own text.
    const wrapped = '❯ hey there, what are\n  │ working on?'; // mangled echo, no reply
    expect(submitLikelyDropped(wrapped, TEXT, true, false)).toBe(true);
  });
});
