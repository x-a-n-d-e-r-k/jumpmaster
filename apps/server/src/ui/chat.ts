import { CARD_STATE_TEXT, CARD_TITLE, type ChatCard, renderCard } from '../chat/cards.js';
import type { ChatMessage, ChatThread } from '../chat/store.js';
import { escapeHtml, linkify, page } from './pages.js';

/**
 * The crew chat's pages (#336): `/chat` lists the threads, `/chat/:id` shows one and streams its
 * turns. Stored text is rendered here, escaped and then linked by `linkify`; the page script adds
 * streamed text with `textContent` only, so no text from a turn ever becomes markup.
 */

/**
 * The one command that adds the chat service to an install from before it: download the release's
 * `compose.yaml` again, then start the services it names.
 */
export const CHAT_MISSING_COMMAND =
  'curl -fSLO https://github.com/x-a-n-d-e-r-k/jumpmaster/releases/latest/download/compose.yaml && docker compose up -d';

const WHO: Record<string, string> = {
  owner: 'You',
  assistant: 'Chat',
  system: 'Jumpmaster',
};

const CHAT_STYLE = `<style>.chat-log{display:flex;flex-direction:column;gap:.75rem;margin:1rem 0}.chat-log .msg{padding:.75rem 1rem;border-radius:12px;box-shadow:inset 0 0 0 1px var(--stroke-soft-200);white-space:pre-wrap;overflow-wrap:anywhere}.chat-log .msg.owner{background:var(--bg-weak-50)}.chat-log .who{font-weight:600;font-size:.875rem;white-space:normal}.chat-log .state{display:block;white-space:normal}.chat-log details.tool{font-size:.875rem;padding:0 1rem}.chat-log .msg.card{background:var(--bg-weak-50);white-space:normal}.chat-log .msg.card.refused{opacity:.8}.chat-send textarea{width:100%;min-height:5rem}</style>`;

/** The `/chat` page: the threads, newest first, and a New thread button. */
export function renderChatList(threads: ChatThread[], o: { serviceMissing: boolean }): string {
  const missing = o.serviceMissing
    ? `<div class="card attention"><h2>The chat service is not running</h2><p>This install's <code>compose.yaml</code> is from before the chat. Run this in the install's directory to add it; your messages wait until it is up:</p><pre><code>${escapeHtml(CHAT_MISSING_COMMAND)}</code></pre></div>`
    : '';
  const list =
    threads.length === 0
      ? '<p>No threads yet.</p>'
      : `<table><tr><th>Thread</th><th>Updated</th></tr>${threads
          .map(
            (t) =>
              `<tr><td><a href="/chat/${encodeURIComponent(t.id)}">${escapeHtml(t.title)}</a></td><td>${escapeHtml(t.updatedAt)}</td></tr>`,
          )
          .join('')}</table>`;
  const script = `<script>document.getElementById('new-thread').addEventListener('submit',async(e)=>{e.preventDefault();const r=await jmFetch('/api/chat/threads',{});if(r.ok){const b=await r.json();location.href='/chat/'+encodeURIComponent(b.thread.id);}else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});</script>`;
  return page(
    `<h2>Chat</h2>${missing}<form id="new-thread"><button class="primary">New thread</button></form>${list}${script}`,
    { title: 'Chat' },
  );
}

/** One stored message as HTML: a tool line is one collapsed line, the rest escaped and linked. */
function messageHtml(m: ChatMessage): string {
  if (m.role === 'tool') {
    return `<details class="tool" data-seq="${m.seq}"><summary>${escapeHtml(m.text)}</summary></details>`;
  }
  const state =
    m.state === 'done'
      ? ''
      : `<small class="state">${escapeHtml(m.error ? `${m.state}: ${m.error}` : m.state)}</small>`;
  return `<div class="msg ${escapeHtml(m.role)}" data-seq="${m.seq}"><div class="who">${escapeHtml(WHO[m.role] ?? m.role)}</div><div class="text">${linkify(m.text, {})}</div>${state}</div>`;
}

/**
 * The page script. It posts the owner's message, then follows the thread's events
 * (`/api/chat/threads/:id/events`) from the last seq it has, until `done`.
 */
