import fsp from 'node:fs/promises';

interface TranscriptLine {
  role?: string;
  content?: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

async function readLines(path: string): Promise<TranscriptLine[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const out: TranscriptLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TranscriptLine);
    } catch {
      continue;
    }
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

export async function readFirstUserMessage(transcriptPath: string): Promise<string | null> {
  const lines = await readLines(transcriptPath);
  for (const l of lines) {
    if (l.role === 'user') {
      const t = extractText(l.content);
      if (t) return t;
    }
  }
  return null;
}

export async function readLastAssistantText(transcriptPath: string): Promise<string | null> {
  const lines = await readLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'assistant') {
      const t = extractText(lines[i].content);
      if (t) return t;
    }
  }
  return null;
}
