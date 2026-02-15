// Test environment setup
// Set required env vars before any module imports resolve config
process.env.PINGCODE_TOKEN = 'test-token-for-unit-tests';
process.env.TIMEZONE = 'Asia/Shanghai';
process.env.LOG_LEVEL = 'error';
