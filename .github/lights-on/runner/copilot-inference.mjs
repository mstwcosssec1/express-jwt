import { stripVTControlCharacters } from 'node:util';
import { matchesToolParameters } from './tool-arguments.mjs';

export function copilotFailureDiagnostic(proc, env) {
  let text = stripVTControlCharacters([proc.error?.message, proc.stderr || proc.stdout].filter(Boolean).join(' '));
  const secrets = Object.entries(env)
    .filter(([key, value]) => /token|secret|password|api_?key|credential|authorization/i.test(key) &&
      typeof value === 'string' && value.length > 0)
    .flatMap(([, value]) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return text.length > 2000 ? `${text.slice(0, 2000)} [truncated]` : text;
}

export function parseCopilotToolSelection(output, tools) {
  const text = String(output || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let call;
  try { call = JSON.parse(fenced ? fenced[1] : text); }
  catch { return { error: 'Expected one JSON object, not XML invocations, prose, or multiple tool calls.' }; }
  if (!call || Array.isArray(call) || typeof call !== 'object') {
    return { error: 'Expected a JSON object containing name and arguments.' };
  }
  const tool = tools.find((tool) => tool.function.name === call.name);
  if (!tool) return { error: 'The tool name was not in the supplied tool list.' };
  if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) ||
      !matchesToolParameters(call.arguments, tool.function.parameters)) {
    return { error: 'Tool arguments must be an object matching the supplied parameter types and required fields.' };
  }
  return { call };
}
