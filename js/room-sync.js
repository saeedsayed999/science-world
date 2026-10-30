// Keeps one live room in sync with the database.
// Realtime notifications trigger an immediate fetch; a slow poll covers
// dropped connections. Events always arrive in database order (by id), so
// every client replays the same sequence and shows the same positions.

import { api, sb } from './supabase.js';

const POLL_MS = 2500;

export class RoomSync {
  /** @param {string} roomId @param {(state: object, newEvents: object[]) => void} onUpdate */
  constructor(roomId, onUpdate) {
    this.roomId = roomId;
    this.onUpdate = onUpdate;
    this.lastEventId = 0;
    this.state = null;
    this.online = true;
    this._inflight = null;
    this._again = false;
    this._stopped = false;
    const filter = (col) => ({ schema: 'public', filter: `${col}=eq.${roomId}` });
    this.channel = sb.channel(`room-${roomId}`)
      .on('postgres_changes', { event: '*', table: 'room_events', ...filter('room_id') }, () => this.refresh())
      .on('postgres_changes', { event: '*', table: 'room_players', ...filter('room_id') }, () => this.refresh())
      .on('postgres_changes', { event: '*', table: 'rooms', ...filter('id') }, () => this.refresh())
      .subscribe();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  /** Fetches anything new. Concurrent calls coalesce into one follow-up fetch. */
  refresh() {
    if (this._stopped) return Promise.resolve(this.state);
    if (this._inflight) { this._again = true; return this._inflight; }
    this._inflight = (async () => {
      try {
        do {
          this._again = false;
          const st = await api.roomState(this.roomId, this.lastEventId);
          if (this._stopped) break;
          this.online = true;
          const fresh = st.events.filter((e) => e.id > this.lastEventId);
          if (fresh.length) this.lastEventId = fresh[fresh.length - 1].id;
          this.state = st;
          this.onUpdate(st, fresh);
        } while (this._again && !this._stopped);
      } catch {
        this.online = false;
      } finally {
        this._inflight = null;
      }
      return this.state;
    })();
    return this._inflight;
  }

  stop() {
    this._stopped = true;
    clearInterval(this.timer);
    sb.removeChannel(this.channel);
  }
}
