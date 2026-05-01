#!/usr/bin/env tsx
/**
 * Spec R M3 — analyze promptfoo eval results, compute pairwise overlap +
 * cross-lineage delta, generate delta-report.md.
 *
 * Usage:
 *   npx tsx analyze.ts results/eval-v1.json
 *   npx tsx analyze.ts results/eval-v1.json --out results/delta-report.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

// ─── Domain types ──────────────────────────────────────────────────────────

type Severity = 'P0' | 'P1' | 'P2';
type Category =
  | 'bug'
  | 'security'
  | 'spec'
  | 'convention'
  | 'silent-failure'
  | 'performance'
  | 'test-gap';

interface Finding {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  summary: string;
}

interface ParsedReview {
  findings: Finding[];
  verdict?: string;
  parseError?: string;
}

interface ProviderReview {
  provider: string;
  lineage: string;
  pr: string;
  success: boolean;
  parseError?: string;
  rawOutput?: string;
  findings: Finding[];
}

// ─── Promptfoo result shape (subset) ───────────────────────────────────────

interface PfResult {
  provider: { id: string; label?: string };
  testCase: { description: string; vars?: Record<string, unknown> };
  response?: { output?: string; error?: string };
  success: boolean;
  failureReason?: string;
  error?: string;
  score?: number;
}

interface PfFile {
  evalId?: string;
  results: { results: PfResult[]; stats?: unknown };
}

// ─── Lineage mapping ───────────────────────────────────────────────────────

// Caveat: copilot wraps an undisclosed model (often claude-sonnet) so its
// "lineage" is reported as wrapped/Anthropic-leaning but kept distinct from
// the direct claude-* CLI providers in the lineage delta calc.
// Promptfoo overwrites the YAML `label` for file:// providers with the file
// URL. We map both shapes (clean YAML label and file:// path) to lineages so
// downstream analysis is robust regardless of how promptfoo serializes.
const LINEAGE: Record<string, string> = {
  // Clean YAML labels (kept for direct use elsewhere)
  'cli-claude-sonnet-4-6': 'Anthropic',
  'cli-claude-opus-4-7': 'Anthropic',
  'cli-codex-default': 'OpenAI',
  'cli-gemini-default': 'Google',
  'cli-copilot-default': 'GitHub-wrapped',
  // File:// IDs (what promptfoo actually serializes)
  'file://providers/cli-claude-sonnet.cjs': 'Anthropic',
  'file://providers/cli-claude-opus.cjs': 'Anthropic',
  'file://providers/cli-codex.cjs': 'OpenAI',
  'file://providers/cli-gemini.cjs': 'Google',
  'file://providers/cli-copilot.cjs': 'GitHub-wrapped',
  // Zen + Ollama use the YAML label correctly
  'zen-kimi-k2.6': 'Moonshot',
  'zen-minimax-m2.7': 'Minimax',
  'zen-glm-5': 'Zhipu',
  'ollama-deepseek-coder-6.7b': 'DeepSeek',
  'ollama-qwen2.5-coder': 'Alibaba',
  // Legacy labels (older smoke runs)
  'ollama-qwen2.5-coder-7b': 'Alibaba',
  'ollama-llama3.1-8b': 'Meta',
  'ollama-llama3.3-70b': 'Meta',
};

// Friendlier display names for file:// IDs.
const DISPLAY_NAME: Record<string, string> = {
  'file://providers/cli-claude-sonnet.cjs': 'cli-claude-sonnet-4-6',
  'file://providers/cli-claude-opus.cjs': 'cli-claude-opus-4-7',
  'file://providers/cli-codex.cjs': 'cli-codex',
  'file://providers/cli-gemini.cjs': 'cli-gemini',
  'file://providers/cli-copilot.cjs': 'cli-copilot',
};

function getLineage(label: string): string {
  return LINEAGE[label] ?? 'Unknown';
}

function getDisplayName(idOrLabel: string): string {
  return DISPLAY_NAME[idOrLabel] ?? idOrLabel;
}

// ─── JSON extraction (matches the promptfoo assertion regex) ───────────────

function extractReview(rawOutput: string | undefined): ParsedReview {
  if (!rawOutput) return { findings: [], parseError: 'empty output' };

  // Strip markdown fences and find first balanced {...} block.
  const match = rawOutput.match(/\{[\s\S]*\}/);
  if (!match) return { findings: [], parseError: 'no JSON block found' };

  try {
    const obj = JSON.parse(match[0]);
    const findings: Finding[] = Array.isArray(obj.findings)
      ? obj.findings
          .map((f: Record<string, unknown>) => ({
            file: String(f.file ?? '').trim(),
            line: Number(f.line ?? 0),
            severity: ((f.severity as string) ?? 'P2').toUpperCase() as Severity,
            category: ((f.category as string) ?? 'bug').toLowerCase() as Category,
            summary: String(f.summary ?? '').trim(),
          }))
          .filter((f: Finding) => f.file.length > 0)
      : [];
    return { findings, verdict: obj.verdict };
  } catch (e) {
    return {
      findings: [],
      parseError: `JSON parse: ${(e as Error).message}`,
    };
  }
}

// ─── Pairwise matching ─────────────────────────────────────────────────────

const LINE_WINDOW = 3;

function findingsMatch(a: Finding, b: Finding): boolean {
  return (
    a.file === b.file &&
    a.category === b.category &&
    Math.abs(a.line - b.line) <= LINE_WINDOW
  );
}

/**
 * Greedy bipartite match between two finding sets — each finding in A
 * pairs with at most one finding in B.
 * Returns number of matched pairs.
 */
