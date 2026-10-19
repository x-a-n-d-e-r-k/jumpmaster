import type { DropPayload, DropResult, TrooperEvent } from '@jumpmaster/protocol';

export type Ack = 'ok' | 'stale';

/** The per-drop calls the runner needs. */
export interface DropClient {
  heartbeat(dropId: string, epoch: number): Promise<'ok' | 'cancel' | 'stale'>;
  postEvents(dropId: string, epoch: number, events: TrooperEvent[]): Promise<Ack>;
  postResult(dropId: string, epoch: number, result: DropResult): Promise<Ack>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StickClient implements DropClient {
  constructor(
    private readonly baseUrl: string,
    private token?: string,
  ) {}

  private async req(path: string, body: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-jumpmaster-protocol': '1',
    };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    return fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async enroll(
    joinToken: string,
    name: string,
    slots: number,
  ): Promise<{ stickId: string; stickToken: string }> {
    const res = await this.req('/api/sticks/enroll', { joinToken, name, slots }, false);
    if (!res.ok) throw new Error(`enroll failed: ${res.status}`);
    const out = (await res.json()) as { stickId: string; stickToken: string };
    this.token = out.stickToken;
    return out;
  }

  /** Long-polls; resolves null when the server has nothing (204). */
  async lease(freeSlots: number): Promise<DropPayload | null> {
    const res = await this.req('/api/sticks/lease', { freeSlots });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`lease failed: ${res.status}`);
    return (await res.json()) as DropPayload;
  }

  async heartbeat(dropId: string, epoch: number): Promise<'ok' | 'cancel' | 'stale'> {
    const res = await this.req(`/api/drops/${dropId}/heartbeat`, { epoch });
    if (res.status === 409) return 'stale';
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`);
    const out = (await res.json()) as { cancel: boolean };
    return out.cancel ? 'cancel' : 'ok';
  }

  async postEvents(dropId: string, epoch: number, events: TrooperEvent[]): Promise<Ack> {
    const res = await this.req(`/api/drops/${dropId}/events`, { epoch, events });
    if (res.status === 409) return 'stale';
    if (!res.ok) throw new Error(`events failed: ${res.status}`);
    return 'ok';
  }

  /** Retries 5xx (e.g. forge failure while finalizing) with backoff. */
  async postResult(dropId: string, epoch: number, result: DropResult): Promise<Ack> {
    let last = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      const res = await this.req(`/api/drops/${dropId}/result`, { epoch, result });
      if (res.status === 409) return 'stale';
      if (res.ok) return 'ok';
      last = res.status;
      if (res.status < 500) break;
    }
    throw new Error(`result failed: ${last}`);
  }
}
