// The sticks page (issue #136): every enrolled stick, what it can run, and how many troopers it
// runs at once, set here and applied on its next lease answer with no restart.
import type { ImageFetch, StickStarting } from '@jumpmaster/protocol';
import { STICK_LIVE_MS } from '../doctor/checks.js';
import type { MirrorStatus } from '../images/mirror.js';
import { MAX_INVITE_SLOTS } from '../install/invite.js';
import { TS_AUTHKEY_PLACEHOLDER } from '../install/stick-sh.js';
import { PUBLIC_URL_NEEDED, PUBLIC_URL_PAGE } from '../reach.js';
import { escapeHtml, page, type StickLine } from './pages.js';
import { type ZoneRef, zoneNamer } from './zone-name.js';

/** The ceiling a stick reports with no JM_MAX_SLOTS and a JM_SLOTS of 4 or less. */
const DEFAULT_CEILING = 4;

/** A stick's row: the floor's line, with its trooper counts. */
export interface StickRow extends StickLine {
  /** The count it runs at: the operator's (or the enrolled one), capped at `maxSlots`. */
  slots: number;
  /** Its ceiling: what it reported, or its enrolled count when too old to report one. */
  maxSlots: number;
  /** Whether it reported its ceiling (false: an old stick, capped at its enrolled count). */
  reported: boolean;
  /** Drops holding one of its lease slots now. */
  running: number;
  /** The image it is downloading from this server now, as it last reported (issue #141). */
  fetching?: ImageFetch;
  /** The image its first health check is checking, as it last reported (issue #157). */
  starting?: StickStarting;
  /** The Docker engine version it last reported (issue #138). */
  dockerVersion?: string | null;
  /** The free space on its drop volumes it last measured (issue #138). */
  freeBytes?: number | null;
}

/** An invite whose stick has not checked in yet (issue #138). */
export interface PendingInviteRow {
  id: string;
  name: string;
  expiresAt: string;
}

const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(0);

/** An image by its name, without registry, tag or digest. */
const imageName = (ref: string): string =>
  ref.replace(/@.*$/, '').split('/').at(-1)?.replace(/:.*$/, '') || ref;

/** `fetching <image> X/Y MB`: the image by its name, without registry or digest. */
export function fetchingLine(f: ImageFetch): string {
  return `fetching ${imageName(f.ref)} ${mb(f.done)}/${mb(f.total)} MB`;
}

/** `starting: checking the trooper image <image>` (issue #157), by the image's name. */
export function startingLine(s: StickStarting): string {
  return `starting: checking the trooper image ${imageName(s.image)}`;
}

