/** A render worker that takes 800 ms to load (theme-pool.test.ts): start-up must not count as render time. */
await new Promise((resolve) => setTimeout(resolve, 800));
await import('../../theme/render-worker.ts');
export {};
