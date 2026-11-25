import type { Gate, GateReason } from '../usage.js';
import { gateReasonText, OVERRIDE_CEILING, OVERRIDE_DEFAULTS } from '../usage.js';
import { escapeHtml } from './pages.js';

/** The override's control route (#728): POST sets it (no body: the defaults), DELETE clears it. */
const ROUTE = '/api/control/usage/override';

/** What the control reads of the usage state. */
export type OverrideUsage = {
  gate: Gate;
  /** What holds the gate (#753), from `gateReason`; the dialog names it (#905). */
  reason?: GateReason | undefined;
  state: {
    overrideStartsLeft: number | null;
    overrideStarts: number | null;
    overrideUntil: string | null;
  };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;

/** A time as a clock reads it, in UTC: "HH:MM UTC", with the day when a day or more off. */
export function clockTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const attr = escapeHtml(iso);
  if (Number.isNaN(at.getTime())) return attr;
  const hm = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  const day =
    Math.abs(at.getTime() - now.getTime()) < DAY
      ? ''
      : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} `;
  return `<time datetime="${attr}" title="${attr}">${day}${hm} UTC</time>`;
}

/**
 * The override's script (#729), built like the kill switch's: the button opens the dialog, Cancel
 * shuts it, and only Confirm posts, once at a time; Stop sends DELETE. A refusal or a network
 * failure is said in place, and nothing changes. It never calls `alert()`.
 */
export const USAGE_OVERRIDE_SCRIPT = `<script>(()=>{const $=(i)=>document.getElementById(i);const say=async(r)=>{const j=await r.json().catch(()=>({}));return 'Refused ('+r.status+')'+(j&&j.error?': '+j.error:'');};const lost=(err)=>'Could not reach the server: '+((err&&err.message)||err);
const o=$('usage-override-open'),d=$('usage-override-dialog'),c=$('usage-override-confirm'),x=$('usage-override-cancel'),e=$('usage-override-err');
if(o&&d&&c&&x&&e){let busy=false;const show=()=>{e.textContent='';if(typeof d.showModal==='function')d.showModal();else d.setAttribute('open','');if(c.focus)c.focus();};const hide=()=>{if(typeof d.close==='function')d.close();else d.removeAttribute('open');if(o.focus)o.focus();};
o.addEventListener('click',show);x.addEventListener('click',hide);
c.addEventListener('click',async()=>{if(busy)return;busy=true;c.disabled=true;e.textContent='';try{const r=await jmFetch('${ROUTE}',undefined,'POST');if(r.ok){location.reload();return;}e.textContent=await say(r);}catch(err){e.textContent=lost(err);}finally{busy=false;c.disabled=false;}});}
const s=$('usage-override-stop'),se=$('usage-override-stop-err');
if(s&&se){let busy=false;s.addEventListener('click',async()=>{if(busy)return;busy=true;s.disabled=true;se.textContent='';try{const r=await jmFetch('${ROUTE}',undefined,'DELETE');if(r.ok){location.reload();return;}se.textContent=await say(r);}catch(err){se.textContent=lost(err);}finally{busy=false;s.disabled=false;}});}})();</script>`;

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * What holds work, for the dialog (#905): the window at the threshold with its reset, or Claude's
 * warning; else neutral words that claim neither.
 */
function heldWords(r: GateReason | undefined, now: Date): string {
  if (r?.kind !== 'threshold' && r?.kind !== 'warning') return 'usage is near its limit';
  const reset = r.resetsAt ? `, resetting at ${clockTime(r.resetsAt, now)}` : '';
  const why = escapeHtml(gateReasonText(r));
  return r.kind === 'warning' ? `Claude's warning holds work: ${why}${reset}` : `${why}${reset}`;
}

/**
 * Home's control for Command's usage override (#729), beside the gate's words: while the throttle
 * holds work and no override is in force, "Run the next cycle anyway" and its confirmation; while
 * one is in force, its starts left and "Stop the override". Else nothing.
 */
export function usageOverrideControl(u: OverrideUsage, now: Date): string {
  const s = u.state;
  if (u.gate === 'override') {
    const until = s.overrideUntil ? `, until ${clockTime(s.overrideUntil, now)}` : '';
    return (
      `<div class="usage-override"><p>Usage override: ${s.overrideStartsLeft ?? 0} of ${s.overrideStarts ?? 0} starts left${until}</p>` +
      `<button type="button" id="usage-override-stop">Stop the override</button>` +
      `<p id="usage-override-stop-err" class="kill-err" role="alert"></p></div>` +
      USAGE_OVERRIDE_SCRIPT
    );
  }
  if (u.gate !== 'finishing_only') return '';
  const { starts, hours } = OVERRIDE_DEFAULTS;
  const what = `Work is held because ${heldWords(u.reason, now)}. Jumpmaster will start up to ${starts} new drops in the next ${hours} hours anyway. It stops early if usage reaches ${pct(OVERRIDE_CEILING)} or Claude refuses a request.`;
  return (
    `<div class="usage-override"><button type="button" id="usage-override-open" class="primary" aria-haspopup="dialog" aria-controls="usage-override-dialog">Run the next cycle anyway</button>` +
    `<dialog id="usage-override-dialog" class="kill-dialog" aria-labelledby="usage-override-title"><h2 id="usage-override-title">Run the next cycle anyway?</h2><p id="usage-override-what">${what}</p>` +
    `<p id="usage-override-err" class="kill-err" role="alert"></p>` +
    `<div class="kill-actions"><button type="button" id="usage-override-confirm" class="primary">Run anyway</button><button type="button" id="usage-override-cancel">Cancel</button></div></dialog></div>` +
    USAGE_OVERRIDE_SCRIPT
  );
}
