/**
 * The page stylesheet: AlignUI's design tokens and component styles, ported to plain CSS.
 *
 * AlignUI (https://www.alignui.com) ships React + Tailwind components; these pages are server
 * rendered strings with no browser build, so the components cannot be used as code. What carries
 * over is the system: the colour, type, radius and shadow tokens and the look of Button, Input,
 * StatusBadge, Alert, Table and the horizontal Tab Menu, applied to the plain semantic elements the
 * pages already emit (h2, table, form controls, nav, fieldset). Token values are copied from
 * AlignUI's starter (`app/globals.css`, `tailwind.config.ts`), MIT licensed, (c) 2024 Doğukan Çavuş.
 *
 * Dark mode follows the operator's system setting; there is no toggle to store.
 */

const TOKENS = `
:root{color-scheme:light dark;
--gray-950:#171717;--gray-900:#1c1c1c;--gray-800:#292929;--gray-700:#333;--gray-600:#5c5c5c;--gray-500:#7b7b7b;--gray-400:#a3a3a3;--gray-300:#d1d1d1;--gray-200:#ebebeb;--gray-100:#f5f5f5;--gray-50:#f7f7f7;--gray-0:#fff;
--gray-alpha-24:#a3a3a33d;--gray-alpha-16:#a3a3a329;--gray-alpha-10:#a3a3a31a;
--blue-950:#122368;--blue-800:#1f3bad;--blue-700:#2547d0;--blue-500:#335cff;--blue-400:#6895ff;--blue-200:#c0d5ff;--blue-50:#ebf1ff;--blue-alpha-24:#476cff3d;--blue-alpha-16:#476cff29;--blue-alpha-10:#476cff1a;
--orange-950:#71330a;--orange-600:#e16614;--orange-500:#fa7319;--orange-400:#ffa468;--orange-200:#ffd9c0;--orange-50:#fff3eb;--orange-alpha-24:#ff91473d;--orange-alpha-16:#ff914729;
--red-950:#681219;--red-600:#e93544;--red-500:#fb3748;--red-400:#ff6875;--red-200:#ffc0c5;--red-50:#ffebec;--red-alpha-24:#fb37483d;--red-alpha-16:#fb374829;--red-alpha-10:#fb37481a;
--green-950:#0b4627;--green-600:#1daf61;--green-500:#1fc16b;--green-400:#3ee089;--green-200:#c2f5da;--green-50:#e0faec;--green-alpha-24:#1fc16b3d;--green-alpha-16:#1fc16b29;
--purple-950:#351a75;--purple-500:#7d52f4;--purple-400:#8c71f6;--purple-200:#cac0ff;--purple-50:#efebff;--purple-alpha-16:#784def29;
--primary-dark:var(--blue-800);--primary-darker:var(--blue-700);--primary-base:var(--blue-500);--primary-alpha-10:var(--blue-alpha-10);--primary-alpha-16:var(--blue-alpha-16);
--static-white:#fff;
--bg-strong-950:var(--gray-950);--bg-surface-800:var(--gray-800);--bg-sub-300:var(--gray-300);--bg-soft-200:var(--gray-200);--bg-weak-50:var(--gray-50);--bg-white-0:var(--gray-0);
--text-strong-950:var(--gray-950);--text-sub-600:var(--gray-600);--text-soft-400:var(--gray-400);--text-disabled-300:var(--gray-300);--text-white-0:var(--gray-0);
--stroke-strong-950:var(--gray-950);--stroke-sub-300:var(--gray-300);--stroke-soft-200:var(--gray-200);
--faded-base:var(--gray-500);--faded-lighter:var(--gray-100);
--information-dark:var(--blue-950);--information-base:var(--blue-500);--information-light:var(--blue-200);--information-lighter:var(--blue-50);
--warning-dark:var(--orange-950);--warning-base:var(--orange-500);--warning-light:var(--orange-200);--warning-lighter:var(--orange-50);
--error-dark:var(--red-950);--error-base:var(--red-500);--error-light:var(--red-200);--error-lighter:var(--red-50);
--success-dark:var(--green-950);--success-base:var(--green-500);--success-light:var(--green-200);--success-lighter:var(--green-50);
--feature-dark:var(--purple-950);--feature-base:var(--purple-500);--feature-light:var(--purple-200);--feature-lighter:var(--purple-50);
--shadow-xs:0 1px 2px 0 #0a0d1408;--shadow-md:0 16px 32px -12px #0e121b1a;
--focus-important:0 0 0 2px var(--bg-white-0),0 0 0 4px var(--gray-alpha-16);
--focus-primary:0 0 0 2px var(--bg-white-0),0 0 0 4px var(--primary-alpha-16);
--focus-error:0 0 0 2px var(--bg-white-0),0 0 0 4px var(--red-alpha-10);
--font-sans:Inter,"Inter Variable",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--bg-strong-950:var(--gray-0);--bg-surface-800:var(--gray-200);--bg-sub-300:var(--gray-600);--bg-soft-200:var(--gray-700);--bg-weak-50:var(--gray-900);--bg-white-0:var(--gray-950);
--text-strong-950:var(--gray-0);--text-sub-600:var(--gray-400);--text-soft-400:var(--gray-500);--text-disabled-300:var(--gray-600);--text-white-0:var(--gray-950);
--stroke-strong-950:var(--gray-0);--stroke-sub-300:var(--gray-600);--stroke-soft-200:var(--gray-700);
--faded-base:var(--gray-500);--faded-lighter:var(--gray-alpha-16);
--information-dark:var(--blue-400);--information-light:var(--blue-alpha-24);--information-lighter:var(--blue-alpha-16);
--warning-dark:var(--orange-400);--warning-base:var(--orange-600);--warning-light:var(--orange-alpha-24);--warning-lighter:var(--orange-alpha-16);
--error-dark:var(--red-400);--error-base:var(--red-600);--error-light:var(--red-alpha-24);--error-lighter:var(--red-alpha-16);
--success-dark:var(--green-400);--success-base:var(--green-600);--success-light:var(--green-alpha-24);--success-lighter:var(--green-alpha-16);
--feature-dark:var(--purple-400);--feature-light:var(--purple-alpha-16);--feature-lighter:var(--purple-alpha-16);
--shadow-xs:0 1px 2px 0 #0000003d}}`;

