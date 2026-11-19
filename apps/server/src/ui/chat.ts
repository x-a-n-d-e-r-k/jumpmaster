import {
  CARD_STATE_TEXT,
  CARD_TITLE,
  type ChatCard,
  CONFIRM_LINK,
  cardPendingId,
  renderCard,
} from '../chat/cards.js';
import type { ChatMessage, ChatThread } from '../chat/store.js';
import { PENDING_MS } from '../config/confirm.js';
import { renderChatMarkdown } from './markdown.js';
import { escapeHtml, linkify, page } from './pages.js';
import { relativeTime } from './time.js';
import { type ZoneRef, zoneNamer } from './zone-name.js';

/**
 * The crew chat's pages (#336): `/chat` lists the threads, `/chat/:id` shows one and streams its
 * turns. Owner text is rendered here escaped and linked by `linkify`; assistant and system text
 * goes through `renderChatMarkdown` (#490), a fixed Markdown subset that escapes everything else.
 * The page script adds streamed partial text with `textContent` only; the one HTML it sets is a
 * finished message's `html`, which the server made with the same renderer.
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

const CHAT_STYLE = `<style>.chat-log{display:flex;flex-direction:column;gap:.75rem;margin:1rem 0}.chat-log .msg{padding:.75rem 1rem;border-radius:12px;box-shadow:inset 0 0 0 1px var(--stroke-soft-200);overflow-wrap:anywhere}.chat-log .msg.owner{background:var(--bg-weak-50);white-space:pre-wrap}.chat-log .msg.live .text{white-space:pre-wrap}.chat-log .msg .text>:first-child{margin-top:0}.chat-log .msg .text>:last-child{margin-bottom:0}.chat-log .msg h3,.chat-log .msg h4,.chat-log .msg h5{margin:.75rem 0 .25rem}.chat-log .msg ul,.chat-log .msg ol{margin:.25rem 0;padding-left:1.5rem}.chat-log .msg p{margin:.5rem 0}.chat-log .msg table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:.5rem 0}.chat-log .msg th,.chat-log .msg td{border:1px solid var(--stroke-soft-200);padding:.25rem .5rem;text-align:left}.chat-log .msg pre{white-space:pre;overflow-x:auto;padding:.5rem;background:var(--bg-weak-50);border-radius:8px}.chat-log .who{font-weight:600;font-size:.875rem;white-space:normal}.chat-log .state{display:block;white-space:normal}.chat-log details.steps{font-size:.875rem;padding:0 1rem}.chat-log details.steps ol{margin:.25rem 0;padding-left:1.5rem}.chat-log .msg.card{background:var(--bg-weak-50);white-space:normal}.chat-log .msg.card.refused{opacity:.8}.chat-send{position:sticky;bottom:0;z-index:1;background:var(--bg-weak-50);padding:.5rem 0 calc(.5rem + env(safe-area-inset-bottom))}.chat-send textarea{width:100%;min-height:5rem}.chat-send .error{margin:0 0 .5rem}.chat-send .hint{display:block;margin:.25rem 0 .5rem;color:var(--text-sub-600)}.chat-log .msg.card.expired{opacity:.8}.chat-log .msg.card .expiry{display:block;color:var(--text-sub-600)}.chat-log .msg.card button{margin-top:.5rem}.confirm-dialog{max-width:36rem;width:calc(100% - 2rem);border:0;border-radius:12px;padding:1rem 1.25rem;box-shadow:0 8px 32px rgba(0,0,0,.25)}.confirm-dialog h2{margin-top:0}</style>`;

const CHIP_STYLE = `<style>.chip{display:inline-block;margin-left:.5rem;padding:0 .5rem;border-radius:6px;font:500 .75rem/1.5rem var(--font-sans);white-space:nowrap;vertical-align:middle;background:var(--faded-lighter);color:var(--text-sub-600)}</style>`;

/**
 * What a focused thread is about, as a chip: the project for `zone`, `<project> · goals` for
 * `goals`, `Briefing <ref>` for `briefing`. A zone no longer configured goes by its id; an
 * unfocused thread has no chip.
 */
export function focusChip(t: ChatThread, zones: readonly ZoneRef[]): string {
  if (t.focusKind === null || t.focusZoneId === null) return '';
  const name = zoneNamer(zones)(t.focusZoneId);
  const text =
    t.focusKind === 'zone'
      ? name
      : t.focusKind === 'goals'
        ? `${name} · goals`
        : `Briefing ${escapeHtml(t.focusRef ?? '')}`;
  return ` <span class="chip">${text}</span>`;
}

