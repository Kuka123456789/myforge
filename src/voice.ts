// Voice transcription via Cloudflare Workers AI Whisper.
// No external API key needed — billed against the Cloudflare account.

interface AiWhisperResult {
  text: string;
}

interface WorkersAi {
  run(model: string, input: { audio: number[] }): Promise<AiWhisperResult>;
}

export async function transcribeVoice(ai: WorkersAi, bytes: ArrayBuffer): Promise<string> {
  // Workers AI Whisper accepts an array of bytes.
  const input = Array.from(new Uint8Array(bytes));
  const result = await ai.run('@cf/openai/whisper', { audio: input });
  return result.text?.trim() ?? '';
}
