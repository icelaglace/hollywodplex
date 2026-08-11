/*
 * cache.js — simple in-memory ttl cache for media api responses.
 * reduces load on the media server during repeated browsing.
 */

const DEFAULT_TTLS = {
  list: 30_000,       // 30 seconds for list endpoints
  metadata: 300_000,  // 5 minutes for item metadata
  image: 86_400_000,  // 24 hours for images
};

class ResponseCache {
  #store = new Map();
  #intervals = new Map();

  /*
   * get a cached value by key. returns undefined if not found or expired.
   */
  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /*
   * set a value with a ttl in milliseconds.
   * if no ttl is given, uses the 'list' default.
   */
  set(key, value, ttl = DEFAULT_TTLS.list) {
    this.#store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  /*
   * set with a named ttl category: 'list', 'metadata', or 'image'.
   */
  setWithCategory(key, value, category) {
    const ttl = DEFAULT_TTLS[category] || DEFAULT_TTLS.list;
    this.set(key, value, ttl);
  }

  /*
   * generate a cache key from request details.
   */
  static key(method, url) {
    return `${method}:${url}`;
  }

  /*
   * remove a single entry, e.g. after a mutation makes it stale.
   */
  delete(key) {
    this.#store.delete(key);
  }

  /*
   * remove all expired entries.
   */
  purge() {
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if (now > entry.expiresAt) {
        this.#store.delete(key);
      }
    }
  }

  get size() {
    return this.#store.size;
  }
}

// singleton
const cache = new ResponseCache();

// purge expired entries every 5 minutes
setInterval(() => cache.purge(), 300_000);

export default cache;
