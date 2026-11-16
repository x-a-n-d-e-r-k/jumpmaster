// The sticks page (issue #136): every enrolled stick, what it can run, and how many troopers it
// runs at once, set here and applied on its next lease answer with no restart.
import type { ImageFetch } from '@jumpmaster/protocol';
import { STICK_LIVE_MS } from '../doctor/checks.js';
import type { MirrorStatus } from '../images/mirror.js';
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
}

const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(0);

/** `fetching <image> X/Y MB`: the image by its name, without registry or digest. */
export function fetchingLine(f: ImageFetch): string {
  const name = f.ref.replace(/@.*$/, '').split('/').at(-1) || f.ref;
  return `fetching ${name} ${mb(f.done)}/${mb(f.total)} MB`;
}

/** Live, or how long since it was last seen. */
function seen(lastSeenAt: string | null, now: Date): string {
  if (lastSeenAt === null) return 'never seen';
  const ago = now.getTime() - Date.parse(lastSeenAt);
  if (ago <= STICK_LIVE_MS) return 'live';
  const minutes = Math.max(1, Math.round(ago / 60_000));
  return `not seen for ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Saves a row's count through the control route; the answer, or the refusal, shows inline. */
const SLOTS_SCRIPT = `<script>for(const f of document.querySelectorAll('form[data-slots]'))f.addEventListener('submit',async(e)=>{e.preventDefault();const out=f.querySelector('output');const b=f.querySelector('button');b.disabled=true;out.textContent='';try{const r=await jmFetch(f.dataset.slots,{slots:Number(f.querySelector('input').value)});const j=await r.json().catch(()=>({}));out.textContent=r.ok?'Saved: '+j.slots+' at once, from its next lease.':'Refused: '+(j.error??r.status);}catch(err){out.textContent='Refused: '+err;}finally{b.disabled=false;}});</script>`;

export function renderSticks(s: {
  sticks: StickRow[];
  zones: readonly ZoneRef[];
  now: Date;
  /** `server.publicUrl` as an origin; absent, nothing that needs it is offered (issue #139). */
  publicUrl?: string;
  /** The release images the server mirrors for sticks (issue #140); absent, no card. */
  images?: MirrorStatus;
}): string {
  const name = zoneNamer(s.zones);
  const reach = reachLine(s.publicUrl);
  const images = s.images ? imagesCard(s.images) : '';
  if (s.sticks.length === 0)
    return page(
      `<h2>Sticks</h2><p class="empty">No stick has enrolled. See <code>docs/runbooks/install.md</code> to add one.</p>${reach}${images}`,
      { title: 'Sticks' },
    );
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
      return `<tr data-stick="${escapeHtml(st.id)}"><td>${escapeHtml(st.name)}</td><td>${escapeHtml(seen(st.lastSeenAt, s.now))}${st.fetching ? `<br><span class="muted">${escapeHtml(fetchingLine(st.fetching))}</span>` : ''}</td><td>${escapeHtml(st.version ?? '-')}</td><td>${escapeHtml(st.capabilities.join(', ') || '-')}</td><td>${runs}</td><td>${troopers}</td></tr>`;
    })
    .join('');
  return page(
    `<h2>Sticks</h2><p>How many troopers each stick runs at once. A change applies on the stick's next lease, with no restart; lowering it stops nothing that runs. <code>jumpmaster ctl sticks</code> does the same.</p>${reach}` +
      `<table><tr><th>Stick</th><th>Status</th><th>Version</th><th>Capabilities</th><th>Zones</th><th>Troopers</th></tr>${rows}</table>${SLOTS_SCRIPT}${images}`,
    { title: 'Sticks' },
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
