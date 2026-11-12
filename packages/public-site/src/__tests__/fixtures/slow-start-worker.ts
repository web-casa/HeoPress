/**
 * A render worker that takes 2 s to load (theme-pool.test.ts): start-up must not count as render time.
 *
 * The delay is twice the render timeout that test uses, and both are an order of magnitude above what the work
 * takes, so a starved CI runner cannot blur the distinction the test is making (a 800 ms load against a 300 ms
 * timeout left the *render* only 300 ms, and that is what failed on a loaded runner).
 */
await new Promise((resolve) => setTimeout(resolve, 2000));
await import('../../theme/render-worker.ts');
export {};
