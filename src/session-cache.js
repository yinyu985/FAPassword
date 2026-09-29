// Exact identity keys, wall-clock expiry, and generation checks for asynchronous loaders.
export class SessionCache {
  constructor(ttl, usable = () => true, limit = 100) {
    this.ttl = ttl;
    this.usable = usable;
    this.limit = limit;
    this.entries = new Map();
    this.pending = new Map();
    this.generation = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!this.usable() || !entry || Date.now() >= entry.expiresAt) {
      this.remove(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, generation = this.generation) {
    if (!this.usable() || generation !== this.generation) throw new Error("session changed");
    this.remove(key);
    const entry = { value, expiresAt: Date.now() + this.ttl };
    entry.timer = setTimeout(() => {
      if (this.entries.get(key) === entry) this.remove(key);
    }, this.ttl);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.remove(this.entries.keys().next().value);
    return value;
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (entry) clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  clear() {
    this.generation++;
    for (const key of this.entries.keys()) this.remove(key);
    this.pending.clear();
  }

  async query(key, loader) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.pending.has(key)) return this.pending.get(key);
    const generation = this.generation;
    const result = Promise.resolve().then(loader).then((value) => this.set(key, value, generation));
    this.pending.set(key, result);
    try {
      return await result;
    } finally {
      if (this.pending.get(key) === result) this.pending.delete(key);
    }
  }
}

export const credentialKey = (origin, username) => JSON.stringify([origin, username ?? ""]);
