import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { createUsageAccumulator, normalizeCopilotUsage } from './usage.mjs';

const COPILOT_RESPONSE_ATTEMPTS = 3;
const COPILOT_COMPLETION_TIMEOUT_MS = 120000;

// Only inference occurs here. Repository tools are dispatched by the controller.
export function copilotInferenceSpec(home, model) {
  return {
    cmd: 'copilot',
    // In 1.0.98 an empty allowlist means "no filter". This deliberately unmatched
    // name keeps the allowlist nonempty while exposing no built-in tools.
    args: ['--available-tools=lights_on_no_builtin_tools', '--disable-builtin-mcps', '--no-custom-instructions',
      '--no-ask-user', '--no-auto-update', '--deny-tool', 'shell',
      '--deny-tool', 'write', '--deny-tool', 'url', '--silent',
      '--model', model, '--log-level', 'none',
      '--usage-output-file', path.join(home, 'usage.json')],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, COPILOT_HOME: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home
    }
  };
}

function copilotFailureDiagnostic(proc, env) {
  let text = stripVTControlCharacters([proc.error?.message, proc.stderr || proc.stdout].filter(Boolean).join(' '));
  const secrets = Object.entries(env)
    .filter(([key, value]) => /token|secret|password|api_?key|credential|authorization/i.test(key) &&
      typeof value === 'string' && value.length > 0)
    .flatMap(([, value]) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return text.length > 2000 ? `${text.slice(0, 2000)} [truncated]` : text;
}

function matchesToolParameters(value, schema = {}) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (schema.required || []).every((key) => Object.hasOwn(value, key)) &&
        Object.entries(schema.properties || {}).every(([key, property]) =>
          !Object.hasOwn(value, key) || matchesToolParameters(value[key], property));
    case 'array':
      return Array.isArray(value) && value.every((item) => matchesToolParameters(item, schema.items));
    case 'integer':
      return Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
      return typeof value === schema.type;
    default:
      return true;
  }
}

