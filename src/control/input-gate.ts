/**
 * `send_input` is the sharp edge: it types into live shells. It is gated three
 * ways and is NEVER on by default (see README "send_input safety model"):
 *
 *   1. App-side: hyperpanes returns 403 unless "Allow agent control → input"
 *      (`allowInput`) is toggled on. Enforced server-side; we can't bypass it.
 *   2. Bridge opt-in (this allowlist): HYPERPANES_ALLOW_INPUT=1 must be set on
 *      the MCP server's environment, or send_input refuses before any request.
 *   3. Per-call confirmation: every send_input call must pass `confirm: true`.
 *
 * Optionally, HYPERPANES_INPUT_ALLOWLIST (comma-separated pane ids or labels)
 * restricts input to specific panes.
 */
export interface InputGate {
  optIn: boolean;
  allowlist: string[] | null;
}

export function readInputGate(env: NodeJS.ProcessEnv = process.env): InputGate {
  const flag = (env.HYPERPANES_ALLOW_INPUT ?? '').trim().toLowerCase();
  const optIn = flag === '1' || flag === 'true' || flag === 'yes';
  const rawList = (env.HYPERPANES_INPUT_ALLOWLIST ?? '').trim();
  const allowlist = rawList
    ? rawList.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  return { optIn, allowlist };
}

export type GateDecision = { ok: true } | { ok: false; reason: string };

export function checkInputAllowed(
  gate: InputGate,
  args: { confirm?: boolean },
  pane: { id: string; label: string }
): GateDecision {
  if (!gate.optIn) {
    return {
      ok: false,
      reason:
        'send_input is disabled on this MCP bridge. Set HYPERPANES_ALLOW_INPUT=1 in the server environment to permit it (and enable input in hyperpanes Preferences).'
    };
  }
  if (args.confirm !== true) {
    return {
      ok: false,
      reason: 'send_input requires explicit per-call confirmation — pass confirm=true.'
    };
  }
  if (gate.allowlist && !(gate.allowlist.includes(pane.id) || gate.allowlist.includes(pane.label))) {
    return {
      ok: false,
      reason: `pane "${pane.label}" (${pane.id}) is not in HYPERPANES_INPUT_ALLOWLIST.`
    };
  }
  return { ok: true };
}
