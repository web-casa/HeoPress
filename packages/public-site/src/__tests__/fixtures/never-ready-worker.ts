/** A render worker stuck while loading (theme-pool.test.ts): it never says it is ready, and stays alive. */
setInterval(() => undefined, 1000);
export {};