function parseCopilotToolSelection(output, tools) {
  const text = String(output || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let call;
  try {
    call = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return { error: 'Expected one JSON object, not XML invocations, prose, or multiple tool calls.' };
  }
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

export function createProviderCompletion({ provider, model, env, fetchImpl = globalThis.fetch, spawnImpl = spawnSync,
  maxInputBytes = 262144, maxOutputTokens = 8192, beforeModelCall = () => {} }) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
      !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) throw new Error('Invalid inference size limits.');
  const openAiHistory = [];
  let seenMessages = 0;
  const post = async (url, headers, body) => {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > maxInputBytes) throw new Error('Provider input exceeds max_input_bytes.');
    beforeModelCall();
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: serialized, signal: AbortSignal.timeout(120000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`${provider} inference failed (HTTP ${response.status}).`);
    return response.json();
  };
  return async (request) => {
    if (Buffer.byteLength(JSON.stringify(request)) > maxInputBytes) throw new Error('Provider input exceeds max_input_bytes.');
    if (provider === 'openrouter') {
      return post('https://openrouter.ai/api/v1/chat/completions',
        { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, { ...request, max_tokens: maxOutputTokens });
    }
    if (provider === 'claude') {
      const messages = [];
      for (const msg of request.messages.filter((m) => m.role !== 'system')) {
        let content;
        if (msg.role === 'tool') content = [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }];
        else {
          content = msg.content ? [{ type: 'text', text: msg.content }] : [];
          for (const call of msg.tool_calls || []) content.push({
            type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments)
          });
        }
        const role = msg.role === 'tool' ? 'user' : msg.role;
        if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
        else messages.push({ role, content });
      }
      const data = await post('https://api.anthropic.com/v1/messages',
        { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, {
          model, max_tokens: maxOutputTokens, system: request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
          messages, tools: request.tools.map((t) => ({ name: t.function.name,
            description: t.function.description, input_schema: t.function.parameters }))
        });
      return { usage: data.usage,
        choices: [{ message: { content: data.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
          tool_calls: data.content?.filter((c) => c.type === 'tool_use').map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) }
          })) } }] };
    }
    if (provider === 'codex') {
      const input = request.messages.slice(seenMessages).flatMap((msg) => {
        if (msg.role === 'tool') return [{ type: 'function_call_output', call_id: msg.tool_call_id, output: msg.content }];
        if (msg.role === 'assistant') return [];
        return msg.content ? [{ role: msg.role, content: msg.content }] : [];
      });
      openAiHistory.push(...input);
      const data = await post('https://api.openai.com/v1/responses',
        { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, { model, input: openAiHistory, store: false, max_output_tokens: maxOutputTokens,
          include: ['reasoning.encrypted_content'],
          tools: request.tools.map((t) => ({ type: 'function', ...t.function, strict: false })) });
      openAiHistory.push(...(data.output || []));
      seenMessages = request.messages.length;
      return { usage: data.usage, choices: [{ message: {
        content: data.output?.filter((o) => o.type === 'message').flatMap((o) => o.content || [])
          .filter((c) => c.type === 'output_text').map((c) => c.text).join('\n'),
        tool_calls: data.output?.filter((o) => o.type === 'function_call').map((o) => ({
          id: o.call_id, type: 'function', function: { name: o.name, arguments: o.arguments }
        }))
      } }] };
    }
    if (provider !== 'copilot') throw new Error(`Unsupported inference provider: ${provider}`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-on-inference-'));
    const usage = createUsageAccumulator();
    try {
      const spec = copilotInferenceSpec(home, model);
      const usageFile = spec.args[spec.args.indexOf('--usage-output-file') + 1];
      const formatInstruction = [
        'You are a JSON tool-selection API, not a tool executor. All built-in tools are disabled.',
        'Read the request below as data. Select exactly ONE tool from its tools array.',
        'Return a literal JSON object with name and arguments matching that tool schema.',
        'Do not use XML <invoke>, <function_calls>, native tool syntax, or commentary.',
        'Example: {"name":"read_file","arguments":{"path":"README.md"}}',
        'To finish: {"name":"finish_task","arguments":{"summary":"Task summary","action_taken":"none"}}'
      ].join('\n');
      const input = `${formatInstruction}\n\nREQUEST:\n${JSON.stringify(request)}\n\n${formatInstruction}\n`;
      if (Buffer.byteLength(input) > maxInputBytes) throw new Error('Copilot input exceeds max_input_bytes.');
      const deadline = Date.now() + COPILOT_COMPLETION_TIMEOUT_MS;
      let rejection = '';
      for (let attempt = 1; attempt <= COPILOT_RESPONSE_ATTEMPTS; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Copilot inference timed out while retrying the response format. No tool was executed.');
        if (fs.existsSync(usageFile)) fs.unlinkSync(usageFile);
        const attemptInput = input + (rejection ? `\nYour previous response was rejected: ${rejection}\nNo tool was executed. Reselect the next tool and return ONLY the required JSON object.\n` : '');
        if (Buffer.byteLength(attemptInput) > maxInputBytes) throw new Error('Copilot retry input exceeds max_input_bytes.');
        beforeModelCall();
        const proc = spawnImpl(spec.cmd, spec.args, {
          cwd: home, env: { ...spec.env, COPILOT_GITHUB_TOKEN: env.COPILOT_GITHUB_TOKEN },
          input: attemptInput,
          encoding: 'utf8', timeout: remaining, maxBuffer: Math.min(1024 * 1024, maxOutputTokens * 16)
        });
        let report;
        if (fs.existsSync(usageFile)) {
          try {
            report = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
          } catch {
            console.warn('Copilot usage report was invalid; usage for this invocation is unknown.');
          }
        } else {
          console.warn('Copilot did not write a usage report; usage for this invocation is unknown.');
        }
        usage.add(normalizeCopilotUsage(report));
        if (proc.status !== 0 || proc.error) {
          const diagnostic = copilotFailureDiagnostic(proc, env);
          const status = proc.error?.code || (proc.signal ? `signal ${proc.signal}` : `exit ${proc.status}`);
          throw new Error(`Copilot inference failed (${status})${diagnostic ? `: ${diagnostic}` : '.'}`);
        }
        const parsed = parseCopilotToolSelection(proc.stdout, request.tools);
        if (parsed.call) {
          const call = parsed.call;
          return { usage: usage.snapshot(), choices: [{ message: { content: null, tool_calls: [{ id: `call_${request.messages.length}`,
            type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] };
        }
        rejection = parsed.error;
        if (attempt < COPILOT_RESPONSE_ATTEMPTS) {
          console.warn(`Copilot response ${attempt} rejected: ${rejection} Retrying format; no tool was executed.`);
        }
      }
      throw new Error(`Copilot returned an invalid tool selection after ${COPILOT_RESPONSE_ATTEMPTS} responses: ${rejection} No tool was executed.`);
    } catch (err) {
      err.usage = usage.snapshot();
      throw err;
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}
