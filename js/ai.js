const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

const stored = (name, fallback = '') => ({
  get: () => localStorage.getItem(`reader.${name}`) || fallback,
  set: (value) => {
    if (value) localStorage.setItem(`reader.${name}`, value);
    else localStorage.removeItem(`reader.${name}`);
  },
});

// Inside the iOS app the key lives in the Keychain: the native shell hands it
// over in window.readerNative and is told when it changes.
const native = window.readerNative;
const nativeKey = {
  get: () => native.key || '',
  set: (value) => {
    native.key = value;
    window.webkit.messageHandlers.reader.postMessage({ type: 'setKey', value });
  },
};

export const settings = {
  key: native ? nativeKey : stored('apiKey'),
  model: stored('model', DEFAULT_MODEL),
  extra: stored('extra'),
};

const SYSTEM = `You are a reading companion built into an e-book reader. The reader has highlighted part of the page and wants it explained.

Explain what the highlighted text means in its context: clarify difficult vocabulary, references, allusions, or ideas as needed. If the highlight is a single word or short phrase, give its meaning as it is used here. Use the surrounding text only to inform your explanation; do not summarise it, and do not reveal anything about the book beyond the point the reader has reached.

Be concise and plain-spoken: usually under 150 words, with no preamble. Answer follow-up questions in the same spirit.`;

function buildPrompt(ctx) {
  const lines = [`Book: ${ctx.title || 'Unknown'}${ctx.author ? ` by ${ctx.author}` : ''}`];
  if (ctx.chapter) lines.push(`Chapter: ${ctx.chapter}`);
  lines.push(
    '',
    'Surrounding text, with the highlight marked by [[ ]]:',
    `"""${ctx.before}[[${ctx.text}]]${ctx.after}"""`,
    '',
    'Highlighted text:',
    `"""${ctx.text}"""`,
  );
  return lines.join('\n');
}

async function* stream(messages, signal) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.key.get()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: settings.model.get(), messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    let message = `The request failed (${res.status}).`;
    try { message = (await res.json()).error?.message || message; } catch { /* not JSON */ }
    if (res.status === 401) message = 'OpenRouter rejected the API key. Check it in Settings.';
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.error) throw new Error(json.error.message || 'The model returned an error.');
      const chunk = json.choices?.[0]?.delta?.content;
      if (chunk) yield chunk;
    }
  }
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Small Markdown subset: paragraphs, lists, bold, italics, code, quotes.
function markdown(text) {
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  const out = [];
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    para = [];
    list = null;
  };
  const item = (tag, content) => {
    if (para.length || (list && list.tag !== tag)) flush();
    list ??= { tag, items: [] };
    list.items.push(content);
  };
  for (const line of text.split('\n')) {
    let m;
    if (!line.trim()) flush();
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) item('ul', m[1]);
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) item('ol', m[1]);
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flush(); out.push(`<p><strong>${inline(m[1])}</strong></p>`); }
    else if ((m = line.match(/^>\s?(.*)/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else { if (list) flush(); para.push(line); }
  }
  flush();
  return out.join('');
}

export class AIPanel {
  constructor(el, { openSettings }) {
    this.el = el;
    this.openSettings = openSettings;
    this.quote = el.querySelector('#ai-quote');
    this.thread = el.querySelector('#ai-thread');
    this.form = el.querySelector('#ai-form');
    this.input = el.querySelector('#ai-input');
    this.messages = [];

    el.querySelector('#ai-close').addEventListener('click', () => this.close());
    // The delay keeps the panel in place while the Send button is being tapped.
    this.input.addEventListener('focus', () => {
      clearTimeout(this.typingTimer);
      el.classList.add('typing');
    });
    this.input.addEventListener('blur', () => {
      this.typingTimer = setTimeout(() => el.classList.remove('typing'), 300);
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const question = this.input.value.trim();
      if (!question || this.busy || !this.messages.length) return;
      this.input.value = '';
      this.messages.push({ role: 'user', content: question });
      this._bubble('user').textContent = question;
      this._run();
    });
  }

  open(ctx) {
    this.controller?.abort();
    this.busy = false;
    const extra = settings.extra.get();
    this.messages = [
      { role: 'system', content: extra ? `${SYSTEM}\n\nThe reader's own instructions: ${extra}` : SYSTEM },
      { role: 'user', content: buildPrompt(ctx) },
    ];
    this.quote.textContent = ctx.text;
    this.thread.replaceChildren();
    this.input.value = '';
    this.el.hidden = false;
    this._run();
  }

  close() {
    this.controller?.abort();
    this.el.hidden = true;
  }

  // Re-runs the pending request, e.g. after the API key has been added.
  retry() {
    if (this.el.hidden || this.busy || this.messages.at(-1)?.role !== 'user') return;
    this.thread.querySelector('.notice:last-child')?.remove();
    this._run();
  }

  _bubble(kind) {
    const div = document.createElement('div');
    div.className = `bubble ${kind}`;
    this.thread.append(div);
    this.thread.scrollTop = this.thread.scrollHeight;
    return div;
  }

  _notice(text, label, action) {
    const div = this._bubble('notice');
    div.textContent = text;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    div.append(button);
  }

  async _run() {
    if (!settings.key.get()) {
      this._notice('Add your OpenRouter API key to get explanations.', 'Open Settings', () => this.openSettings());
      return;
    }
    this.busy = true;
    const controller = this.controller = new AbortController();
    const bubble = this._bubble('assistant pending');
    let text = '';
    try {
      for await (const chunk of stream(this.messages, controller.signal)) {
        text += chunk;
        bubble.classList.remove('pending');
        bubble.innerHTML = markdown(text);
        this.thread.scrollTop = this.thread.scrollHeight;
      }
      if (!text) throw new Error('The model returned an empty answer.');
      this.messages.push({ role: 'assistant', content: text });
    } catch (err) {
      if (controller.signal.aborted) return;
      bubble.remove();
      const message = err instanceof TypeError ? 'Could not reach OpenRouter. Check your connection.' : err.message;
      this._notice(message, 'Try again', () => this.retry());
    } finally {
      if (this.controller === controller) this.busy = false;
    }
  }
}