const THREAD_SCRIPT = `<script>{const root=document.getElementById('chat');const id=root.dataset.thread;const log=document.getElementById('messages');let last=Number(root.dataset.last)||0;let es=null;let live=null;const WHO=${JSON.stringify(WHO)};const CARD_TITLE=${JSON.stringify(CARD_TITLE)};const STATE=${JSON.stringify(CARD_STATE_TEXT)};
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
const msgEl=(m)=>{if(m.role==='tool'){const d=el('details','tool');d.dataset.seq=String(m.seq);d.append(el('summary','',m.text));return d;}const d=el('div','msg '+m.role);d.dataset.seq=String(m.seq);d.append(el('div','who',WHO[m.role]||m.role),el('div','text',m.text));if(m.state!=='done')d.append(el('small','state',m.error?m.state+': '+m.error:m.state));return d;};
const put=(m)=>{last=Math.max(last,Number(m.seq)||0);const node=msgEl(m);const old=[...log.children].find((c)=>c.dataset.seq===String(m.seq));if(old)old.replaceWith(node);else log.append(node);if(m.role==='assistant'&&live){live.remove();live=null;}};
const follow=()=>{if(es)return;es=new EventSource('/api/chat/threads/'+encodeURIComponent(id)+'/events?after='+last);
es.addEventListener('message',(e)=>put(JSON.parse(e.data)));
es.addEventListener('tool',(e)=>put({...JSON.parse(e.data),role:'tool',state:'done'}));
es.addEventListener('text',(e)=>{const t=JSON.parse(e.data);if(!live){live=el('div','msg assistant live');live.append(el('div','who',WHO.assistant),el('div','text',''));log.append(live);}const box=live.lastChild;box.textContent=box.textContent?box.textContent+'\\n\\n'+t.text:t.text;});
es.addEventListener('card',(e)=>{const c=JSON.parse(e.data).card;if(!c||document.querySelector('[data-card="'+Number(c.id)+'"]'))return;const d=el('div','msg card '+c.state);d.dataset.card=String(c.id);d.append(el('div','who',CARD_TITLE[c.kind]||'Action'),el('div','text',c.summary));if(STATE[c.state])d.append(el('small','state',STATE[c.state]));if(c.link){const a=el('a','','Open');a.href=c.link;d.append(a);}log.append(d);});
es.addEventListener('done',()=>{es.close();es=null;});};
document.getElementById('send').addEventListener('submit',async(e)=>{e.preventDefault();const box=e.target.querySelector('textarea');const text=box.value;if(!text.trim())return;const r=await jmFetch('/api/chat/threads/'+encodeURIComponent(id)+'/messages',{text});if(r.ok){box.value='';put((await r.json()).message);follow();}else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});
if(root.dataset.busy==='1')follow();}</script>`;

/**
 * The thread's stored messages and cards in the order they happened: each card after the messages
 * stored up to when it was recorded.
 */
function logHtml(messages: ChatMessage[], cards: ChatCard[]): string {
  const out: string[] = [];
  let i = 0;
  for (const m of messages) {
    while (i < cards.length && (cards[i] as ChatCard).createdAt < m.createdAt) {
      out.push(renderCard(cards[i] as ChatCard));
      i++;
    }
    out.push(messageHtml(m));
  }
  for (const c of cards.slice(i)) out.push(renderCard(c));
  return out.join('');
}

/** The `/chat/:id` page: the thread's stored messages and cards, the send box and the live stream. */
export function renderThread(
  t: ChatThread,
  messages: ChatMessage[],
  cards: ChatCard[] = [],
): string {
  const last = messages.reduce((n, m) => Math.max(n, m.seq), 0);
  const busy = messages.some((m) => m.state === 'queued' || m.state === 'running');
  return page(
    `${CHAT_STYLE}<p><a href="/chat">All threads</a></p><h2>${escapeHtml(t.title)}</h2>` +
      `<div id="chat" data-thread="${t.id}" data-last="${last}" data-busy="${busy ? '1' : '0'}">` +
      `<div id="messages" class="chat-log" aria-live="polite">${logHtml(messages, cards)}</div>` +
      `<form id="send" class="chat-send"><textarea name="text" maxlength="20000" required placeholder="Ask the crew"></textarea><br><button class="primary">Send</button></form></div>` +
      THREAD_SCRIPT,
    { title: t.title },
  );
}
