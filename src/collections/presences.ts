import { ShardClient } from '../client';
import { GatewayRawEvents } from '../gateway/rawevents';
import { Presence } from '../structures';

import {
  BaseClientCollection,
  BaseClientCollectionOptions,
  BaseCollection,
} from './basecollection';


export const DEFAULT_PRESENCE_CACHE_KEY = '@me';

export interface PresencesCache extends BaseCollection<string, Presence> {
  
}

/**
 * @category Collection Options
 */
export interface PresencesOptions extends BaseClientCollectionOptions {
  storeOffline?: boolean,
};

/**
 * Presences Collection
 * @category Collections
 */
export class Presences extends BaseClientCollection<string, PresencesCache, Presence> {
  storeOffline: boolean;

  constructor(client: ShardClient, options: PresencesOptions = {}) {
    super(client, options);
    this.storeOffline = !!options.storeOffline;
    Object.defineProperties(this, {
      client: {enumerable: false, writable: false},
      storeOffline: {configurable: true, writable: false},
    });
  }

  setStoreOffline(value: boolean): void {
    Object.defineProperty(this, 'storeOffline', {value});
  }

  get size(): number {
    return this.reduce((size: number, cache: PresencesCache) => size + cache.size, 0);
  }

  add(value: GatewayRawEvents.RawPresence): Presence {
    const cacheId = value['guild_id'] || DEFAULT_PRESENCE_CACHE_KEY;
    this.insertCache(cacheId);

    let presence: Presence;
    if (this.has(cacheId, value.user.id)) {
      presence = <Presence> this.get(cacheId, value.user.id);
      presence.merge(value);

      if (presence.isOffline) {
        if (presence.fromGuild && !this.client.members.storeOffline) {
          this.client.members.delete(presence.guildId, presence.user.id);
        }
        if (!this.storeOffline) {
          this.delete(cacheId, presence.user.id);
        }
      }
    } else {
      presence = new Presence(this.client, value);
      const newPresence = this.insert(presence);
      if (newPresence !== null) {
        presence = newPresence;
      }
    }
    return presence;
  }

  insert(presence: Presence): null | Presence {
    const cacheId = presence.cacheId;
    this.insertCache(cacheId);

    if (!this.enabled) {
      return null;
    }

    if (presence.isOffline) {
      if (presence.fromGuild && !this.client.members.storeOffline) {
        this.client.members.delete(presence.guildId, presence.user.id);
      }
      if (!this.storeOffline) {
        this.delete(cacheId, presence.user.id);
        return presence;
      }
    }

    const cache = <PresencesCache> super.get(cacheId);
    if (cache.has(presence.user.id)) {
      const old = <Presence> cache.get(presence.user.id);
      old.merge(presence);
      presence = old;
    } else {
      cache.set(presence.user.id, presence);
    }
    return presence;
  }

  insertCache(cacheId: string): void {
    if (!super.has(cacheId)) {
      super.set(cacheId, new BaseCollection());
    }
  }

  delete(cacheId: string): boolean;
  delete(cacheId: string, userId: string): boolean;
  delete(cacheId: null | undefined, userId: string): boolean;
  delete(cacheId?: null | string, userId?: null | string): boolean {
    if (this.enabled) {
      if (cacheId != null) {
        if (super.has(cacheId)) {
          if (userId != null) {
            const cache = <PresencesCache> super.get(cacheId);
            return cache.delete(userId);
          } else {
            return super.delete(cacheId);
          }
        }
      } else if (userId != null) {
        let deleted: boolean = false;
        for (let [cacheId, cache] of this) {
          if (cache.has(userId)) {
            cache.delete(userId);
            deleted = true;
          }
        }
        return deleted;
      }
    }
    return false;
  }

  get(cacheId: string): PresencesCache | undefined;
  get(cacheId: string, userId: string): Presence | undefined;
  get(cacheId: null | undefined, userId: string): Presence;
  get(cacheId?: null | string, userId?: null | string): PresencesCache | Presence | undefined {
    if (this.enabled) {
      if (cacheId != null) {
        if (super.has(cacheId)) {
          const cache = <PresencesCache> super.get(cacheId);
          if (userId != null) {
            return cache.get(userId);
          } else {
            return cache;
          }
        }
      } else if (userId != null) {
        // grab first presence we find for this userId
        for (let [cacheId, cache] of this) {
          if (cache.has(userId)) {
            return cache.get(userId);
          }
        }
      }
    }
    return undefined;
  }

  has(cacheId: string): boolean;
  has(cacheId: string, userId: string): boolean;
  has(cacheId: null | undefined, userId: string): boolean;
  has(cacheId?: null | string, userId?: null | string): boolean {
    if (this.enabled) {
      if (cacheId != null) {
        if (super.has(cacheId)) {
          if (userId != null) {
            const cache = <PresencesCache> super.get(cacheId);
            return cache.has(userId);
          }
          return true;
        }
      } else if (userId != null) {
        for (let [cacheId, cache] of this) {
          if (cache.has(userId)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  toString(): string {
    return `${this.size} Presences`;
  }
}
