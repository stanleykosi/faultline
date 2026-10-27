process.env.PROCESS_ROLE='worker';
await import('../dist/server/apps/worker/src/main.js');
