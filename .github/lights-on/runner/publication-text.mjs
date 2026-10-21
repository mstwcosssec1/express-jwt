/**
 * Publish external/model text as literal content. Markdown source regexes cannot
 * safely distinguish decoded links, HTML, references and malformed delimiters.
 */
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
    let remaining = plainPublicationText(line);
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
  const plain = (wrapped ? wrapped[2] : text).split('\n').map(plainPublicationText).join('\n').trim();
  if (plain.length <= limit) return commitPublicationText(plain);
  let split = plain.lastIndexOf(' ', limit - 3);
  if (split < Math.floor(limit / 2)) {
    split = limit - 3;
    if (/[\uD800-\uDBFF]/.test(plain[split - 1]) && /[\uDC00-\uDFFF]/.test(plain[split])) split--;
  }
  return commitPublicationText(`${plain.slice(0, split).trimEnd()}...`);
}
