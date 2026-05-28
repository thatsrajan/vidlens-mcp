export function ensureUsefulTranscriptText(text: string, provider: string): string {
  const normalized = text.trim();
  if (!normalized || isPlaceholderTranscript(normalized)) {
    throw new Error(`${provider} STT returned no usable transcript text.`);
  }
  return normalized;
}

function isPlaceholderTranscript(text: string): boolean {
  return /^(?:\[?\s*)?transcription(?:\s*\]?)?$/i.test(text);
}
