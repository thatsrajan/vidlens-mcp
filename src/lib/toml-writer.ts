export type TomlValue = string | number | boolean | string[] | number[] | boolean[];

export function renderToml(tables: Record<string, Record<string, TomlValue>>): string {
  const lines: string[] = [];
  for (const [tableName, values] of Object.entries(tables)) {
    lines.push(`[${tableName}]`);
    for (const [key, value] of Object.entries(values)) {
      lines.push(`${key} = ${formatTomlValue(value)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function mergeTomlTables(
  existingText: string | undefined,
  tables: Record<string, Record<string, TomlValue>>,
): string {
  const existing = existingText?.trimEnd();
  const rendered = renderToml(tables).trimEnd();
  if (!existing) {
    return `${rendered}\n`;
  }

  const filtered = removeTables(existing, Object.keys(tables));
  return `${filtered.trimEnd()}\n\n${rendered}\n`;
}

function removeTables(input: string, tableNames: string[]): string {
  const targets = new Set(tableNames);
  const lines = input.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    // Match a table header, tolerating whitespace inside the brackets
    // (`[ table ]`) and a trailing comment (`[table] # note`).
    const match = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
    if (match) {
      skipping = targets.has(match[1]!);
    }
    if (!skipping) {
      output.push(line);
    }
  }
  return output.join("\n");
}

function formatTomlValue(value: TomlValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(formatTomlValue).join(", ")}]`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}
