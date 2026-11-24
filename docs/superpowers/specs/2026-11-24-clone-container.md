# Clone container for GitLab drops

Status: decided by Command's ruling on briefing 374; waits on the goal change below. Red-teamed against main at 47b7601 (18 findings, all answered here).

## What it gives

- A GitLab drop can clone a private project, and **no GitLab token ever enters a container an agent runs in**.
- A separate container with no agent in it does the clone, then exits before the agent starts.
- The agent works from a read-only local copy of the repository and makes no call to GitLab.

## Decided

- **Token** (Ruling on briefing 374): the clone container uses the zone's read-only token when one is set, else the author token. The read-only token is a project deploy token with only `read_repository`, stored in the vault as `gitlab-pat/<zone>/read`, and used only in the clone container. With it set, the token that can push is handed out only for pushes. A GitLab token can't be revoked when the clone ends.
- **Goal:** the goal file says the GitLab token reaches only the push container. It needs a goal change, confirmed by Command, to "only the clone and push containers, in which no agent runs". No code from this design merges before that. That no write token is in an agent's container is unchanged.
- **The security policy** (SECURITY.md) is Command's to change: its "only mount" and "where the write token goes" sections. An agent drafts the text in an issue or PR comment and does not edit the file.

## How a drop runs

1. **Lease.** A GitLab zone's drops go only to a stick that advertises `clone-v1`. The payload carries no token, as today, and says `repo.mirror: "provided"`.
2. **Images first.** The stick verifies and pulls every image, as today. Nothing of the zone's is running yet: no services, no drop network.
3. **Plan.** The stick asks for `clone-plan`. It holds no secret: the remote, the branches (all heads), limits and egress. Under egress the clone container gets its own proxy that allows one host, by the rule the push plan uses; a zone without egress gets none. The stick's ceiling applies.
4. **Clone container.** On its own network (`jm-clone-…`), the stick starts its **own** trooper image, never the zone's, in a new role `clone`, with the push container's hardening less `SETUID`, `SETGID` and `KILL`. It prints a ready line.
5. **Token.** Only then does the stick ask for `clone-token` and write the grant to the container's stdin.
6. **Fetch.** Root fetches into a bare repository with the fixed config and no hooks, as `mirrorFetch` does now: no checkout, no submodules, redirects to another host refused, and a size limit. Before it exits it searches the volume for the token in plain and basic-auth form; a hit fails the drop.
7. **Hand-over.** The stick confirms that the container is gone and removes its network. Only then does it create the drop network, the services and the agent's container. The mirror is mounted **read-only** at `/jm/mirror`.
8. **End.** The mirror volume goes with the drop.

The clone uses the drop's own slot, and one `/28` at a time. The heartbeat already runs from acceptance, so a long clone keeps its lease.

## What changes in the agent's container

- **Five calls to the remote go away:** the fetches in implement (resume), heal and resolve, the "branch already exists" check, and the first clone. All of them read the mirror instead. Implement's refusal to run without a token applies only when no mirror is provided.
- **The mirror path becomes fixed.** Today it is in a random directory. The git config the agent reads moves out of the mirror's parent, because that mount can't be written.
- **`initBare` is skipped** for a provided mirror. Its ownership and fixed config are checked instead.
- **Doctor:** with no mirror, the drop still runs and reports the clone as failed, with the reason.
- **Chat:** out of scope. It stays unavailable for GitLab projects.

## Volumes

- The mirror volume has its own label, `jumpmaster.mirror=1`, and never the repo volume's. So it is never taken for a push volume, and `prepareVolume` and salvage look only at repo volumes.
- The sweep removes mirror volumes whose drop isn't live on this stick. A live one is never swept.
- The driver gains a second, read-only mount.
- `clone-v1` is advertised when the stick's volume self-check and its base image pass, and the same 10 GiB free-space floor applies.

## Server rules for the token

`clone-token` is answered only when all of these hold, checked afresh in one transaction:

- this stick holds this drop at this epoch, and it is leased or running;
- the zone is GitLab, the kill switch is off, the zone isn't observing, and its repository is unchanged;
- no live grant exists for it. `clone-plan` revokes an earlier one, so a lost reply can be retried;
- the drop has no result, and no event from the agent.

The last rule guards against bugs, not a bad stick, because the stick itself relays events. The clone container's output is never posted as drop events. "Revoked" here is bookkeeping: a GitLab personal token stays valid. The audit row holds ids only.

## Failures

| What happens | Result |
|---|---|
| GitLab refuses the token | The drop fails with that reason, and the zone's credential check reports it. A doctor drop reports it instead |
| Host outside the zone's egress or the stick's ceiling | Nothing starts; the host is named |
| Over 15 minutes, or over the size limit | Container killed, volume removed, drop failed |
| Kill switch mid-clone | Container killed at once, volume removed |
| The stick dies mid-clone | The drop is lost and a new drop is made, as today; the old volume is swept |

## What this does not protect against

- **A compromised stick.** It can ask for the token of any drop it holds. That is already so for pushes; with the read-only token set, it has only read access outside pushes.
- **The GitLab host from the agent.** The zone's egress list covers both the agent and the clone, so the agent can reach the host without a token. Splitting the two lists would be a later step.
- **Private addresses.** The proxy still refuses a GitLab on an internal network. That is a separate decision.

## Alternatives

- **A read-only token in the agent's container:** simplest; Command declined it.
- **The stick clones on its host:** a process with the Docker socket would parse untrusted repository data.
- **The server clones and sends a bundle:** every repository passes through the server.
- **Reuse the drop's own volume:** the agent owns that one, so it fails the mirror's ownership check.

## Work, in order

0. The goal change.
1. Protocol: `repo.mirror`, and the clone plan, grant, payload and result.
2. Server: `clone-plan` and `clone-token`; the read token's vault entry.
3. Trooper: the `clone` role, with its image label.
4. Trooper: a provided mirror in every agent role, with a second image label.
5. Stick: the clone container, mirror volume, sweep and `clone-v1`.
6. Server: require `clone-v1` for GitLab zones; payload field; doctor and status words.
7. End-to-end test and runbook; a draft of the security policy's text for Command.

2, 3 and 4 follow 1 and don't depend on each other. GitHub drops are unchanged throughout; moving them over later would end starter mode's caveat that the author token sits in the agent's container.

## How it is proved

- A planted token is searched for in the agent container's payload, environment, files, processes and every volume it mounts, in plain and basic-auth form. It is found in the clone container only.
- A hostile git server: a redirect to another host, an oversized pack, malformed refs. The token never leaves for another host, and the drop fails cleanly.
- Every grant rule has a negative test: wrong stick, old epoch, agent started, second request, killed zone, GitHub zone.
- A live mirror survives the sweep; a pushing drop with a mirror still pushes its own volume.
- GitHub payloads and steps are pinned unchanged.
