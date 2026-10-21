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
  return (wrapped ? wrapped[2] : text).split('\n').map(plainPublicationText).join('\n').trim();
}
