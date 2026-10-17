import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalLogger, anonymizeUrlForLog } from '../src/logger.ts';

test('anonymizeUrlForLog redacts sensitive parameters', () => {
  const url = 'https://example.com/checkout?token=secret123456&email=john@example.org&q=private+query&item=10';
  const anonymized = anonymizeUrlForLog(url);

  assert.ok(!anonymized.includes('secret123456'));
  assert.ok(!anonymized.includes('john@example.org'));
  assert.ok(!anonymized.includes('private+query'));
  assert.ok(anonymized.includes('token=%5BREDACTED%5D') || anonymized.includes('token=%5B'));
  assert.ok(anonymized.includes('item=10'));
});

test('TerminalLogger respects severity levels and prepends [AnoFox][LEVEL]', () => {
  const logger = new TerminalLogger({ terminalLogging: true, severity: 'WARN' });
  const outputs: string[] = [];

  const originalDebug = console.debug;
  const originalInfo = console.info;
  const originalWarn = console.warn;

  console.debug = (msg: string) => outputs.push(msg);
  console.info = (msg: string) => outputs.push(msg);
  console.warn = (msg: string) => outputs.push(msg);

  try {
    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');

    assert.equal(outputs.length, 1);
    assert.ok(outputs[0].startsWith('[AnoFox][WARN]'));
    assert.ok(outputs[0].includes('warn message'));
  } finally {
    console.debug = originalDebug;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test('TerminalLogger completely silences when terminalLogging is false', () => {
  const logger = new TerminalLogger({ terminalLogging: false, severity: 'DEBUG' });
  const outputs: string[] = [];

  const originalInfo = console.info;
  console.info = (msg: string) => outputs.push(msg);

  try {
    logger.info('should not appear');
    assert.equal(outputs.length, 0);
  } finally {
    console.info = originalInfo;
  }
});

test('TerminalLogger internal logging works independently without console output', () => {
  const logger = new TerminalLogger({ terminalLogging: false, severity: 'INFO', internalLogging: true });
  const consoleOutputs: string[] = [];

  const originalInfo = console.info;
  console.info = (msg: string) => consoleOutputs.push(msg);

  try {
    logger.logInternal('INFO', 'URL_CLEANER', 'Cleaned param on example.com', 'Removed fbclid');

    // Nothing was printed to console
    assert.equal(consoleOutputs.length, 0);

    // But internal log buffer contains the entry
    const logs = logger.getInternalLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'INFO');
    assert.equal(logs[0].category, 'URL_CLEANER');
    assert.equal(logs[0].message, 'Cleaned param on example.com');
    assert.equal(logs[0].details, 'Removed fbclid');
    assert.ok(logs[0].timeFormatted.length > 0);
  } finally {
    console.info = originalInfo;
  }
});

test('TerminalLogger internal logging is purged when disabled', () => {
  const logger = new TerminalLogger({ terminalLogging: false, severity: 'INFO', internalLogging: true });
  logger.logInternal('INFO', 'URL_CLEANER', 'Item 1');
  assert.equal(logger.getInternalLogs().length, 1);

  logger.setInternalLogging(false);
  assert.equal(logger.getInternalLogs().length, 0);

  // New logs are ignored when internal logging is false
  logger.logInternal('INFO', 'URL_CLEANER', 'Item 2');
  assert.equal(logger.getInternalLogs().length, 0);
});