/** The `/chat` page: the threads, newest first, and a New thread button. */
export function renderChatList(
  threads: ChatThread[],
  o: { serviceMissing: boolean; zones?: readonly ZoneRef[]; now?: Date },
): string {
  const zones = o.zones ?? [];
  const now = o.now ?? new Date();
  const missing = o.serviceMissing
    ? `<div class="card attention"><h2>The chat service is not running</h2><p>This install's <code>compose.yaml</code> is from before the chat. Run this in the install's directory to add it; your messages wait until it is up:</p><pre><code>${escapeHtml(CHAT_MISSING_COMMAND)}</code></pre></div>`
    : '';
  const list =
    threads.length === 0
      ? '<p>No threads yet.</p>'
      : `<table><tr><th>Thread</th><th>Updated</th></tr>${threads
          .map(
            (t) =>
              `<tr><td><a href="/chat/${encodeURIComponent(t.id)}">${escapeHtml(t.title)}</a>${focusChip(t, zones)}</td><td>${relativeTime(t.updatedAt, now)}</td></tr>`,
          )
          .join('')}</table>`;
  const script = `<script>document.getElementById('new-thread').addEventListener('submit',async(e)=>{e.preventDefault();const r=await jmFetch('/api/chat/threads',{});if(r.ok){const b=await r.json();location.href='/chat/'+encodeURIComponent(b.thread.id);}else alert('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));});</script>`;
  return page(
    `${CHIP_STYLE}<h2>Chat</h2>${missing}<form id="new-thread"><button class="primary">New thread</button></form>${list}${script}`,
    { title: 'Chat' },
  );
}

/**
 * A message's text as HTML: the owner's escaped and linked as typed, the assistant's and the
 * system's as chat Markdown. The events route sends the same HTML as a message's `html`.
 */
export function messageTextHtml(m: Pick<ChatMessage, 'role' | 'text'>): string {
  return m.role === 'assistant' || m.role === 'system'
    ? renderChatMarkdown(m.text, {})
    : linkify(m.text, {});
}

/** A group of tool steps' summary: "Worked through N steps". The page script says the same. */
export function stepsLabel(n: number): string {
  return `Worked through ${n} ${n === 1 ? 'step' : 'steps'}`;
}

/**
 * A run of consecutive tool lines as one collapsed disclosure: the count, then each line's text,
 * in seq order. Each line keeps its `data-seq` so the page script can replace it in place.
 */
function stepsHtml(tools: ChatMessage[]): string {
  const items = tools.map((m) => `<li data-seq="${m.seq}">${escapeHtml(m.text)}</li>`).join('');
  return `<details class="steps"><summary>${stepsLabel(tools.length)}</summary><ol>${items}</ol></details>`;
}

/** One stored owner, assistant or system message as HTML, its text as `messageTextHtml`. */
function messageHtml(m: ChatMessage): string {
  const state =
    m.state === 'done'
      ? ''
      : `<small class="state">${escapeHtml(m.error ? `${m.state}: ${m.error}` : m.state)}</small>`;
  return `<div class="msg ${escapeHtml(m.role)}" data-seq="${m.seq}"><div class="who">${escapeHtml(WHO[m.role] ?? m.role)}</div><div class="text">${messageTextHtml(m)}</div>${state}</div>`;
}

/**
 * The page script. It posts the owner's message, then follows the thread's events
 * (`/api/chat/threads/:id/events`) from the last seq it has, until `done`.
 *
 * A pending card waiting on a confirm page (#503) shows the time left (its `createdAt` plus
 * `PENDING_MS` against this clock, every 30 s) and Review and confirm, which loads the server's
 * `?frame=1` render of that page (and only that: the card's link must be a confirm path) into the
 * thread's `<dialog>` and posts its form with `Accept: application/json`. 200 closes the dialog
 * (the settled card follows as a `card` event); 401, 429 and 503 say why inside it; 404 and 409
 * mean the change is gone, so the card turns Expired with Stage it again, which fills the composer
 * without sending. Without the dialog API, the button goes to the confirm page instead.
 */