function intersectionCount(a: Finding[], b: Finding[]): number {
  const used = new Set<number>();
  let matched = 0;
  for (const fa of a) {
    for (let i = 0; i < b.length; i++) {
      if (used.has(i)) continue;
      if (findingsMatch(fa, b[i])) {
        used.add(i);
        matched++;
        break;
      }
    }
  }
  return matched;
}

function jaccard(a: Finding[], b: Finding[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const inter = intersectionCount(a, b);
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Union of finding sets — dedupe by greedy match. Order of input matters
 * marginally (greedy), so for the cross-lineage union we sort by lineage
 * name for stability.
 */
function findingsUnion(sets: Finding[][]): Finding[] {
  const result: Finding[] = [];
  for (const set of sets) {
    for (const f of set) {
      if (!result.some((existing) => findingsMatch(f, existing))) {
        result.push(f);
      }
    }
  }
  return result;
}

// ─── Aggregation ───────────────────────────────────────────────────────────

function loadResults(jsonPath: string): ProviderReview[] {
  const raw = readFileSync(jsonPath, 'utf-8');
  const parsed = JSON.parse(raw) as PfFile;
  const out: ProviderReview[] = [];

  for (const r of parsed.results.results) {
    // Use label when promptfoo preserved the YAML label (zen/ollama do this);
    // fall back to id when label was overwritten with the file URL (file://
    // providers). Either way the value is a stable per-instance key.
    const provider =
      r.provider.label && r.provider.label !== r.provider.id
        ? r.provider.label
        : r.provider.id;
    const description = r.testCase.description ?? '';
    const prMatch = description.match(/PR #(\d+)/);
    const pr = prMatch ? `#${prMatch[1]}` : description.slice(0, 24);

    if (!r.success) {
      const reason = r.failureReason ?? r.error ?? r.response?.error ?? 'unknown';
      out.push({
        provider,
        lineage: getLineage(provider),
        pr,
        success: false,
        parseError:
          typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 80),
        findings: [],
      });
      continue;
    }

    const review = extractReview(r.response?.output);
    out.push({
      provider,
      lineage: getLineage(provider),
      pr,
      success: review.parseError === undefined,
      parseError: review.parseError,
      rawOutput: r.response?.output,
      findings: review.findings,
    });
  }

  return out;
}

// ─── Report rendering ──────────────────────────────────────────────────────

function severityCounts(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const f of findings) {
    if (f.severity === 'P0') c.P0++;
    else if (f.severity === 'P1') c.P1++;
    else c.P2++;
  }
  return c;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function renderPerProviderTable(reviews: ProviderReview[], pr: string): string {
  const rs = reviews.filter((r) => r.pr === pr);
  if (rs.length === 0) return '';

  const lines: string[] = [];
  lines.push(`### ${pr} per-provider findings`);
  lines.push('');
  lines.push('| Provider | Lineage | Status | Findings | P0 | P1 | P2 |');
  lines.push('|---|---|---|---:|---:|---:|---:|');

  for (const r of rs.sort((a, b) => a.lineage.localeCompare(b.lineage))) {
    const sev = severityCounts(r.findings);
    const status = r.success
      ? '✓'
      : r.parseError
        ? `✗ ${String(r.parseError).slice(0, 30)}`
        : '✗';
    lines.push(
      `| ${getDisplayName(r.provider)} | ${r.lineage} | ${status} | ${r.findings.length} | ${sev.P0} | ${sev.P1} | ${sev.P2} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderJaccardMatrix(reviews: ProviderReview[], pr: string): string {
  const rs = reviews.filter((r) => r.pr === pr && r.success && r.findings.length > 0);
  if (rs.length < 2) return '';

  const lines: string[] = [];
  lines.push(`### ${pr} Jaccard overlap (file + line±${LINE_WINDOW} + category)`);
  lines.push('');
  const labels = rs.map((r) =>
    getDisplayName(r.provider).replace(/^cli-|^zen-|^ollama-/, ''),
  );
  lines.push('| | ' + labels.join(' | ') + ' |');
  lines.push('|---|' + labels.map(() => '---:').join('|') + '|');
  for (let i = 0; i < rs.length; i++) {
    const row: string[] = [labels[i]];
    for (let j = 0; j < rs.length; j++) {
      if (i === j) row.push('—');
      else row.push(jaccard(rs[i].findings, rs[j].findings).toFixed(2));
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }
  lines.push('');
  return lines.join('\n');
}

function renderLineageDelta(reviews: ProviderReview[]): string {
  const lines: string[] = [];
  lines.push('## Cross-lineage delta — H1 vs H0');
  lines.push('');
  lines.push(
    'H1 hypothesis: cross-lineage union adds ≥20% unique P0/P1 findings vs Claude-only baseline.',
  );
  lines.push('');

  const prs = [...new Set(reviews.map((r) => r.pr))];
  lines.push('| PR | Anthropic-only union | Cross-lineage union | Δ findings | Δ P0/P1 | Verdict |');
  lines.push('|---|---:|---:|---:|---:|---|');

  let totalAnthropic = 0;
  let totalCross = 0;
  let totalAnthropicCritical = 0;
  let totalCrossCritical = 0;

  for (const pr of prs) {
    const rs = reviews.filter((r) => r.pr === pr && r.success);
    const anthropicSets = rs
      .filter((r) => r.lineage === 'Anthropic')
      .map((r) => r.findings);
    const allSets = rs.map((r) => r.findings);

    const anthropicUnion = findingsUnion(anthropicSets);
    const crossUnion = findingsUnion(allSets);

    const aCrit = anthropicUnion.filter((f) => f.severity === 'P0' || f.severity === 'P1').length;
    const cCrit = crossUnion.filter((f) => f.severity === 'P0' || f.severity === 'P1').length;

    totalAnthropic += anthropicUnion.length;
    totalCross += crossUnion.length;
    totalAnthropicCritical += aCrit;
    totalCrossCritical += cCrit;

    const dF = crossUnion.length - anthropicUnion.length;
    const dCrit = cCrit - aCrit;
    const pct = anthropicUnion.length === 0 ? '—' : `${((dF / anthropicUnion.length) * 100).toFixed(0)}%`;
    const critPct = aCrit === 0 ? '—' : `${((dCrit / aCrit) * 100).toFixed(0)}%`;
    const verdict = aCrit > 0 && dCrit / aCrit >= 0.2 ? '⊕ H1' : 'H0';
    lines.push(`| ${pr} | ${anthropicUnion.length} | ${crossUnion.length} | +${dF} (${pct}) | +${dCrit} (${critPct}) | ${verdict} |`);
  }

  lines.push('');
  const totalCritDelta = totalCrossCritical - totalAnthropicCritical;
  const totalPct = totalAnthropicCritical === 0 ? 0 : totalCritDelta / totalAnthropicCritical;
  lines.push(`**Aggregate**: cross-lineage adds **+${totalCross - totalAnthropic} findings** (vs Anthropic union ${totalAnthropic}), of which **+${totalCritDelta} P0/P1** (${(totalPct * 100).toFixed(0)}% over Anthropic critical baseline).`);
  lines.push('');

  let aggregateVerdict: string;
  if (totalAnthropicCritical === 0) {
    aggregateVerdict = '**Inconclusive** — Anthropic baseline produced 0 P0/P1 findings. Need richer corpus or stricter prompt.';
  } else if (totalPct >= 0.2) {
    aggregateVerdict = `**H1 supported** — cross-lineage union adds ${(totalPct * 100).toFixed(0)}% unique P0/P1 vs Claude-only baseline (target ≥20%).`;
  } else if (totalPct >= 0.1) {
    aggregateVerdict = `**H1 partial** — cross-lineage adds ${(totalPct * 100).toFixed(0)}% unique P0/P1 (between 10% and 20% target). Suggests configurable feature, not headline.`;
  } else {
    aggregateVerdict = `**H0 not rejected** — cross-lineage adds only ${(totalPct * 100).toFixed(0)}% unique P0/P1 (below 10%). Drop cross-model angle.`;
  }
  lines.push(aggregateVerdict);
  lines.push('');
  return lines.join('\n');
}

function renderUniqueExamples(reviews: ProviderReview[]): string {
  const lines: string[] = [];
  lines.push('## Qualitative examples — findings unique to non-Claude lineages');
  lines.push('');
  lines.push('A finding is "unique to non-Claude" if no Anthropic provider flagged it (within file + line±3 + category window).');
  lines.push('');

  const prs = [...new Set(reviews.map((r) => r.pr))];
  for (const pr of prs) {
    const rs = reviews.filter((r) => r.pr === pr && r.success);
    const anthropicFindings: Finding[] = rs
      .filter((r) => r.lineage === 'Anthropic')
      .flatMap((r) => r.findings);

    const nonAnthropic = rs.filter((r) => r.lineage !== 'Anthropic');
    const unique: { provider: string; lineage: string; finding: Finding }[] = [];
    for (const r of nonAnthropic) {
      for (const f of r.findings) {
        if (!anthropicFindings.some((af) => findingsMatch(af, f))) {
          unique.push({ provider: r.provider, lineage: r.lineage, finding: f });
        }
      }
    }
    if (unique.length === 0) continue;

    lines.push(`### ${pr} — ${unique.length} unique non-Anthropic finding(s)`);
    lines.push('');
    // Show top 8 prioritized by severity (P0 > P1 > P2)
    const sorted = unique.sort((a, b) => {
      const sevOrder = { P0: 0, P1: 1, P2: 2 };
      return sevOrder[a.finding.severity] - sevOrder[b.finding.severity];
    });
    for (const { provider, lineage, finding } of sorted.slice(0, 8)) {
      lines.push(
        `- **[${finding.severity}/${finding.category}]** \`${finding.file}:${finding.line}\` — ${finding.summary}  *(${lineage} via ${getDisplayName(provider)})*`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderHeader(reviews: ProviderReview[]): string {
  const successCount = reviews.filter((r) => r.success).length;
  const totalCount = reviews.length;
  const lineages = [...new Set(reviews.filter((r) => r.success).map((r) => r.lineage))];
  const prs = [...new Set(reviews.map((r) => r.pr))];
  return [
    '# Cross-model PR review — delta report',
    '',
    `> Generated by Spec R M3 \`analyze.ts\` on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    `**Corpus**: ${prs.join(', ')} (${prs.length} PRs)  `,
    `**Eval**: ${successCount}/${totalCount} reviews succeeded across ${lineages.length} lineages (${lineages.join(', ')})`,
    '',
  ].join('\n');
}

function renderMethodology(): string {
  return [
    '## Methodology',
    '',
    `- **Match window**: two findings overlap when same file + line within ±${LINE_WINDOW} + same category.`,
    '- **Jaccard**: greedy bipartite match — each finding pairs with at most one peer.',
    '- **Lineage delta**: union of findings across all Anthropic providers vs union across all providers.',
    '- **Caveats**: small corpus (4 PRs), single run per (provider, PR) — variance not measured. Copilot label is "GitHub-wrapped" because it routes to a vendor-controlled model. No human ground-truth for precision/recall.',
    '',
    '## Reproducibility',
    '',
    '```bash',
    'cd research/cross-model-review-study',
    'export OPENCODE_ZEN_KEY=$(jq -r .opencode.key ~/.local/share/opencode/auth.json)',
    'npx promptfoo eval --output results/eval-vN.json',
    'npx tsx analyze.ts results/eval-vN.json --out results/delta-report.md',
    '```',
    '',
  ].join('\n');
}

// ─── Entry point ───────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: tsx analyze.ts <results.json> [--out <report.md>]');
    process.exit(1);
  }

  const inputPath = resolve(args[0]);
  const outIdx = args.indexOf('--out');
  const outPath =
    outIdx >= 0 && args[outIdx + 1]
      ? resolve(args[outIdx + 1])
      : resolve(dirname(inputPath), 'delta-report.md');

  console.log(`Reading: ${inputPath}`);
  const reviews = loadResults(inputPath);

  console.log(`Loaded ${reviews.length} reviews; ${reviews.filter((r) => r.success).length} successful`);

  const sections: string[] = [
    renderHeader(reviews),
    renderLineageDelta(reviews),
    '## Per-PR breakdown',
    '',
  ];

  const prs = [...new Set(reviews.map((r) => r.pr))];
  for (const pr of prs) {
    sections.push(renderPerProviderTable(reviews, pr));
    sections.push(renderJaccardMatrix(reviews, pr));
  }

  sections.push(renderUniqueExamples(reviews));
  sections.push(renderMethodology());
  sections.push(`*Source*: \`${basename(inputPath)}\``);

  const report = sections.join('\n');
  writeFileSync(outPath, report, 'utf-8');
  console.log(`Wrote: ${outPath}`);

  // Also dump a digest JSON for downstream consumption
  const digestPath = resolve(dirname(outPath), 'findings.json');
  const digest = {
    generated: new Date().toISOString(),
    source: basename(inputPath),
    totalReviews: reviews.length,
    successful: reviews.filter((r) => r.success).length,
    reviews: reviews.map((r) => ({
      provider: r.provider,
      lineage: r.lineage,
      pr: r.pr,
      success: r.success,
      parseError: r.parseError,
      findingsCount: r.findings.length,
      findings: r.findings,
    })),
  };
  writeFileSync(digestPath, JSON.stringify(digest, null, 2), 'utf-8');
  console.log(`Wrote: ${digestPath}`);
}

main();
