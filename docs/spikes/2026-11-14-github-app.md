# GitHub App spike — 2026-11-14

The by-hand spike that §13 Task 1 of
[the GitHub App design](../superpowers/specs/2026-11-13-github-app-auth.md) puts before any app
work. Part A ran on a personal-account repository (P) and then an organization repository (O, a
free organization); part B ran on P. Probes used `scripts/spike/github-app.ts` and throwaway
scripts that printed only statuses and chosen fields.

## Setup

- P: a public personal repository, default branch `master`. O: a public repository in a free
  organization, default branch `main`, with its own pair of apps owned by the organization.
- An author app: Contents and Pull requests read and write.
- A reviewer app: Pull requests read and write; Contents read-only, then read and write (A6).
- Both apps are private ("only on this account") and installed on that one repository.
- Ruleset `jumpmaster`: pull request required, 1 approval, stale approvals dismissed. Code-owner review was turned on later for F14.
- Ruleset `jumpmaster-merge`: Restrict updates. Bypass: the author app (`Integration`) and Repository admin.

## Outcome

**Two-app unattended merging works on both a personal and an organization repository**, with the
same results at every step, so personal repositories are not held to PAT starter mode (§5.1). One condition: **the reviewer app needs `contents: write` at
install**, which §4.1 already provides for ("unless the spike finds an app approval counts only with
`contents: write`").

## Part A

| Step | Result | Finding |
|---|---|---|
| A5 | The reviewer app (contents read) posted APPROVED as `<slug>[bot]`, but `reviewDecision` stayed `REVIEW_REQUIRED`. The author's merge got 405 "At least 1 approving review is required by reviewers with write access." | **F12**: without contents write, an app's approval doesn't count. |
| A6 | Contents write was granted and accepted, and the existing approval began counting at once. On a fresh PR, unapproved → 405; approved → `APPROVED`/`CLEAN`, author merge 200. | **F12**: with contents write it counts. |
| A7 | REST accepted `{"actor_type":"Integration","actor_id":<author app>}` as a bypass actor on the personal repository. It was created by API; the UI picker wasn't checked. | **F23**: an app can be a bypass actor here. |
| A8 | Approved PR: author merge 200. Unapproved: author 405 (the approval rule; bypassing `jumpmaster-merge` doesn't lift `jumpmaster`). Reviewer merge of an approved PR: 405 "Cannot update this protected ref". Admin merge of an unapproved PR: 405. Admin merge of an approved PR: 200. | **F23**: a PR merge counts as an update under Restrict updates, and bypass applies per ruleset. |
| A9 | Author: `jumpmaster` `never`, `jumpmaster-merge` `always`. Reviewer: `never` for both. | **F17**: an installation token gets `current_user_can_bypass`, per ruleset. |

**Organization (O).** A5–A9 gave the same results as P, step for step:
- the read-only reviewer's approval didn't count ("reviewers with write access");
- with contents write it counted, and the author merged;
- `jumpmaster-merge` accepted the author app as a bypass actor;
- the author's unapproved merge, the reviewer's merge and the admin's unapproved merge were refused, and the admin's approved merge succeeded;
- `current_user_can_bypass` was the same per app and per ruleset.

On both P and O, the ruleset editor's **Add bypass** picker lists the account's own apps.

**F20.** Installing P's private app on the organization was refused: the install page for that target returns 404, and the app's install flow offers no account picker. This holds even though the same person administers both. An install covers one owner (§4.1's one pair per owner).

## Part B

| Item | Result | Effect on the design |
|---|---|---|
| F21 token format | `ghs_`, 390 characters | The `ghs_` redaction (Task 3) must allow long tokens. |
| `repoAccess()` | For an installation token, `GET /repos` returns every `permissions` flag `false`. `x-oauth-scopes` and the expiry header are absent. `GET /repos/{o}/{r}/installation` (JWT) gives the real grant. | As §4.3 planned: permissions come from the installation; `scopes: null`; expiry from the mint. |
| F18 | `GET /user` gets 403. `issues?creator=<slug>[bot]` works. A review's `user.login` is `<slug>[bot]` and its type is `Bot`. | As §4.3 planned. |
| Collaborator permission | With `metadata: read`: the owner reads `admin`; each app's bot reads `none`. | A bot's own collaborator permission says nothing, so don't use it to judge the bot. |
| F24 | `GET actions/permissions/workflow` without `administration` gets 403. | `forge.actions-approval` reports only that it can't read the setting (§5.2); deferrable as planned. |
| F15 | The author app approving its own PR gets 422 "Can not approve your own pull request". | Two apps are needed, as designed. |
| Workflow file push | Without the `workflows` permission, creating a file under `.github/workflows/` gets 403. | As expected. |
| F6b on a stateless token | `DELETE /installation/token` returns 204. The token still worked about 0s later and got 401 by 5s. | Revocation works; allow a few seconds. |
| F22 | Run 1: right after the suspend call (204), the live token could still read **and create a ref**, while a new mint got 403 "installation has been suspended". Run 2: the live token got 403 from the first check onward. Unsuspend restores it. | **Suspension kills live tokens**, after a propagation window of seconds. §4.2's branch applies: **the vault store of minted tokens goes**. The kill switch suspends and also refuses new work. |
| Key rotation by API | `POST /app/keys` gets 404. There's no API for creating a key. | Rotation stays manual (§8): generate, paste, delete. |
| F14 (code-owner review on) | CODEOWNERS owned only `/owned/`. App approval on an unowned path: merge 200, though GraphQL `mergeStateStatus` still said `BLOCKED`. On an owned path: 405 "Waiting on code owner review". | An app approval counts on unowned paths. Don't gate on `mergeStateStatus`; the merge result is authoritative. |
| `github-actions[bot]` approval | With "Allow GitHub Actions to create and approve pull requests" on, a workflow's approval made an unowned-path PR `APPROVED`. | §5.2's concern is real. |
| Write `GITHUB_TOKEN` merge | The same workflow's merge of that approved PR got 405 "Cannot update this protected ref". | `jumpmaster-merge` makes an Actions approval harmless, as §5.2 claims. |
| F5 | A manifest with `redirect_url: http://localhost:7431/...` was accepted, and GitHub redirected the browser there with `code` and `state`. | The manifest flow works for a local install; no paste fallback is needed. |
| F5b | A manifest with `hook_attributes` omitted was accepted. The non-public-URL variant wasn't tried. | Omit the hook. |
| F2 | First conversion: 201, with `id`, `slug`, `pem`, `client_secret`, `webhook_secret` and the other fields listed. Second conversion with the same code: 404. | The code is single-use. |

## Not run

- A write-role **user** against `jumpmaster-merge`. The write `GITHUB_TOKEN` case covers the same rule.
- F5b's variant with a non-public hook URL.
- Part B on the organization. Nothing in it depends on the owner type, as far as the documentation says.