/** Live, or how long since it was last seen. */
function seen(lastSeenAt: string | null, now: Date): string {
  if (lastSeenAt === null) return 'never seen';
  const ago = now.getTime() - Date.parse(lastSeenAt);
  if (ago <= STICK_LIVE_MS) return 'live';
  const minutes = Math.max(1, Math.round(ago / 60_000));
  return `not seen for ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Where a stick is on its way to live (issue #138): fetching its images, starting (its first
 * health check, issue #157), then live (its health shown beneath from its first lease), or never
 * seen / not seen for a while.
 */
export function stickStage(st: StickRow, now: Date): { words: string; live: boolean } {
  if (st.fetching) return { words: 'Fetching images', live: false };
  // Seen (it reports in while it starts), but not ready for work until its first check ends.
  if (st.starting) return { words: 'Starting', live: false };
  const s = seen(st.lastSeenAt, now);
  return s === 'live' ? { words: 'Live', live: true } : { words: s, live: false };
}

const gb = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(1)} GB free`;

/** Its health from its advert: the Docker version, egress-v1, image-verify-v1 and free disk. */
export function healthLine(st: StickRow): string {
  const has = (c: string) => `${c} ${st.capabilities.includes(c) ? 'yes' : 'no'}`;
  return [
    `Docker ${st.dockerVersion ?? 'unknown'}`,
    has('egress-v1'),
    has('image-verify-v1'),
    st.freeBytes === null || st.freeBytes === undefined ? 'free disk unmeasured' : gb(st.freeBytes),
  ].join(', ');
}

/**
 * Every write on this page: the passphrase first when it was asked for (sudo), then the request;
 * a refusal that needs sudo shows the passphrase field. The slots, Cancel and Remove controls
 * are found by delegation, so rows the poll replaces keep working.
 */
const STICKS_SCRIPT = `<script>
async function jmSticks(path,body){const p=document.getElementById('sticks-sudo');if(p&&p.value){const s=await jmFetch('/api/control/sudo',{passphrase:p.value});p.value='';if(!s.ok){p.closest('p').hidden=false;p.focus();return {ok:false,error:'The passphrase was not accepted.'};}}const r=await jmFetch(path,body);if(r.ok)return {ok:true,r};const j=await r.json().catch(()=>({}));if(r.status===403&&j.sudo&&p){p.closest('p').hidden=false;p.focus();return {ok:false,error:'Enter your passphrase, then press again.'};}return {ok:false,error:j.error??String(r.status),settings:j.settings};}
document.addEventListener('submit',async(e)=>{const f=e.target.closest('form[data-slots]');if(!f)return;e.preventDefault();const out=f.querySelector('output');const b=f.querySelector('button');b.disabled=true;out.textContent='';try{const r=await jmFetch(f.dataset.slots,{slots:Number(f.querySelector('input').value)});const j=await r.json().catch(()=>({}));out.textContent=r.ok?'Saved: '+j.slots+' at once, from its next lease.':'Refused: '+(j.error??r.status);}catch(err){out.textContent='Refused: '+err;}finally{b.disabled=false;}});
document.addEventListener('click',async(e)=>{const b=e.target.closest('button[data-cancel],button[data-remove]');if(!b)return;if(b.dataset.remove&&!confirm(b.dataset.ask))return;const out=b.parentElement.querySelector('output');b.disabled=true;const a=await jmSticks(b.dataset.cancel||b.dataset.remove,{});b.disabled=false;if(a.ok)location.reload();else if(out)out.textContent='Refused: '+a.error;});
const add=document.getElementById('add-stick');if(add)add.addEventListener('submit',async(e)=>{e.preventDefault();const out=document.getElementById('add-out');out.textContent='';const n=add.querySelector('[name=slots]').value.trim();const a=await jmSticks('/sticks/add',{name:add.querySelector('[name=name]').value.trim(),slots:n===''?'auto':Number(n)});if(a.ok){const html=await a.r.text();document.open();document.write(html);document.close();return;}out.textContent='Refused: '+a.error;if(a.settings){const l=document.createElement('a');l.href=a.settings;l.textContent=' Settings';out.append(l);}});
function jmPoll(){if(!document.querySelector('#sticks-live [data-poll]'))return;setTimeout(async()=>{try{const r=await fetch(location.pathname,{headers:{accept:'text/html'}});if(r.ok){const d=new DOMParser().parseFromString(await r.text(),'text/html');const next=d.getElementById('sticks-live');const cur=document.getElementById('sticks-live');if(next&&cur)cur.replaceWith(next);}}catch{}jmPoll();},3000);}
jmPoll();
</script>`;

export function renderSticks(s: {
  sticks: StickRow[];
  zones: readonly ZoneRef[];
  now: Date;
  /** `server.publicUrl` as an origin; absent, nothing that needs it is offered (issue #139). */
  publicUrl?: string;
  /** The release images the server mirrors for sticks (issue #140); absent, no card. */
  images?: MirrorStatus;
  /** Invites waiting for their stick to check in (issue #138). */
  pending?: PendingInviteRow[];
}): string {
  const name = zoneNamer(s.zones);
  const reach = reachLine(s.publicUrl);
  const images = s.images ? imagesCard(s.images) : '';
  const pending = (s.pending ?? [])
    .map((i) => {
      const url = `/api/control/sticks/invites/${encodeURIComponent(i.id)}/cancel`;
      return `<li data-invite="${escapeHtml(i.id)}" data-poll><span>${escapeHtml(`${i.name}: waiting for it to check in (expires ${i.expiresAt})`)}</span> <button class="danger" data-cancel="${escapeHtml(url)}">Cancel</button> <output aria-live="polite"></output></li>`;
    })
    .join('');
  const waiting = pending ? `<h3>Waiting to check in</h3><ul class="pending">${pending}</ul>` : '';
  const rows = s.sticks
    .map((st) => {
      const runs =
        st.cannotRun.length === 0
          ? 'all zones'
          : st.cannotRun
              .map((c) => `cannot run ${name(c.zoneId)}: lacks ${escapeHtml(c.missing.join(', '))}`)
              .join('<br>');
      const url = `/api/control/sticks/${encodeURIComponent(st.id)}/slots`;
      // Capped by its version (it reports no ceiling), or below the default ceiling of 4, which
      // only JM_MAX_SLOTS (or a small drop subnet pool) brings it to: say how to allow more.
      const capped = !st.reported || st.maxSlots < DEFAULT_CEILING;
      const note = capped
        ? `<p class="muted">This stick allows up to ${st.maxSlots}. To allow more, set <code>JM_MAX_SLOTS</code> on that machine and restart it.</p>`
        : '';
      const label = `Troopers for ${st.name}`;
      const troopers =
        `<form data-slots="${escapeHtml(url)}"><input type="number" name="slots" min="1" max="${st.maxSlots}" value="${st.slots}" aria-label="${escapeHtml(label)}" required> <button>Save</button> <output aria-live="polite"></output></form>` +
        `<p>Running now: ${st.running} of ${st.slots}</p>${note}`;
      const stage = stickStage(st, s.now);
      const status =
        `<span class="stage">${escapeHtml(stage.words)}</span>` +
        (st.fetching
          ? `<br><span class="muted">${escapeHtml(fetchingLine(st.fetching))}</span>`
          : '') +
        (st.starting
          ? `<br><span class="muted starting">${escapeHtml(startingLine(st.starting))}</span>`
          : '') +
        (st.lastSeenAt !== null
          ? `<br><span class="muted health">${escapeHtml(healthLine(st))}</span>`
          : '');
      const removeUrl = `/api/control/sticks/${encodeURIComponent(st.id)}/remove`;
      const ask = `Remove the stick ${st.name}? Its token is revoked at once; drops it leased but never started go back to the queue. Run the installer with --uninstall on that machine to remove its container.`;
      const remove = `<button class="danger" data-remove="${escapeHtml(removeUrl)}" data-ask="${escapeHtml(ask)}">Remove</button> <output aria-live="polite"></output>`;
      return `<tr${stage.live ? '' : ' data-poll'} data-stick="${escapeHtml(st.id)}"><td>${escapeHtml(st.name)}</td><td>${status}</td><td>${escapeHtml(st.version ?? '-')}</td><td>${escapeHtml(st.capabilities.join(', ') || '-')}</td><td>${runs}</td><td>${troopers}</td><td>${remove}</td></tr>`;
    })
    .join('');
  const table =
    s.sticks.length === 0
      ? '<p class="empty">No stick has enrolled. Add one below, or see <code>docs/runbooks/install.md</code>.</p>'
      : `<table><tr><th>Stick</th><th>Status</th><th>Version</th><th>Capabilities</th><th>Zones</th><th>Troopers</th><th></th></tr>${rows}</table>`;
  return page(
    `<h2>Sticks</h2><p>How many troopers each stick runs at once. A change applies on the stick's next lease, with no restart; lowering it stops nothing that runs. <code>jumpmaster ctl sticks</code> does the same.</p>${reach}` +
      `<div id="sticks-live">${table}${waiting}</div>${addForm(s.publicUrl)}${STICKS_SCRIPT}${images}`,
    { title: 'Sticks' },
  );
}

/** The passphrase a session re-enters for sudo: hidden until a write asks for it. */
const SUDO_FIELD =
  '<p class="sudo" hidden><label>Your passphrase (adding, cancelling or removing a stick asks for it again) <input type="password" id="sticks-sudo" autocomplete="current-password"></label></p>';

/** Add a stick (issue #138): a name and a trooper count; with no public address, the way to set it. */
function addForm(publicUrl: string | undefined): string {
  const fields = `<p><label>Name <input name="name" required maxlength="64" pattern="[A-Za-z0-9._\\-]{1,64}" placeholder="vps-1"></label> <label>Troopers <input name="slots" type="number" min="1" max="${MAX_INVITE_SLOTS}" placeholder="Auto"></label> <span class="muted">Leave Troopers empty for Auto: as many as the machine allows.</span></p>`;
  const body = publicUrl
    ? `<form id="add-stick">${fields}${SUDO_FIELD}<p><button class="primary">Add a stick</button> <output id="add-out" aria-live="polite"></output></p></form>`
    : `<p class="warn"><a href="${PUBLIC_URL_PAGE}">${PUBLIC_URL_NEEDED}</a> to add a stick: the new machine downloads it from that address.</p>${SUDO_FIELD}`;
  return `<h3>Add a stick</h3><p>One line pasted on a Linux machine (x86_64 or aarch64) or a Mac with Docker Desktop that reaches this server, such as a VPS on your tailnet, installs a stick and enrolls it.</p>${body}`;
}

/** The result page (issue #138): the code's only showing, in the line and the cloud-init. */
export function renderInviteResult(r: {
  name: string;
  slots: number | null;
  expiresAt: string;
  line: string;
  cloudInit: string;
}): string {
  const troopers = r.slots === null ? 'Auto' : String(r.slots);
  const script = `<script>for(const t of document.querySelectorAll('[role=tab]'))t.addEventListener('click',()=>{for(const o of document.querySelectorAll('[role=tab]')){const on=o===t;o.setAttribute('aria-selected',String(on));document.getElementById(o.getAttribute('aria-controls')).hidden=!on;}});for(const b of document.querySelectorAll('button[data-copy]'))b.addEventListener('click',async()=>{await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);b.textContent='Copied';});</script>`;
  return page(
    `<h2>Add a stick: ${escapeHtml(r.name)}</h2>` +
      `<p class="warn"><strong>This code works once, until ${escapeHtml(r.expiresAt)} (24 hours). It won't be shown again:</strong> copy what you need now. Troopers: ${escapeHtml(troopers)}.</p>` +
      `<div role="tablist"><button role="tab" id="tab-paste" aria-controls="panel-paste" aria-selected="true">Paste on the machine</button> <button role="tab" id="tab-cloud" aria-controls="panel-cloud" aria-selected="false">Paste when creating the VPS</button></div>` +
      `<section role="tabpanel" id="panel-paste" aria-labelledby="tab-paste"><p>On the machine, as a user who can sudo:</p><pre><code id="install-line">${escapeHtml(r.line)}</code></pre><p><button data-copy="install-line">Copy</button></p><p>It installs Docker if the machine has none (it asks first; add <code>--yes</code> before the code not to be asked), downloads cosign and the stick image from this server, verifies the image's signature offline, starts the stick and waits for it to enroll. The machine needs no registry or GitHub access.</p></section>` +
      `<section role="tabpanel" id="panel-cloud" aria-labelledby="tab-cloud" hidden><p>Paste this as the user data (cloud-init) when you create the VPS. Replace <code>${TS_AUTHKEY_PLACEHOLDER}</code> with an auth key from your Tailscale admin console (Settings, Keys) first: the machine joins your tailnet, then runs the same installer line.</p><pre><code id="cloud-init">${escapeHtml(r.cloudInit)}</code></pre><p><button data-copy="cloud-init">Copy</button></p></section>` +
      `<p><a href="/sticks">Back to the sticks page</a>: it reads "${escapeHtml(r.name)}: waiting for it to check in" until the stick enrolls.</p>${script}`,
    { title: 'Add a stick' },
  );
}

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** The images card: each image the mirror holds for sticks, its platforms, size and state. */
function imagesCard(m: MirrorStatus): string {
  const intro =
    '<p>The release images this server keeps for sticks, with their signatures: a stick fetches them from here and verifies each signature itself.</p>';
  if (!m.lock && m.images.length === 0)
    return `<h3>Images</h3><p class="empty">No image lock: this server runs from a checkout, so there is nothing to mirror.</p>`;
  const rows = m.images
    .map((i) => {
      const state = i.state === 'failed' ? `failed: ${i.error ?? 'unknown'}` : i.state;
      const when = i.current ? '' : ' (previous release)';
      return `<tr data-image="${escapeHtml(i.name)}"><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.platforms.join(', ') || '-')}</td><td>${i.size > 0 ? mib(i.size) : '-'}</td><td>${escapeHtml(state + when)}</td><td><code>${escapeHtml(i.digest)}</code></td></tr>`;
    })
    .join('');
  return `<h3>Images</h3>${intro}<table><tr><th>Image</th><th>Platforms</th><th>Size</th><th>State</th><th>Digest</th></tr>${rows}</table>`;
}

/**
 * Where a new machine reaches this server: the address once set, else the words and the link to
 * set it, and nothing that needs it.
 */
export function reachLine(publicUrl: string | undefined): string {
  return publicUrl
    ? `<p class="reach">Other machines reach this server at <code>${escapeHtml(publicUrl)}</code> (<a href="${PUBLIC_URL_PAGE}">Other machines</a>).</p>`
    : `<p class="reach warn"><a href="${PUBLIC_URL_PAGE}">${PUBLIC_URL_NEEDED}</a> before adding a stick on another machine.</p>`;
}
