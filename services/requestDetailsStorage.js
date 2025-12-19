import Config from '../config/index.js';

class RequestDetailsStorage {
  constructor(maxSize = Config.MAX_REQUEST_DETAILS) {
    this.details = new Map();
    this.order = [];
    this.maxSize = maxSize;
  }

  add(details) {
    if (this.details.has(details.request_id)) {
      return;
    }

    if (this.order.length >= this.maxSize) {
      const oldestId = this.order.shift();
      this.details.delete(oldestId);
    }

    this.details.set(details.request_id, details);
    this.order.push(details.request_id);
  }

  get(requestId) {
    return this.details.get(requestId);
  }

  getRecent(limit = 100) {
    const recentIds = this.order.slice(-limit);
    return recentIds
      .reverse()
      .map(id => this.details.get(id))
      .filter(Boolean);
  }
}

const requestDetailsStorage = new RequestDetailsStorage();
export default requestDetailsStorage;