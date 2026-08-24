#!/usr/bin/env node
/**
 * Test harness for background.js.
 *
 * background.js is a service worker script, so it is evaluated inside a VM
 * context with a stubbed `chrome` API and a frozen clock. Top level function
 * declarations land on that context's global object, which is how the parser
 * is reached from here.
 *
 * Run with: npm test
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Tuesday 10 March 2026, 15:00 local time
const NOW = new Date(2026, 2, 10, 15, 0, 0, 0);

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// --------------------------------------------------------------- chrome stub
function createStorageArea(store) {
  return {
    get: async (keys) => {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of wanted) {
        if (key in store) {
          result[key] = JSON.parse(JSON.stringify(store[key]));
        }
      }
      return result;
    },
    set: async (items) => {
      Object.assign(store, JSON.parse(JSON.stringify(items)));
    }
  };
}

const localStore = {};
const sessionStore = {};
const listeners = {};
const notifications = [];
const badge = { text: '' };

function listenerSlot(name) {
  return {
    addListener: (fn) => {
      listeners[name] = fn;
    }
  };
}

const chromeStub = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    onInstalled: listenerSlot('onInstalled'),
    onStartup: listenerSlot('onStartup'),
    onMessage: listenerSlot('onMessage')
  },
  storage: {
    local: createStorageArea(localStore),
    session: createStorageArea(sessionStore)
  },
  contextMenus: {
    onClicked: listenerSlot('onClicked'),
    removeAll: async () => undefined,
    create: (_props, callback) => {
      if (callback) {
        callback();
      }
    }
  },
  action: {
    setBadgeText: async ({ text }) => {
      badge.text = text;
    },
    setBadgeBackgroundColor: async () => undefined
  },
  notifications: {
    clear: async () => undefined,
    create: async (id, options) => {
      notifications.push({ id, options });
    }
  },
  tabs: {
    create: async () => undefined
  }
};

// ---------------------------------------------------------------- frozen clock
const RealDate = Date;

class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(NOW.getTime());
    } else {
      super(...args);
    }
  }

  static now() {
    return NOW.getTime();
  }
}

const context = vm.createContext({
  chrome: chromeStub,
  console,
  Date: FrozenDate,
  URLSearchParams,
  Math,
  JSON,
  Number,
  Object,
  Array,
  Set,
  Promise,
  RegExp,
  String,
  isNaN,
  parseInt,
  parseFloat,
  setTimeout,
  globalThis: undefined
});
context.globalThis = context;

vm.runInContext(source, context, { filename: 'background.js' });

// Top level `const` declarations live in the realm's lexical scope rather than
// on its global object, so re-export the ones the tests need.
const EXPORT_SHIM = 'globalThis.__test = { EventStorage, CONFIG, MERIDIEM };';
vm.runInContext(EXPORT_SHIM, context, { filename: 'export-shim.js' });

// ----------------------------------------------------------------- test runner
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

const parse = (text) => context.parseEventFromText(text);
const EventStorage = context.__test.EventStorage;
// Values built inside the VM have that realm's prototypes, so compare plain
// serialisations rather than using deepStrictEqual across the realm boundary.
const plain = (value) => JSON.parse(JSON.stringify(value));
const hhmm = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const durationMinutes = (result) => (result.endDate - result.startDate) / 60000;

// ------------------------------------------------------------ time of day
test('single time: "Team standup tomorrow at 9am"', () => {
  const result = parse('Team standup tomorrow at 9am');
  assert.strictEqual(ymd(result.startDate), '2026-03-11');
  assert.strictEqual(hhmm(result.startDate), '09:00');
  assert.strictEqual(durationMinutes(result), 60);
  assert.strictEqual(result.title, 'Team standup');
});

test('time range: "Dinner 6-8pm on Friday"', () => {
  const result = parse('Dinner 6-8pm on Friday');
  assert.strictEqual(ymd(result.startDate), '2026-03-13');
  assert.strictEqual(hhmm(result.startDate), '18:00');
  assert.strictEqual(hhmm(result.endDate), '20:00');
  assert.strictEqual(result.title, 'Dinner');
});

test('noon start is noon, not midnight: "Lunch 12-2pm"', () => {
  const result = parse('Lunch 12-2pm');
  assert.strictEqual(hhmm(result.startDate), '12:00');
  assert.strictEqual(durationMinutes(result), 120);
});

test('range ending at noon stays in the morning: "Class 11-12pm"', () => {
  const result = parse('Class 11-12pm');
  assert.strictEqual(hhmm(result.startDate), '11:00');
  assert.strictEqual(durationMinutes(result), 60);
});

test('range crossing noon: "Call 10-2pm"', () => {
  const result = parse('Call 10-2pm');
  assert.strictEqual(hhmm(result.startDate), '10:00');
  assert.strictEqual(durationMinutes(result), 240);
});

test('range crossing midnight: "Shift 11-12am"', () => {
  const result = parse('Shift 11-12am');
  assert.strictEqual(hhmm(result.startDate), '23:00');
  assert.strictEqual(durationMinutes(result), 60);
});

test('single letter meridiem: "Lab 8:00A - 11:00A"', () => {
  const result = parse('Lab 8:00A - 11:00A');
  assert.strictEqual(hhmm(result.startDate), '08:00');
  assert.strictEqual(durationMinutes(result), 180);
});

test('"p." for page is not a meridiem: "Read pages 3-5 p. 20"', () => {
  const result = parse('Read pages 3-5 p. 20');
  assert.strictEqual(result.confidence < 0.4, true, `confidence was ${result.confidence}`);
  assert.notStrictEqual(hhmm(result.startDate), '15:00');
});

test('a stray word is not a meridiem: "Pick 5 apples"', () => {
  const result = parse('Pick 5 apples');
  assert.strictEqual(result.title, 'Pick 5 apples');
});

// ----------------------------------------------------------------- dates
test('ISO date: "Standup 2026-03-15 at 9:30"', () => {
  const result = parse('Standup 2026-03-15 at 9:30');
  assert.strictEqual(ymd(result.startDate), '2026-03-15');
  assert.strictEqual(hhmm(result.startDate), '09:30');
});

test('MM/DD later this year: "Party 12/25"', () => {
  const result = parse('Party 12/25');
  assert.strictEqual(ymd(result.startDate), '2026-12-25');
});

test('MM/DD already past rolls to next year: "Review 1/5"', () => {
  const result = parse('Review 1/5');
  assert.strictEqual(ymd(result.startDate), '2027-01-05');
});

test('impossible date is rejected, not rolled over: "Meeting February 30"', () => {
  const result = parse('Meeting February 30');
  assert.notStrictEqual(ymd(result.startDate), '2026-03-02');
});

test('impossible date is rejected: "Meeting 2026-02-30"', () => {
  const result = parse('Meeting 2026-02-30');
  assert.notStrictEqual(ymd(result.startDate), '2026-03-02');
});

test('leap day is accepted: "Deadline 2028-02-29 at 5pm"', () => {
  const result = parse('Deadline 2028-02-29 at 5pm');
  assert.strictEqual(ymd(result.startDate), '2028-02-29');
});

test('explicit date beats day name: "Exam Friday March 20 at 2pm"', () => {
  const result = parse('Exam Friday March 20 at 2pm');
  assert.strictEqual(ymd(result.startDate), '2026-03-20');
  assert.strictEqual(hhmm(result.startDate), '14:00');
});

test('title cleanup: "DUE Friday 11:59 PM Homework 3"', () => {
  const result = parse('DUE Friday 11:59 PM Homework 3');
  assert.strictEqual(result.title, 'Homework 3');
  assert.strictEqual(hhmm(result.startDate), '23:59');
});

// ------------------------------------------------------------- recurrence
test('MWF schedule: "CS 61A Lecture MWF 10-11am"', () => {
  const result = parse('CS 61A Lecture MWF 10-11am');
  assert.deepStrictEqual(plain(result.recurrence.days), ['MO', 'WE', 'FR']);
  // Next MWF day after Tuesday is Wednesday
  assert.strictEqual(ymd(result.startDate), '2026-03-11');
  assert.strictEqual(hhmm(result.startDate), '10:00');
  assert.strictEqual(result.title, 'CS 61A');
});

test('TuTh is Tuesday and Thursday only', () => {
  const result = context.parseWeekdays('Seminar TuTh 3-4pm');
  assert.deepStrictEqual(plain(result.days), ['TU', 'TH']);
});

test('TTh is Tuesday and Thursday', () => {
  assert.deepStrictEqual(plain(context.parseWeekdays('Discussion TTh').days), ['TU', 'TH']);
});

test('MTWThF is the full week', () => {
  assert.deepStrictEqual(plain(context.parseWeekdays('Camp MTWThF').days), ['MO', 'TU', 'WE', 'TH', 'FR']);
});

test('"US" is not a schedule code', () => {
  const result = parse('US Open tickets Friday');
  assert.strictEqual(result.recurrence.isRecurring, false);
  assert.strictEqual(result.title.includes('US Open'), true, `title was "${result.title}"`);
});

test('"SF" is not a schedule code', () => {
  assert.strictEqual(context.parseWeekdays('SF trip').found, false);
});

test('spelled out days: "Yoga Mon/Wed/Fri at 7am"', () => {
  const result = parse('Yoga Mon/Wed/Fri at 7am');
  assert.deepStrictEqual(plain(result.recurrence.days), ['MO', 'WE', 'FR']);
});

test('recurring start is never in the past', () => {
  // Tuesday 15:00 now; a Tue/Thu class at 09:00 must land on Thursday
  const result = parse('Lab TuTh 9-10am');
  assert.strictEqual(ymd(result.startDate), '2026-03-12');
  assert.strictEqual(hhmm(result.startDate), '09:00');
});

test('recurring start survives a month boundary', () => {
  const start = new Date(2026, 0, 31, 8, 0, 0, 0); // Sat 31 Jan
  const next = context.nextRecurrenceStart(start, ['MO', 'WE', 'FR'], start);
  assert.strictEqual(ymd(next), '2026-02-02');
});

// --------------------------------------------------------------- durations
test('"for 30 minutes" sets the duration', () => {
  const result = parse('Sync tomorrow at 2pm for 30 minutes');
  assert.strictEqual(durationMinutes(result), 30);
});

test('"until" sets the duration', () => {
  const result = parse('Focus block tomorrow at 9am until 11am');
  assert.strictEqual(durationMinutes(result), 120);
});

// -------------------------------------------------------------------- URL
test('calendar URL is UTC and round trips the start time', () => {
  const result = parse('Standup tomorrow at 9am');
  const url = new URL(context.createGoogleCalendarUrl(result));
  const dates = url.searchParams.get('dates');
  const [start] = dates.split('/');
  assert.match(start, /^\d{8}T\d{6}Z$/);
  const expected = result.startDate.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.strictEqual(start, expected);
  assert.strictEqual(url.searchParams.get('text'), 'Standup');
});

test('recurring events carry an RRULE', () => {
  const result = parse('CS 61A Lecture MWF 10-11am');
  const url = new URL(context.createGoogleCalendarUrl(result));
  assert.strictEqual(url.searchParams.get('recur'), 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
});

test('a huge selection produces a bounded URL', () => {
  const result = parse(`Kickoff tomorrow at 10am. ${'lorem ipsum '.repeat(500)}`);
  const url = context.createGoogleCalendarUrl(result);
  assert.strictEqual(url.length < 2000, true, `URL was ${url.length} chars`);
  assert.strictEqual(new URL(url).searchParams.get('text').length <= 250, true);
});

// ---------------------------------------------------------------- storage
async function storageTests() {
  await asyncTest('concurrent saves do not clobber each other', async () => {
    const make = (title) => ({
      title,
      startDate: new RealDate(NOW.getTime()),
      endDate: new RealDate(NOW.getTime() + 3600000),
      confidence: 1
    });

    await Promise.all([
      EventStorage.saveEvent(make('A'), 'https://example.com/a', 'A'),
      EventStorage.saveEvent(make('B'), 'https://example.com/b', 'B'),
      EventStorage.saveEvent(make('C'), 'https://example.com/c', 'C')
    ]);

    const events = await EventStorage.getRecentEvents(10);
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(plain(events.map((e) => e.title)).sort(), ['A', 'B', 'C']);
  });

  await asyncTest('history is capped at MAX_EVENTS', async () => {
    localStore.recentEvents = [];
    for (let i = 0; i < 25; i += 1) {
      await EventStorage.saveEvent({
        title: `Event ${i}`,
        startDate: new RealDate(NOW.getTime()),
        endDate: new RealDate(NOW.getTime() + 3600000),
        confidence: 1
      }, 'https://example.com', 'text');
    }
    const stored = localStore.recentEvents;
    assert.strictEqual(stored.length, 20);
    assert.strictEqual(stored[0].title, 'Event 24');
  });

  await asyncTest('stored selections are truncated', async () => {
    localStore.recentEvents = [];
    await EventStorage.saveEvent({
      title: 'Long',
      startDate: new RealDate(NOW.getTime()),
      endDate: new RealDate(NOW.getTime() + 3600000),
      confidence: 1
    }, 'https://example.com', 'x'.repeat(5000));
    assert.strictEqual(localStore.recentEvents[0].originalText.length, 500);
  });

  await asyncTest('corrupt history entries are dropped, not returned', async () => {
    localStore.recentEvents = [null, 'garbage', { id: 'evt_ok', title: 'Fine' }];
    const events = await EventStorage.getRecentEvents(10);
    assert.deepStrictEqual(plain(events.map((e) => e.id)), ['evt_ok']);
  });

  await asyncTest('badge count survives a service worker restart', async () => {
    sessionStore.sessionEventCount = 4;
    // Re-evaluating the worker script must restore the count from session storage
    const restarted = vm.createContext({
      chrome: chromeStub, console, Date: FrozenDate, URLSearchParams, Math, JSON,
      Number, Object, Array, Set, Promise, RegExp, String, isNaN, parseInt,
      parseFloat, setTimeout, globalThis: undefined
    });
    restarted.globalThis = restarted;
    vm.runInContext(source, restarted, { filename: 'background.js' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(badge.text, '4');
  });

  await asyncTest('deleting an event decrements the badge', async () => {
    localStore.recentEvents = [];
    sessionStore.sessionEventCount = 0;
    const saved = await EventStorage.saveEvent({
      title: 'Delete me',
      startDate: new RealDate(NOW.getTime()),
      endDate: new RealDate(NOW.getTime() + 3600000),
      confidence: 1
    }, 'https://example.com', 'text');
    await context.incrementSessionCount();
    assert.strictEqual(badge.text, '1');
    assert.strictEqual(await EventStorage.deleteEvent(saved.id), true);
    assert.strictEqual(badge.text, '');
    assert.strictEqual(await EventStorage.deleteEvent('missing'), false);
  });

  await asyncTest('one notification id is reused', async () => {
    notifications.length = 0;
    await context.showNotification('One', 'first');
    await context.showNotification('Two', 'second');
    assert.strictEqual(notifications.length, 2);
    assert.strictEqual(new Set(notifications.map((n) => n.id)).size, 1);
  });

  await asyncTest('messages from other extensions are rejected', async () => {
    const response = await new Promise((resolve) => {
      listeners.onMessage({ action: 'clearHistory' }, { id: 'somebody-else' }, resolve);
    });
    assert.strictEqual(response.success, false);
  });

  await asyncTest('unknown actions are reported, not thrown', async () => {
    const response = await new Promise((resolve) => {
      listeners.onMessage({ action: 'nope' }, { id: 'test-extension-id' }, resolve);
    });
    assert.deepStrictEqual(plain(response), { success: false, error: 'Unknown action' });
  });
}

storageTests().then(() => {
  const total = passed + failures.length;
  for (const failure of failures) {
    console.error(`✗ ${failure.name}`);
    console.error(`  ${failure.error.message}`);
  }
  console.log(`\n${passed}/${total} tests passed`);
  if (failures.length > 0) {
    process.exit(1);
  }
});
