import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Only inference occurs here. Repository tools are dispatched by the controller.
export function copilotInferenceSpec(home, model) {
  return {
    cmd: 'copilot',
    args: ['--available-tools', '--disable-builtin-mcps', '--no-custom-instructions',
      '--no-ask-user', '--no-auto-update', '--deny-tool', '*', '--silent',
      '--model', model, '--log-level', 'none'],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, COPILOT_HOME: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home
    }
  };
}

export function createProviderCompletion({ provider, model, env, fetchImpl = globalThis.fetch, spawnImpl = spawnSync }) {
  const openAiHistory = [];
  let seenMessages = 0;
  const post = async (url, headers, body) => {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`${provider} inference failed (HTTP ${response.status}).`);
    return response.json();
  };
  return async (request) => {
    if (provider === 'openrouter') {
      return post('https://openrouter.ai/api/v1/chat/completions',
        { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, request);
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
          model, max_tokens: 8192, system: request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
          messages, tools: request.tools.map((t) => ({ name: t.function.name,
            description: t.function.description, input_schema: t.function.parameters }))
        });
      return { usage: { total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) },
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
        { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, { model, input: openAiHistory, store: false,
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
    try {
      const spec = copilotInferenceSpec(home, model);
      const proc = spawnImpl(spec.cmd, spec.args, {
        cwd: home, env: { ...spec.env, COPILOT_GITHUB_TOKEN: env.COPILOT_GITHUB_TOKEN },
        input: `You are a tool-selection API. Do not use built-in tools. Return ONLY JSON of shape {"name":"tool_name","arguments":{...}} selecting ONE supplied tool.\n${JSON.stringify(request)}\n`,
        encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024
      });
      if (proc.status !== 0 || proc.error) throw new Error(`Copilot inference failed: ${proc.error?.message || `exit ${proc.status}`}`);
      const call = JSON.parse(proc.stdout.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (!request.tools.some((t) => t.function.name === call.name) || !call.arguments || typeof call.arguments !== 'object') {
        throw new Error('Copilot returned an invalid tool selection.');
      }
      return { choices: [{ message: { content: null, tool_calls: [{ id: `call_${request.messages.length}`,
        type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] };
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}