export const THREAD_SCRIPT = `<script>{const root=document.getElementById('chat');const id=root.dataset.thread;const log=document.getElementById('messages');let last=Number(root.dataset.last)||0;let es=null;let live=null;const WHO=${JSON.stringify(WHO)};const CARD_TITLE=${JSON.stringify(CARD_TITLE)};const STATE=${JSON.stringify(CARD_STATE_TEXT)};const form=document.getElementById('send');const box=form.querySelector('textarea');const btn=form.querySelector('button');let err=null;
const sc=()=>document.scrollingElement||document.documentElement;const toEnd=()=>{const s=sc();s.scrollTop=s.scrollHeight;};
const near=()=>{const s=sc();return s.scrollHeight-s.scrollTop-s.clientHeight<=120;};const keep=(f)=>(e)=>{const at=near();f(e);if(at)toEnd();};
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
const textEl=(m)=>{const t=el('div','text');if(m.role!=='owner'&&typeof m.html==='string')t.innerHTML=m.html;else t.textContent=String(m.text);return t;};
const msgEl=(m)=>{const d=el('div','msg '+m.role);d.dataset.seq=String(m.seq);d.append(el('div','who',WHO[m.role]||m.role),textEl(m));if(m.state!=='done')d.append(el('small','state',m.error?m.state+': '+m.error:m.state));return d;};
const stepEl=(m)=>{const li=el('li','',m.text);li.dataset.seq=String(m.seq);return li;};
const step=(m)=>{const seq=String(m.seq);for(const g of log.children){if(g.className!=='steps')continue;const old=[...g.querySelector('ol').children].find((li)=>li.dataset.seq===seq);if(old){old.replaceWith(stepEl(m));return;}}let g=log.lastElementChild;if(!g||g.className!=='steps'){g=el('details','steps');g.append(el('summary'),el('ol'));log.append(g);}const ol=g.querySelector('ol');ol.append(stepEl(m));g.querySelector('summary').textContent='Worked through '+ol.children.length+(ol.children.length===1?' step':' steps');};
const put=(m)=>{last=Math.max(last,Number(m.seq)||0);if(m.role==='tool')return step(m);const old=[...log.children].find((c)=>c.dataset.seq===String(m.seq));if(m.role==='assistant'&&live&&!old&&typeof m.html==='string'){live.lastChild.innerHTML=m.html;live.className='msg assistant';live.dataset.seq=String(m.seq);if(m.state!=='done')live.append(el('small','state',m.error?m.state+': '+m.error:m.state));live=null;return;}const node=msgEl(m);if(old)old.replaceWith(node);else log.append(node);if(m.role==='assistant'&&live){live.remove();live=null;}};
const PENDING_MS=${PENDING_MS};const CONFIRM=new RegExp(${JSON.stringify(CONFIRM_LINK.source)});const dlg=document.getElementById('confirm-dialog');const dbody=dlg?dlg.querySelector('.confirm-body'):null;let dcard=null;let dmsg=null;
const drop=(d)=>{for(const s of ['.review','.expiry','noscript']){const x=d.querySelector(s);if(x)x.remove();}};
const setState=(d,t)=>{const st=d.querySelector('.state');if(st)st.textContent=t;else d.append(el('small','state',t));};
const restage=(d)=>{box.value='Stage this change again: '+d.querySelector('.text').textContent;box.focus();};
const expire=(d)=>{if(d.dataset.expired)return;d.dataset.expired='1';delete d.dataset.confirm;d.className+=' expired';drop(d);setState(d,'Expired');const b=el('button','restage','Stage it again');b.type='button';b.addEventListener('click',()=>restage(d));d.append(b);if(dcard===d&&dlg.open)dlg.close();};
const tick=(d)=>{if(!d.dataset.confirm)return;const n=Math.ceil((Date.parse(d.dataset.created)+PENDING_MS-Date.now())/60000);if(!(n>0))return expire(d);const x=d.querySelector('.expiry');if(x)x.textContent='Confirm within '+n+' min';};
const dErr=(t)=>{if(!dmsg){dmsg=el('p','error');dmsg.setAttribute('role','alert');dbody.insertBefore(dmsg,dbody.firstChild);}dmsg.textContent=t;};
const send=async(d,url,f)=>{const q=new URLSearchParams();for(const i of f.querySelectorAll('input'))if(i.name)q.append(i.name,i.value);const m=dbody.querySelector('meta[name=jm-csrf]')||document.querySelector('meta[name=jm-csrf]');let r;try{r=await fetch(url,{method:'POST',credentials:'same-origin',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded','x-jm-csrf':m?m.content:''},body:q.toString()});}catch(x){return dErr('Not sent: '+((x&&x.message)||x));}if(dcard!==d)return;const j=await r.json().catch(()=>({}));
if(r.status===200){delete d.dataset.confirm;drop(d);setState(d,'Confirmed');d.tabIndex=-1;dlg.close();return;}
if(r.status===404||r.status===409)return expire(d);
dErr(r.status===401?'That passphrase is not right.':r.status===429?'Too many wrong passphrases from here: wait '+(Number(j.retryAfter)||1)+' s and try again.':r.status===503?'The passphrase check is busy: try again in a moment.':'Not applied: '+r.status+' '+(j.error||''));const p=f.querySelector('input[type=password]');if(p){p.value='';p.focus();}};
const review=async(d)=>{const url=d.dataset.confirm;if(!url||!CONFIRM.test(url))return;if(typeof HTMLDialogElement!=='function'||!dlg||typeof dlg.showModal!=='function'){location.href=url;return;}
dcard=d;dmsg=null;dbody.textContent='Loading…';if(!dlg.open)dlg.showModal();let r;try{r=await fetch(url+'?frame=1',{credentials:'same-origin',headers:{accept:'text/html'}});}catch(x){return dErr('Could not load the change: '+((x&&x.message)||x));}if(dcard!==d)return;
if(r.status===404)return expire(d);if(!r.ok)return dErr('Could not load the change: '+r.status);const html=await r.text();if(dcard!==d)return;dbody.innerHTML=html;dmsg=null;
const f=dbody.querySelector('form');const c=dbody.querySelector('[data-cancel]');if(c)c.addEventListener('click',()=>dlg.close());if(f)f.addEventListener('submit',(e)=>{e.preventDefault();send(d,url,f);});const p=dbody.querySelector('input[type=password]');if(p)p.focus();};
const wire=(d)=>{const b=d.querySelector('.review');if(b&&d.dataset.confirm)b.addEventListener('click',()=>review(d));const r=d.querySelector('.restage');if(r)r.addEventListener('click',()=>restage(d));tick(d);};
const cardEl=(c)=>{const d=el('div','msg card '+c.state);d.dataset.card=String(c.id);d.append(el('div','who',CARD_TITLE[c.kind]||'Action'),el('div','text',c.summary));if(STATE[c.state])d.append(el('small','state',STATE[c.state]));if(c.state==='pending'&&typeof c.link==='string'&&CONFIRM.test(c.link)){d.dataset.confirm=c.link;d.dataset.created=String(c.createdAt);const b=el('button','review','Review and confirm');b.type='button';d.append(el('small','expiry',''),b);}else if(c.link){const a=el('a','','Open');a.href=c.link;d.append(a);}return d;};
if(dlg){dlg.addEventListener('close',()=>{const d=dcard;dcard=null;dmsg=null;dbody.textContent='';if(d){const t=d.querySelector('.review')||d.querySelector('.restage')||d;if(t.focus)t.focus();}});dlg.addEventListener('cancel',(e)=>{e.preventDefault();dlg.close();});
dlg.addEventListener('keydown',(e)=>{if(e.key==='Escape'){e.preventDefault();dlg.close();return;}if(e.key!=='Tab')return;const f=[...dlg.querySelectorAll('button,input,a[href],textarea,select')].filter((x)=>!x.disabled&&x.type!=='hidden');if(!f.length)return;const a=f[0];const z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus();}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus();}});}
for(const d of log.querySelectorAll('[data-card]'))wire(d);setInterval(()=>{for(const d of log.querySelectorAll('[data-confirm]'))tick(d);},30000);
const follow=()=>{if(es)return;es=new EventSource('/api/chat/threads/'+encodeURIComponent(id)+'/events?after='+last);
es.addEventListener('message',keep((e)=>put(JSON.parse(e.data))));
es.addEventListener('tool',keep((e)=>put({...JSON.parse(e.data),role:'tool'})));
es.addEventListener('text',keep((e)=>{const t=JSON.parse(e.data);if(!live){live=el('div','msg assistant live');live.append(el('div','who',WHO.assistant),el('div','text',''));log.append(live);}const box=live.lastChild;box.textContent=box.textContent?box.textContent+'\\n\\n'+t.text:t.text;}));
es.addEventListener('card',keep((e)=>{const c=JSON.parse(e.data).card;if(!c)return;const old=[...log.children].find((x)=>x.dataset&&x.dataset.card===String(Number(c.id)));if(old&&old.dataset.expired&&c.state==='pending')return;const d=cardEl(c);if(old){if(dcard===old&&dlg.open)dlg.close();old.replaceWith(d);}else log.append(d);wire(d);}));
es.addEventListener('done',()=>{es.close();es=null;});};
const showErr=(t)=>{if(!err){err=el('p','error');err.setAttribute('role','alert');form.insertBefore(err,box);}err.textContent=t;};
form.addEventListener('submit',async(e)=>{e.preventDefault();const text=box.value;if(!text.trim()||btn.disabled)return;btn.disabled=true;try{const r=await jmFetch('/api/chat/threads/'+encodeURIComponent(id)+'/messages',{text});if(r.ok){box.value='';if(err){err.remove();err=null;}put((await r.json()).message);toEnd();follow();}else showErr('Refused: '+r.status+' '+((await r.json().catch(()=>({}))).error??''));}catch(x){showErr('Not sent: '+((x&&x.message)||x));}finally{btn.disabled=false;}});
box.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();form.requestSubmit();}});
toEnd();if(root.dataset.busy==='1')follow();}</script>`;

