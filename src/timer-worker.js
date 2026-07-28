//
// The workout clock. It lives in a worker so a busy main thread (rendering the
// graph, writing records) can't skew the seconds.
//
// It is its own module only because `import.meta.url` can't be parsed by the
// CJS transform the tests use — pulled out here, watch.js becomes importable
// under jest, which mocks this module and drives the ticks by hand.
//
const timer = new Worker(new URL('./timer.js', import.meta.url));

export { timer };
