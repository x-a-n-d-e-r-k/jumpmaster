// The sticks page (issue #136): every enrolled stick, what it can run, and how many troopers it
// runs at once, set here and applied on its next lease answer with no restart.
import { STICK_LIVE_MS } from '../doctor/checks.js';
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
}): string {
  const name = zoneNamer(s.zones);
  if (s.sticks.length === 0)
    return page(
      '<h2>Sticks</h2><p class="empty">No stick has enrolled. See <code>docs/runbooks/install.md</code> to add one.</p>',
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
      return `<tr data-stick="${escapeHtml(st.id)}"><td>${escapeHtml(st.name)}</td><td>${escapeHtml(seen(st.lastSeenAt, s.now))}</td><td>${escapeHtml(st.version ?? '-')}</td><td>${escapeHtml(st.capabilities.join(', ') || '-')}</td><td>${runs}</td><td>${troopers}</td></tr>`;
    })
    .join('');
  return page(
    `<h2>Sticks</h2><p>How many troopers each stick runs at once. A change applies on the stick's next lease, with no restart; lowering it stops nothing that runs. <code>jumpmaster ctl sticks</code> does the same.</p>` +
      `<table><tr><th>Stick</th><th>Status</th><th>Version</th><th>Capabilities</th><th>Zones</th><th>Troopers</th></tr>${rows}</table>${SLOTS_SCRIPT}`,
    { title: 'Sticks' },
  );
}