/**
 * The thread's stored messages and cards in the order they happened: each card after the messages
 * stored up to when it was recorded. Each run of consecutive tool lines is one steps group; any
 * other message or a card ends it, as a streamed one does in the page script.
 */
function logHtml(
  messages: ChatMessage[],
  cards: ChatCard[],
  cardHtml: (c: ChatCard) => string,
): string {
  const out: string[] = [];
  let tools: ChatMessage[] = [];
  const flush = () => {
    if (tools.length > 0) out.push(stepsHtml(tools));
    tools = [];
  };
  let i = 0;
  for (const m of messages) {
    while (i < cards.length && (cards[i] as ChatCard).createdAt < m.createdAt) {
      flush();
      out.push(cardHtml(cards[i] as ChatCard));
      i++;
    }
    if (m.role === 'tool') tools.push(m);
    else {
      flush();
      out.push(messageHtml(m));
    }
  }
  flush();
  for (const c of cards.slice(i)) out.push(cardHtml(c));
  return out.join('');
}

/** The dialog a pending card's Review and confirm opens; its content is only the server's frame. */
const CONFIRM_DIALOG =
  '<dialog id="confirm-dialog" class="confirm-dialog" aria-labelledby="confirm-title"><h2 id="confirm-title">Confirm a guarded change</h2><div class="confirm-body"></div></dialog>';

