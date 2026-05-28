const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|COOKIE|COOKIES|AUTH|CREDENTIAL)/i;

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 4) {
      continue;
    }
    if (!SECRET_KEY_PATTERN.test(key)) {
      continue;
    }
    output = replaceAllLiteral(output, value, "[redacted]");
  }

  output = output.replace(/^Cookie:\s*.*$/gim, "Cookie: [redacted]");
  output = output.replace(/^Set-Cookie:\s*.*$/gim, "Set-Cookie: [redacted]");
  output = output.replace(/(cookie(?:s)?=)[^\s;&]+/gi, "$1[redacted]");
  output = output.replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, "$1[redacted]");
  return output;
}

export function redactError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, env);
}

function replaceAllLiteral(input: string, needle: string, replacement: string): string {
  return input.split(needle).join(replacement);
}
