/**
 * A deterministic signature of a TestFlight crash log, to group the same crash across testers and builds
 * (docs/api/testflight-feedback.md#crash-grouping). The rule is deliberately small and written down:
 *
 * 1. the exception is the value of the first `Exception Type:` line (`EXC_BAD_ACCESS (SIGSEGV)`), spaces collapsed, at most 80 characters;
 * 2. the crashed thread is the one whose header says `Thread N Crashed`, else the one `Triggered by Thread: N` names;
 * 3. the top frame is the FIRST frame of that thread, `<index> <image> <address> <symbol> [+ offset]`: its image and symbol, with the offset,
 *    a trailing `(File.swift:12)` and hexadecimal numbers removed. A frame whose symbol is only an address (not symbolicated) is the image alone,
 *    and `symbolicated` is false: the log is never claimed to be symbolicated, the frame is only told so.
 *
 * The layout is Apple's usual `.crash` text. It is UNVERIFIED for TestFlight's `logText`; a log in any other layout gives `null`
 * (grouped by build only). The signature never contains tester data: only the exception and a code location.
 */

export type CrashSignature = {
  /** The grouping key: exception and top frame, at most 200 characters. */
  key: string;
  exception: string | null;
  frame: string | null;
  /** False when the top frame is an address, true when it has a symbol; null when no frame was found. */
  symbolicated: boolean | null;
};

const clip = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;
const FRAME = /^\s*\d+\s+(\S.*?)\s+(0x[0-9a-fA-F]+)\s+(.*?)\s*$/;

export function crashSignature(logText: string): CrashSignature | null {
  if (typeof logText !== 'string' || logText === '') return null;
  const lines = logText.split(/\r?\n/);

  let exception: string | null = null;
  for (const line of lines) {
    const m = /^\s*Exception Type:\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) {
      exception = clip(m[1].replace(/\s+/g, ' '), 80);
      break;
    }
  }

  let start = lines.findIndex((l) => /^\s*Thread\s+\d+\s+Crashed\b/.test(l));
  if (start < 0) {
    const triggered = lines
      .map((l) => /^\s*Triggered by Thread:\s*(\d+)/.exec(l)?.[1])
      .find((n) => n !== undefined);
    if (triggered !== undefined) {
      start = lines.findIndex((l) => new RegExp(`^\\s*Thread\\s+${triggered}\\b.*:\\s*$`).test(l));
    }
  }

  let image: string | null = null;
  let symbol: string | null = null;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '') break;
      const m = FRAME.exec(line);
      if (!m) continue;
      image = clip((m[1] ?? '').trim(), 80);
      let rest = (m[3] ?? '').trim();
      rest = rest.replace(/\s+\([^()\s]+:\d+\)\s*$/, '').replace(/\s+\+\s+\d+\s*$/, '');
      rest = rest
        .replace(/0x[0-9a-fA-F]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      symbol = rest === '' ? null : clip(rest, 120);
      break;
    }
  }

  if (exception === null && image === null) return null;
  const frame = image === null ? null : symbol === null ? image : `${image} ${symbol}`;
  const key = clip(`${exception ?? 'unknown'} | ${frame ?? 'unknown'}`, 200);
  return { key, exception, frame, symbolicated: image === null ? null : symbol !== null };
}