/**
 * The `/chat/:id` page: the thread's stored messages and cards, the send box and the live stream.
 * `pendingLive` says whether a pending card's change still waits for the viewing session
 * (`store.confirmations.pending`); one that does not, or whose time ran out at `now`, renders as
 * Expired. The stored card is left as it is.
 */
export function renderThread(
  t: ChatThread,
  messages: ChatMessage[],
  cards: ChatCard[] = [],
  o: { zones?: readonly ZoneRef[]; pendingLive?: (pendingId: string) => boolean; now?: Date } = {},
): string {
  const cardHtml = (c: ChatCard): string => {
    const id = cardPendingId(c);
    const expired = id !== undefined && o.pendingLive !== undefined && !o.pendingLive(id);
    return renderCard(c, { expired, ...(o.now ? { now: o.now } : {}) });
  };
  const last = messages.reduce((n, m) => Math.max(n, m.seq), 0);
  const busy = messages.some((m) => m.state === 'queued' || m.state === 'running');
  return page(
    `${CHAT_STYLE}${CHIP_STYLE}<p><a href="/chat">All threads</a></p><h2>${escapeHtml(t.title)}${focusChip(t, o.zones ?? [])}</h2>` +
      `<div id="chat" data-thread="${t.id}" data-last="${last}" data-busy="${busy ? '1' : '0'}">` +
      `<div id="messages" class="chat-log" aria-live="polite">${logHtml(messages, cards, cardHtml)}</div>` +
      `<form id="send" class="chat-send"><textarea name="text" maxlength="20000" required placeholder="Ask Jumpmaster" aria-describedby="send-hint"></textarea><small id="send-hint" class="hint">Enter to send, Shift+Enter for a new line</small><button class="primary">Send</button></form>${CONFIRM_DIALOG}</div>` +
      THREAD_SCRIPT,
    { title: t.title },
  );
}
