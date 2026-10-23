// Literal excerpts remain useful for code and machine-readable state markers.
export function literalPublicationBody(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n');
  if (Buffer.byteLength(text, 'utf8') > 65500) throw new Error('Publication text is too large to render safely.');
  const existing = text.match(/^(`{3,})text\n([\s\S]*)\n\1$/);
  if (existing && !(existing[2].match(/`+/g) || []).some((run) => run.length >= existing[1].length)) return text;
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const body = `${fence}text\n${text}\n${fence}`;
  if (Buffer.byteLength(body, 'utf8') > 65536) {
    throw new Error('Literal publication body exceeds the GitHub body limit; refusing to truncate it.');
  }
  return body;
}

function inlineCode(text) {
  const fence = '`'.repeat(1 + Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length)));
  const pad = /^[ `]|[ `]$/.test(text) && /[^ ]/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function plainMarkdown(text) {
  return text.split(/(\s+)/).map((token) => {
    // Keep all reference-bearing tokens in code, including entities and bare SHAs.
    if (/[$#@&/\\<>]|\S\.\S|[a-z][a-z0-9+.-]*:\S|\b[a-f0-9]{7,40}\b|\bGH-\d+\b/i.test(token)) return inlineCode(token);
    return token.replace(/[\\`*_[\]{}()!|~]/g, '\\$&');
  }).join('');
}

function inlineMarkdown(source, depth = 0) {
  let output = '', plain = '';
  const append = (value) => {
    if (output.endsWith('`') && value.startsWith('`')) output += ' ';
    output += value;
  };
  const flush = () => { append(plainMarkdown(plain)); plain = ''; };
  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && /[\\`*_[\]{}()!|~$#+.<>@&:/-]/.test(source[i + 1] || '')) {
      plain += source[i + 1]; i += 2; continue;
    }
    if (source[i] === '`') {
      const fence = source.slice(i).match(/^`+/)[0];
      const runs = /`+/g;
      runs.lastIndex = i + fence.length;
      let closing;
      while ((closing = runs.exec(source)) && closing[0].length !== fence.length) {}
      if (closing) {
        flush();
        let content = source.slice(i + fence.length, closing.index);
        if (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) content = content.slice(1, -1);
        append(inlineCode(content));
        i = closing.index + fence.length;
        continue;
      }
      plain += fence; i += fence.length; continue;
    }
    const delimiter = depth < 8 && source.slice(i).match(/^(?:\*\*|__|~~|\*|_)/)?.[0];
    if (delimiter && (delimiter !== '_' || i === 0 || /\W/.test(source[i - 1]))) {
      const end = source.indexOf(delimiter, i + delimiter.length);
      const content = end >= 0 ? source.slice(i + delimiter.length, end) : '';
      if (content && !/^\s|\s$/.test(content)) {
        flush();
        append(`${delimiter}${inlineMarkdown(content, depth + 1)}${delimiter}`);
        i = end + delimiter.length;
        continue;
      }
    }
    plain += source[i++];
  }
  flush();
  return output;
}

function codeBlock(content) {
  const fence = '`'.repeat(Math.max(3, 1 + Math.max(0, ...(content.match(/`+/g) || []).map((run) => run.length))));
  // GitHub enriches languages such as mermaid and math into interactive content.
  return `${fence}text\n${content}\n${fence}`;
}

/**
 * Emit a limited Markdown grammar; never pass through arbitrary Markdown/HTML.
 * Text that can become a link, mention or reference is emitted only as code.
 */
export function markdownPublicationBody(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(text, 'utf8') > 65500) throw new Error('Publication text is too large to render safely.');
  const lines = text.split('\n'), output = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/);
    if (fence && (fence[1][0] !== '`' || !fence[2].includes('`'))) {
      const content = [];
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i])) content.push(lines[i]);
      output.push(codeBlock(content.join('\n')));
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      const content = [];
      while (i < lines.length && /^(?: {4}|\t)/.test(lines[i])) content.push(lines[i++].replace(/^(?: {4}|\t)/, ''));
      i--;
      output.push(codeBlock(content.join('\n')));
      continue;
    }
    if (/^<!--\s*lights-on-state:.*-->$/.test(line.trim())) {
      output.push(literalPublicationBody(line.trim()));
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { output.push(`${heading[1]} ${inlineMarkdown(heading[2])}`); continue; }
    if (line.trim() && i + 1 < lines.length && /^ {0,3}(?:={3,}|-{3,})\s*$/.test(lines[i + 1])) {
      output.push(`${lines[++i].trim()[0] === '=' ? '#' : '##'} ${inlineMarkdown(line.trim())}`);
      continue;
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { output.push('***'); continue; }
    const list = line.match(/^( {0,3})([-+*]|\d{1,9}[.)])\s+(.*)$/);
    if (list) {
      const checkbox = list[3].match(/^\[([ xX])\]\s+(.*)$/);
      output.push(`${list[1]}${list[2]} ${checkbox ? `[${checkbox[1].toLowerCase()}] ${inlineMarkdown(checkbox[2])}` : inlineMarkdown(list[3])}`);
      continue;
    }
    const quote = line.match(/^ {0,3}>\s?(.*)$/);
    if (quote) { output.push(`> ${inlineMarkdown(quote[1])}`); continue; }
    output.push(inlineMarkdown(line.trim()));
  }
  const body = output.join('\n');
  if (Buffer.byteLength(body, 'utf8') > 65536) throw new Error('Rendered publication body exceeds the GitHub body limit.');
  return body;
}

// Titles and commit messages are not Markdown. Break reference/mention syntax
// rather than relying on code delimiters that GitHub may ignore in these fields.
export function plainPublicationText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ')
    .replace(/\//g, ' / ').replace(/#/g, ' number ').replace(/@/g, ' at ')
    .replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
}

export function commitPublicationText(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n');
  const wrapped = text.match(/^(`{3,})text\n([\s\S]*)\n\1$/);
  return (wrapped ? wrapped[2] : text).split('\n').flatMap((line) => {
    let remaining = plainPublicationText(line.replace(/^ {0,3}#{1,6}\s+/, ''));
    const lines = [];
    while (remaining.length > 72) {
      let split = remaining.lastIndexOf(' ', 72);
      if (split <= 0) {
        split = 72;
        if (/[\uD800-\uDBFF]/.test(remaining[split - 1]) && /[\uDC00-\uDFFF]/.test(remaining[split])) split--;
      }
      lines.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    lines.push(remaining);
    return lines;
  }).join('\n').trim();
}

export function conciseCommitText(value, limit = 600) {
  const text = String(value ?? '').replace(/\r\n/g, '\n');
  const wrapped = text.match(/^(`{3,})text\n([\s\S]*)\n\1$/);
  const plain = (wrapped ? wrapped[2] : text).split('\n')
    .map((line) => plainPublicationText(line.replace(/^ {0,3}#{1,6}\s+/, ''))).join('\n').trim();
  if (plain.length <= limit) return commitPublicationText(plain);
  let split = plain.lastIndexOf(' ', limit - 3);
  if (split < Math.floor(limit / 2)) {
    split = limit - 3;
    if (/[\uD800-\uDBFF]/.test(plain[split - 1]) && /[\uDC00-\uDFFF]/.test(plain[split])) split--;
  }
  return commitPublicationText(`${plain.slice(0, split).trimEnd()}...`);
}
