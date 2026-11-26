// 指令列參數：--key value、--key=value、--flag。不收未知旗標（打錯字不能被默默吞掉）。

export interface ParsedArgs { positional: string[]; flags: Record<string, string | true> }

export function parseArgs(argv: readonly string[], spec: { values: readonly string[]; booleans: readonly string[] }): ParsedArgs | { error: string } {
  const values = new Set(spec.values);
  const booleans = new Set(spec.booleans);
  const out: ParsedArgs = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq === -1 ? undefined : eq);
    if (booleans.has(key)) {
      if (eq !== -1) return { error: `--${key} does not take a value` };
      out.flags[key] = true;
    } else if (values.has(key)) {
      const v = eq !== -1 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || (eq === -1 && v.startsWith('--'))) return { error: `--${key} needs a value` };
      out.flags[key] = v;
    } else return { error: `unknown option --${key}` };
  }
  return out;
}