/** Elements as AlignUI draws them: type scale, Table, Input, Button, links, code. */
const BASE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg-weak-50);color:var(--text-strong-950);font:400 .875rem/1.25rem var(--font-sans);letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
a{color:var(--primary-base);text-decoration:none;font-weight:500;border-radius:4px}
a:hover{text-decoration:underline;text-underline-offset:3px}
a:focus-visible{outline:none;box-shadow:var(--focus-primary)}
h1,h2,h3,h4{margin:0;font-weight:500;color:var(--text-strong-950)}
h2{font-size:1.5rem;line-height:2rem;margin:2rem 0 .75rem}
h3{font-size:1.125rem;line-height:1.5rem;letter-spacing:-.015em;margin:1.5rem 0 .5rem}
h4{font-size:.875rem;line-height:1.25rem;margin:1rem 0 .5rem}
p{margin:.5rem 0}
small{font-size:.75rem;line-height:1rem;color:var(--text-sub-600);letter-spacing:0}
code{font:.8125rem/1.25rem var(--font-mono);background:var(--bg-weak-50);border:1px solid var(--stroke-soft-200);border-radius:6px;padding:0 .3rem;overflow-wrap:anywhere}
pre{font:.8125rem/1.25rem var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;margin:.25rem 0}
td pre{background:var(--bg-weak-50);border-radius:8px;padding:.5rem .625rem}
ul{margin:.5rem 0;padding-left:1.25rem}li{margin:.25rem 0}
hr{border:0;border-top:1px solid var(--stroke-soft-200);margin:1.5rem 0}
table{border-collapse:separate;border-spacing:0;width:100%;margin:0 0 1.5rem;background:var(--bg-white-0);border:1px solid var(--stroke-soft-200);border-radius:12px;box-shadow:var(--shadow-xs);overflow:hidden}
th,td{padding:.625rem .75rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--stroke-soft-200)}
tr:last-child>td,tr:last-child>th{border-bottom:0}
tr:first-child>th{background:var(--bg-weak-50);color:var(--text-sub-600);font-weight:400;white-space:nowrap}
th{font-weight:500;color:var(--text-sub-600)}
tr:has(>td)>th{background:var(--bg-weak-50);font-weight:400;width:11rem}
tbody tr:hover>td,table>tr:hover>td{background:var(--bg-weak-50)}
@media (max-width:720px){table{display:block;overflow-x:auto}}
label{color:var(--text-strong-950)}
input:not([type=radio]):not([type=checkbox]):not([type=hidden]),select,textarea{font:inherit;letter-spacing:inherit;color:var(--text-strong-950);background:var(--bg-white-0);border:0;border-radius:10px;box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--stroke-soft-200);padding:.5rem .75rem;min-height:2.5rem;max-width:100%;transition:background-color .2s ease-out,box-shadow .2s ease-out}
textarea{min-height:5rem;width:100%;resize:vertical;display:block;margin:.25rem 0}
input::placeholder,textarea::placeholder{color:var(--text-soft-400)}
input:not([type=radio]):not([type=checkbox]):hover,select:hover,textarea:hover{background:var(--bg-weak-50)}
input:not([type=radio]):not([type=checkbox]):focus,select:focus,textarea:focus{outline:none;background:var(--bg-white-0);box-shadow:var(--focus-important),inset 0 0 0 1px var(--stroke-strong-950)}
input:disabled,select:disabled,textarea:disabled{background:var(--bg-weak-50);color:var(--text-disabled-300);box-shadow:none}
input[type=radio],input[type=checkbox]{accent-color:var(--primary-base);width:1rem;height:1rem;margin:0 .375rem 0 0;vertical-align:-.15rem}
fieldset{border:1px solid var(--stroke-soft-200);border-radius:16px;background:var(--bg-white-0);box-shadow:var(--shadow-xs);padding:1rem 1.25rem 1.25rem;margin:0 0 1rem;min-width:0}
legend{font-weight:500;padding:0 .375rem;margin-left:-.375rem;color:var(--text-strong-950)}
button{font:500 .875rem/1.25rem var(--font-sans);letter-spacing:-.006em;display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.25rem;padding:0 .75rem;border:0;border-radius:8px;cursor:pointer;white-space:nowrap;background:var(--bg-white-0);color:var(--text-sub-600);box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--stroke-soft-200);transition:background-color .2s ease-out,color .2s ease-out,box-shadow .2s ease-out}
button:hover{background:var(--bg-weak-50);color:var(--text-strong-950);box-shadow:none}
button:focus-visible{outline:none;color:var(--text-strong-950);box-shadow:var(--focus-important),inset 0 0 0 1px var(--stroke-strong-950)}
button:disabled{cursor:default;background:var(--bg-weak-50);color:var(--text-disabled-300);box-shadow:none}
button.primary,form.primary button,form.rule button{background:var(--primary-base);color:var(--static-white);box-shadow:none}
button.primary:hover,form.primary button:hover,form.rule button:hover{background:var(--primary-darker);color:var(--static-white)}
button.primary:focus-visible,form.primary button:focus-visible,form.rule button:focus-visible{box-shadow:var(--focus-primary)}
button.danger,button.revoke,button.remove{background:var(--bg-white-0);color:var(--error-base);box-shadow:inset 0 0 0 1px var(--error-base)}
button.danger:hover,button.revoke:hover,button.remove:hover{background:var(--red-alpha-10);color:var(--error-base)}
button.danger:focus-visible,button.revoke:focus-visible,button.remove:focus-visible{box-shadow:var(--focus-error),inset 0 0 0 1px var(--error-base)}
button.danger-filled{background:var(--error-base);color:var(--static-white);box-shadow:none}
button.danger-filled:hover{background:var(--red-600);color:var(--static-white)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

/** The shell (top bar, tabs), the floor's cards and the AlignUI Alert and StatusBadge. */
const SHELL = `
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:.5rem;z-index:2;background:var(--bg-white-0);padding:.5rem .75rem}
.topbar{position:sticky;top:0;z-index:1;background:var(--bg-white-0);border-bottom:1px solid var(--stroke-soft-200)}
.topbar-in{max-width:76rem;margin:0 auto;padding:0 1.5rem;display:flex;align-items:center;gap:1.5rem;min-height:3.5rem}
.brand{display:inline-flex;align-items:center;gap:.5rem;font:500 1rem/1.5rem var(--font-sans);letter-spacing:-.011em;color:var(--text-strong-950);margin:0}
.brand svg{flex:none;color:var(--primary-base)}
.topnav{display:flex;gap:.25rem;flex:1;min-width:0;overflow-x:auto}
.topnav a{color:var(--text-sub-600);padding:.375rem .625rem;border-radius:8px;white-space:nowrap}
.topnav a:hover{background:var(--bg-weak-50);color:var(--text-strong-950);text-decoration:none}
.topnav a[aria-current=page]{background:var(--bg-weak-50);color:var(--text-strong-950)}
.logout{margin:0 0 0 auto}.logout button{min-height:2rem}
main{max-width:76rem;margin:0 auto;padding:1.5rem 1.5rem 4rem}
main>h2:first-child,main>p:first-child+h2{margin-top:.5rem}
@media (max-width:720px){.topbar-in{padding:0 1rem;gap:.75rem;flex-wrap:wrap;padding-top:.5rem}.topnav{order:3;flex-basis:100%;padding-bottom:.375rem;margin:0 -.25rem}main{padding:1rem 1rem 3rem}h2{font-size:1.25rem;line-height:1.75rem}}
nav.settings-tabs,.setup-steps{display:flex;gap:1.5rem;border-bottom:1px solid var(--stroke-soft-200);margin:0 0 1.5rem;overflow-x:auto;font-weight:500;color:var(--text-soft-400)}
nav.settings-tabs>*,.setup-steps>*{padding:.875rem 0 .75rem;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-1px}
nav.settings-tabs a,.setup-steps a{color:var(--text-sub-600);border-radius:0}
nav.settings-tabs a:hover,.setup-steps a:hover{color:var(--text-strong-950);text-decoration:none}
nav.settings-tabs strong,nav.settings-tabs [aria-current],.setup-steps strong{color:var(--text-strong-950);border-bottom-color:var(--primary-base);font-weight:500}
.warn,.status,.error,.alert{display:block;border-radius:12px;padding:.75rem 1rem;margin:0 0 1rem;background:var(--warning-lighter);color:var(--text-strong-950);box-shadow:inset 0 0 0 1px var(--warning-light)}
.warn::before,.error::before{content:"";float:left;width:1rem;height:1rem;margin:.125rem .5rem 0 0;border-radius:50%;background:var(--warning-base);-webkit-mask:var(--ico-alert) center/contain no-repeat;mask:var(--ico-alert) center/contain no-repeat}
.warn>p:first-child,.status>p:first-child{margin-top:0}.warn>p:last-child,.status>p:last-child{margin-bottom:0}
.warn form,.setup-frame form{margin:.5rem 0 0}
.error,.fail-alert{background:var(--error-lighter);box-shadow:inset 0 0 0 1px var(--error-light)}
.error::before{background:var(--error-base)}
form[action="/login"] label,form[action^="/setup/"] label{display:inline-grid;gap:.375rem;width:min(100%,22rem);vertical-align:bottom;margin-right:.5rem}
form[action="/login"] input,form[action^="/setup/"] input{width:100%}
.saved{color:var(--success-base);font-weight:500}
:root{--ico-alert:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10Zm-1-7v2h2v-2h-2Zm0-8v6h2V7h-2Z'/%3E%3C/svg%3E")}
.badge{display:inline-flex;align-items:center;gap:.375rem;height:1.5rem;padding:0 .5rem;border-radius:6px;font:500 .75rem/1rem var(--font-sans);letter-spacing:0;white-space:nowrap;background:var(--faded-lighter);color:var(--text-sub-600)}
.badge::before{content:"";width:.375rem;height:.375rem;border-radius:50%;background:currentColor}
.badge.info{background:var(--information-lighter);color:var(--information-base)}
.badge.ok{background:var(--success-lighter);color:var(--success-base)}
.badge.warn-b{background:var(--warning-lighter);color:var(--warning-base)}
.badge.bad{background:var(--error-lighter);color:var(--error-base)}
.badge.crew{background:var(--feature-lighter);color:var(--feature-base)}
@media (prefers-color-scheme:dark){.badge.info,.badge.ok,.badge.warn-b,.badge.bad,.badge.crew{color:var(--text-strong-950)}.badge.info::before{background:var(--information-base)}.badge.ok::before{background:var(--success-base)}.badge.warn-b::before{background:var(--warning-base)}.badge.bad::before{background:var(--error-base)}.badge.crew::before{background:var(--feature-base)}}
tr.pass>td:first-child,tr.warn>td:first-child,tr.fail>td:first-child,tr.skip>td:first-child{font:500 .75rem/1.5rem var(--font-sans);white-space:nowrap}
tr.pass>td:first-child{color:var(--success-base)}tr.warn>td:first-child{color:var(--warning-base)}tr.fail>td:first-child{color:var(--error-base)}tr.skip>td:first-child{color:var(--text-soft-400)}
tr.warn{display:table-row;padding:0;margin:0;background:none;box-shadow:none;border-radius:0}tr.warn::before{content:none}`;

/** The floor: status, the kill switch, cards and meters (home only). */
const FLOOR = `
.floor-head{display:flex;align-items:flex-start;gap:1rem;justify-content:space-between;margin:0 0 1.5rem}
.floor-head .status{flex:1;margin:0;background:var(--bg-white-0);box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--stroke-soft-200);padding:1rem 1.25rem;border-radius:16px}
.status strong{font-size:1.125rem;line-height:1.5rem;letter-spacing:-.015em;font-weight:500}
.status[data-waiting-on=you],.status[data-waiting-on=credentials],.status[data-waiting-on=setup]{box-shadow:inset 0 0 0 1px var(--warning-light),inset 4px 0 0 var(--warning-base)}
.status[data-waiting-on=nothing]{box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--stroke-soft-200),inset 4px 0 0 var(--success-base)}
.status[data-waiting-on=ci],.status[data-waiting-on=forge],.status[data-waiting-on=claude],.status[data-waiting-on=stick],.status[data-waiting-on=doctor]{box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--stroke-soft-200),inset 4px 0 0 var(--information-base)}
.status ul.also{margin:.5rem 0 0;color:var(--text-sub-600)}
.kill{flex:none;margin:0;text-align:right}
@media (max-width:720px){.floor-head{flex-direction:column;align-items:stretch;gap:.75rem}.kill{text-align:left}}
.kill h2{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.kill form{margin:0}
.kill-on{background:var(--error-lighter);box-shadow:inset 0 0 0 1px var(--error-light);border-radius:12px;padding:.75rem 1rem;margin:0 0 1rem}
.kill-on::before{display:none}
.term{display:block;font:500 .6875rem/1rem var(--font-sans);letter-spacing:.06em;text-transform:uppercase;color:var(--text-soft-400);margin:0 0 .25rem}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));margin:0 0 1.5rem}
.grid.wide{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
@media (max-width:900px){.grid.wide{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--bg-white-0);border-radius:16px;box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--stroke-soft-200);padding:1rem 1.25rem;min-width:0}
.card>h2{font-size:1rem;line-height:1.5rem;letter-spacing:-.011em;margin:0 0 .75rem;display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
.card>h2 small,.section-h small{font-weight:400}
.card table{box-shadow:none;border:0;border-radius:0;margin:0 -1.25rem -1rem;width:calc(100% + 2.5rem);background:none}
.card table th:first-child,.card table td:first-child{padding-left:1.25rem}.card table th:last-child,.card table td:last-child{padding-right:1.25rem}
.card table tr:first-child>th{background:var(--bg-weak-50)}
@media (max-width:720px){.card table{display:block;overflow-x:auto}}
.card{position:relative}
.card.attention{box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--warning-light)}
.card.attention::before{content:"";position:absolute;z-index:1;left:0;top:0;bottom:0;width:4px;border-radius:16px 0 0 16px;background:var(--warning-base)}
.card.attention ul{list-style:none;padding:0;margin:.5rem 0 0}
.card.attention li{padding:.5rem 0;border-top:1px solid var(--stroke-soft-200)}
.slot{display:flex;flex-direction:column;gap:.375rem}
.slot .what{font-weight:500;color:var(--text-strong-950)}
.slot .meta{color:var(--text-sub-600);font-size:.75rem;line-height:1rem}
.muted{color:var(--text-sub-600)}
.empty{color:var(--text-sub-600);margin:0}
.meter{margin:.5rem 0 .75rem}
.meter-row{display:flex;justify-content:space-between;gap:.5rem}
.meter-row b{font-weight:500;font-variant-numeric:tabular-nums}
.bar{height:.375rem;border-radius:999px;background:var(--bg-soft-200);margin-top:.375rem;overflow:hidden}
.bar i{display:block;height:100%;border-radius:inherit;background:var(--primary-base)}
.bar i.hot{background:var(--warning-base)}.bar i.full{background:var(--error-base)}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.375rem 1rem;margin:.5rem 0 0}
dl.kv dt{color:var(--text-sub-600)}dl.kv dd{margin:0;overflow-wrap:anywhere}
.section-h{margin:2rem 0 .75rem;display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
.quick{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1rem}
.quick a{display:inline-flex;align-items:center;min-height:2rem;padding:0 .75rem;border-radius:8px;background:var(--bg-white-0);box-shadow:var(--shadow-xs),inset 0 0 0 1px var(--stroke-soft-200);color:var(--text-sub-600)}
.quick a:hover{background:var(--bg-weak-50);color:var(--text-strong-950);text-decoration:none}
td:last-child>a+a{margin-left:.75rem}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
td>code:first-child{white-space:nowrap}
.card td:first-child{white-space:nowrap}
.card table+*{margin-top:1.75rem}.card .quick{margin-bottom:0}`;

export const STYLE = TOKENS + BASE + SHELL + FLOOR;
