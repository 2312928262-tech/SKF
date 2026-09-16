'use strict';
(function (root) {
  // Every frontend reads the durable event cursor through its authenticated transport.
  // Native push is only an optimization; HTTP/thin-bridge clients must also recover events.
  function start(options) {
    const schedule = options.schedule || setTimeout;
    const cancel = options.cancel || clearTimeout;
    let timer = null, stopped = false;
    async function tick() {
      timer = null;
      if (stopped) return;
      let delay = options.isHidden && options.isHidden() ? 5000 : 1000;
      try { await options.pull(); } catch { delay = 5000; }
      // At most one pending read. A slow request never causes overlapping polls.
      if (!stopped) timer = schedule(tick, delay);
    }
    timer = schedule(tick, 0);
    return () => { stopped = true; if (timer !== null) cancel(timer); timer = null; };
  }
  root.SKF_EVENT_PUMP = { start };
})(typeof window === 'object' ? window : globalThis);
