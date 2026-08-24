// Background service worker for Text to Calendar extension

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  DEBUG: false, // Set to true to enable detailed logging
  MAX_EVENTS: 20,
  STORAGE_KEY: 'recentEvents',
  SESSION_COUNT_KEY: 'sessionEventCount',
  DEFAULT_DURATION_MS: 60 * 60 * 1000, // 1 hour
  MAX_TITLE_LENGTH: 250,
  MAX_DETAILS_LENGTH: 1000,
  MAX_ORIGINAL_TEXT_LENGTH: 500,
  NOTIFICATION_ID: 'text-to-calendar-status'
};

const CONTEXT_MENU_ID = 'createCalendarEvent';

/**
 * Meridiem forms we accept: "am", "AM", "a.m.", "pm", "p.m." and the single
 * letter form used by course catalogues ("8:00A", "3P").
 *
 * Kept as one self-contained group so that `${MERIDIEM}?` makes the whole
 * meridiem optional rather than just its lookahead.
 *
 * The trailing lookahead is what keeps the single letter form honest: without
 * it "pages 3-5 p. 20" parses as 3pm-5pm and "meet at 5 apples" swallows the
 * leading "a". Used with the `i` flag, so [a-z] covers both cases.
 */
const MERIDIEM = '(?:(?:[ap]\\.?m\\.?|[ap])(?![.a-z]))';

/**
 * A clock hour, 1-12. Keeps "CS 61A" and "Room 7A" from being read as times.
 */
const HOUR_12 = '(?:1[0-2]|0?[1-9])';

/**
 * Debug logger - only logs when DEBUG is enabled.
 * Selected text is user content, so it must never be logged unconditionally.
 */
function log(...args) {
  if (CONFIG.DEBUG) {
    console.log('Text to Calendar:', ...args);
  }
}

/**
 * Error logger - always logs errors
 */
function logError(...args) {
  console.error('Text to Calendar Error:', ...args);
}

/**
 * Truncate a string to a maximum length, keeping storage and generated URLs
 * bounded no matter how much text was selected.
 */
function truncate(text, maxLength) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}\u2026` : text;
}

/**
 * Escape a string for literal use inside a RegExp
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// SESSION STATE (resets when the browser closes)
// =============================================================================

// MV3 service workers are torn down after ~30s idle, so an in-memory counter
// silently resets and the badge disappears. Mirror it into chrome.storage.session
// (cleared automatically when the browser closes) and restore it on every start.
let sessionEventCount = 0;
let sessionCountLoad = null;

function sessionArea() {
  return (chrome.storage && chrome.storage.session) || chrome.storage.local;
}

async function loadSessionCount() {
  if (!sessionCountLoad) {
    sessionCountLoad = sessionArea().get([CONFIG.SESSION_COUNT_KEY])
      .then((result) => {
        const stored = result[CONFIG.SESSION_COUNT_KEY];
        sessionEventCount = Number.isInteger(stored) && stored > 0 ? stored : 0;
        return sessionEventCount;
      })
      .catch((error) => {
        logError('Could not restore session count:', error);
        return sessionEventCount;
      });
  }
  return sessionCountLoad;
}

async function setSessionCount(count) {
  sessionEventCount = Math.max(0, count);
  sessionCountLoad = Promise.resolve(sessionEventCount);
  try {
    await sessionArea().set({ [CONFIG.SESSION_COUNT_KEY]: sessionEventCount });
  } catch (error) {
    logError('Could not persist session count:', error);
  }
  await updateBadge();
}

/**
 * Restore the badge after the service worker has been restarted
 */
function restoreSessionState() {
  loadSessionCount()
    .then(updateBadge)
    .catch((error) => logError('Could not restore badge:', error));
}

// =============================================================================
// NOTIFICATION SYSTEM
// =============================================================================

/**
 * Show a notification to the user
 *
 * Always reuses a single notification id: creating anonymous notifications
 * leaves one entry per event piling up in the notification centre.
 */
async function showNotification(title, message) {
  try {
    if (!chrome.notifications) {
      log('Notifications not available:', title, message);
      return;
    }
    await chrome.notifications.clear(CONFIG.NOTIFICATION_ID);
    await chrome.notifications.create(CONFIG.NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: title,
      message: message,
      silent: true
    });
    log('Notification shown:', title);
  } catch (error) {
    // Notifications might not be available - that's okay
    log('Could not show notification:', error.message);
  }
}

// =============================================================================
// STORAGE UTILITY
// =============================================================================

// Every mutation is a read-modify-write cycle. Two events created in quick
// succession would otherwise read the same snapshot and the second write would
// drop the first event.
let storageQueue = Promise.resolve();

function withStorageLock(task) {
  const run = storageQueue.then(task, task);
  storageQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Drop anything that is not a usable event record (corrupt or partially
 * written history should not break the popup).
 */
function sanitizeEvents(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((event) => event && typeof event === 'object' && typeof event.id === 'string');
}

const EventStorage = {
  /**
   * Generate a unique ID for an event
   */
  generateId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  },

  /**
   * Read the stored history, dropping any corrupt entries
   * @returns {Promise<Array>}
   */
  async readAll() {
    const result = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
    return sanitizeEvents(result[CONFIG.STORAGE_KEY]);
  },

  /**
   * Save an event to storage
   * @param {Object} eventData - Parsed event data
   * @param {string} calendarUrl - The Google Calendar URL
   * @param {string} originalText - The original selected text
   * @returns {Promise<Object>} - The saved event record
   */
  async saveEvent(eventData, calendarUrl, originalText) {
    return withStorageLock(async () => {
      try {
        const eventRecord = {
          id: this.generateId(),
          title: eventData.title,
          startDate: eventData.startDate.toISOString(),
          endDate: eventData.endDate.toISOString(),
          calendarUrl: calendarUrl,
          createdAt: new Date().toISOString(),
          originalText: truncate(originalText, CONFIG.MAX_ORIGINAL_TEXT_LENGTH),
          confidence: eventData.confidence || 0
        };

        let events = await this.readAll();
        events.unshift(eventRecord);

        // Keep only the maximum allowed events
        if (events.length > CONFIG.MAX_EVENTS) {
          events = events.slice(0, CONFIG.MAX_EVENTS);
        }

        await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: events });
        log('Event saved:', eventRecord.id);
        return eventRecord;
      } catch (error) {
        logError('Error saving event:', error);
        throw error;
      }
    });
  },

  /**
   * Get recent events from storage
   * @param {number} limit - Maximum number of events to return (default: 5)
   * @returns {Promise<Array>} - Array of event records
   */
  async getRecentEvents(limit) {
    const max = Number.isInteger(limit) && limit > 0
      ? Math.min(limit, CONFIG.MAX_EVENTS)
      : 5;
    try {
      const events = await this.readAll();
      return events.slice(0, max);
    } catch (error) {
      logError('Error getting recent events:', error);
      return [];
    }
  },

  /**
   * Get a specific event by ID
   * @param {string} id - The event ID
   * @returns {Promise<Object|null>} - The event record or null if not found
   */
  async getEvent(id) {
    try {
      const events = await this.readAll();
      return events.find((event) => event.id === id) || null;
    } catch (error) {
      logError('Error getting event:', error);
      return null;
    }
  },

  /**
   * Clear all event history
   * @returns {Promise<void>}
   */
  async clearHistory() {
    return withStorageLock(async () => {
      try {
        await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: [] });
        log('Event history cleared');
        await setSessionCount(0);
      } catch (error) {
        logError('Error clearing history:', error);
        throw error;
      }
    });
  },

  /**
   * Delete a specific event by ID
   * @param {string} id - The event ID to delete
   * @returns {Promise<boolean>} - True if deleted, false if not found
   */
  async deleteEvent(id) {
    return withStorageLock(async () => {
      try {
        const events = await this.readAll();
        const remaining = events.filter((event) => event.id !== id);

        if (remaining.length === events.length) {
          return false;
        }

        await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: remaining });
        log('Event deleted:', id);

        await loadSessionCount();
        if (sessionEventCount > 0) {
          await setSessionCount(sessionEventCount - 1);
        }
        return true;
      } catch (error) {
        logError('Error deleting event:', error);
        return false;
      }
    });
  },

  /**
   * Get the total count of stored events
   * @returns {Promise<number>}
   */
  async getEventCount() {
    try {
      const events = await this.readAll();
      return events.length;
    } catch (error) {
      logError('Error getting event count:', error);
      return 0;
    }
  }
};

// =============================================================================
// BADGE MANAGEMENT
// =============================================================================

/**
 * Update the extension badge with the session event count
 */
async function updateBadge() {
  if (typeof chrome === 'undefined' || !chrome.action) {
    return;
  }

  try {
    if (sessionEventCount > 0) {
      const text = sessionEventCount > 99 ? '99+' : String(sessionEventCount);
      await chrome.action.setBadgeText({ text });
      await chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (error) {
    // The badge is cosmetic - never let it break event creation
    log('Could not update badge:', error.message);
  }
}

/**
 * Increment session event count and update badge
 */
async function incrementSessionCount() {
  await loadSessionCount();
  await setSessionCount(sessionEventCount + 1);
  log(`Session count: ${sessionEventCount}`);
}

// =============================================================================
// EXTENSION LIFECYCLE
// =============================================================================

/**
 * (Re)create the context menu item.
 *
 * removeAll() first: on an update the previous item still exists and create()
 * would fail with a duplicate id, leaving an unchecked runtime.lastError.
 */
async function ensureContextMenu() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: '\u{1F4C5} Create Calendar Event',
      contexts: ['selection']
    }, () => {
      // create() reports failures through lastError, not by throwing
      if (chrome.runtime.lastError) {
        logError('Error creating context menu:', chrome.runtime.lastError.message);
      } else {
        log('Context menu created');
      }
    });
  } catch (error) {
    logError('Error resetting context menus:', error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
  restoreSessionState();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
  // A new browser session starts with a clean count
  setSessionCount(0);
});

// The service worker is evicted whenever it goes idle; restore the badge every
// time it spins back up so the count survives eviction.
restoreSessionState();

// =============================================================================
// CONTEXT MENU HANDLER
// =============================================================================

chrome.contextMenus.onClicked.addListener(async (info, _tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.selectionText) {
    return;
  }

  const selectedText = info.selectionText.trim();
  if (!selectedText) {
    return;
  }

  let eventData;
  let calendarUrl;

  try {
    eventData = parseEventFromText(selectedText);
    calendarUrl = createGoogleCalendarUrl(eventData);
    await chrome.tabs.create({ url: calendarUrl });
  } catch (error) {
    logError('Error creating calendar event:', error);
    await showNotification('Error', 'Failed to create calendar event. Please try again.');
    return;
  }

  // The calendar tab is already open - a history failure must not be reported
  // to the user as a failure to create the event.
  try {
    await EventStorage.saveEvent(eventData, calendarUrl, selectedText);
    await incrementSessionCount();
    await showNotification(
      'Event Created!',
      `"${eventData.title}" - ${formatDateForDisplay(eventData.startDate)}`
    );
  } catch (saveError) {
    logError('Failed to save event to history:', saveError);
  }
});

/**
 * Format date for display in notifications
 */
function formatDateForDisplay(date) {
  try {
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch (error) {
    return date.toString();
  }
}

// =============================================================================
// MESSAGE HANDLER (for popup communication)
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages may drive the storage API
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ success: false, error: 'Unauthorized sender' });
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      logError('Message handler error:', error);
      sendResponse({ success: false, error: error.message });
    });

  return true; // Keep channel open for async response
});

async function handleMessage(message) {
  if (!message || typeof message.action !== 'string') {
    return { success: false, error: 'Invalid message' };
  }

  switch (message.action) {
  case 'getRecentEvents': {
    const events = await EventStorage.getRecentEvents(message.limit);
    return { success: true, events };
  }

  case 'clearHistory': {
    await EventStorage.clearHistory();
    return { success: true };
  }

  case 'getEvent': {
    const event = await EventStorage.getEvent(message.id);
    return { success: true, event };
  }

  case 'deleteEvent': {
    const deleted = await EventStorage.deleteEvent(message.id);
    return { success: true, deleted };
  }

  case 'getSessionCount': {
    await loadSessionCount();
    return { success: true, count: sessionEventCount };
  }

  default:
    return { success: false, error: 'Unknown action' };
  }
}

// =============================================================================
// MAIN PARSING FUNCTION
// =============================================================================

/**
 * Parse selected text to extract event details with confidence scoring
 * @param {string} text - The selected text to parse
 * @returns {Object} - { title, startDate, endDate, description, confidence, recurrence }
 */
function parseEventFromText(text) {
  const now = new Date();
  const parseResult = {
    title: null,
    startDate: null,
    endDate: null,
    description: text,
    confidence: 0,
    recurrence: {
      isRecurring: false,
      days: [],
      frequency: null
    }
  };

  // Track what we successfully parsed for confidence calculation
  const parsed = {
    date: false,
    time: false,
    duration: false,
    endTime: false
  };

  log('Parsing text:', text.length, 'chars');

  // Recurring weekday codes are parsed up front so the title cleaner knows
  // exactly which token ("MWF", "TuTh") to strip instead of guessing.
  const weekdayResult = parseWeekdays(text);

  // Extract title
  parseResult.title = extractTitle(text, weekdayResult.original);

  // Extract date
  const dateResult = extractDate(text, now);
  let baseDate = null;
  if (dateResult.date) {
    baseDate = dateResult.date;
    parsed.date = true;
    log('Extracted date:', dateResult.type);
  }

  // Check for time range FIRST (e.g., "6-8pm", "10am-2pm")
  const timeRangeResult = extractTimeRange(text);
  let startHours = null;
  let startMinutes = 0;
  let durationMs = CONFIG.DEFAULT_DURATION_MS;
  let durationFromRange = false;

  if (timeRangeResult.found) {
    // Use time range for both start time and duration
    startHours = timeRangeResult.startHours;
    startMinutes = timeRangeResult.startMinutes;
    parsed.time = true;
    parsed.endTime = true;

    // Calculate duration from the range
    const startTotalMinutes = timeRangeResult.startHours * 60 + timeRangeResult.startMinutes;
    let endTotalMinutes = timeRangeResult.endHours * 60 + timeRangeResult.endMinutes;

    // If end is before start, assume next day
    if (endTotalMinutes <= startTotalMinutes) {
      endTotalMinutes += 24 * 60;
    }

    durationMs = (endTotalMinutes - startTotalMinutes) * 60 * 1000;
    durationFromRange = true;
    parsed.duration = true;

    log(`Extracted time range, duration ${durationMs / 60000} minutes`);
  } else {
    // Fall back to single time extraction
    const timeResult = extractTime(text);
    if (timeResult.found) {
      startHours = timeResult.hours;
      startMinutes = timeResult.minutes;
      parsed.time = true;
      log('Extracted time:', timeResult.type);
    }
  }

  // Extract duration or end time (only if not already from time range)
  if (!durationFromRange) {
    const durationResult = extractDuration(text, startHours, startMinutes);
    durationMs = durationResult.duration;
    if (durationResult.found) {
      parsed.duration = true;
      if (durationResult.type === 'until') {
        parsed.endTime = true;
      }
      log(`Extracted duration: ${durationMs / 60000} minutes (${durationResult.type})`);
    }
  }

  // Assemble the start date/time
  if (baseDate) {
    parseResult.startDate = new Date(baseDate);
    if (startHours !== null) {
      parseResult.startDate.setHours(startHours, startMinutes, 0, 0);
    } else {
      // Date found but no time - default to 9 AM
      parseResult.startDate.setHours(9, 0, 0, 0);
      log('No time found, defaulting to 9:00 AM');
    }
  } else if (startHours !== null) {
    // Time found but no date - use today or tomorrow
    parseResult.startDate = new Date(now);
    parseResult.startDate.setHours(startHours, startMinutes, 0, 0);

    // If time has already passed today, use tomorrow
    if (parseResult.startDate <= now) {
      parseResult.startDate.setDate(parseResult.startDate.getDate() + 1);
      log('Time has passed, using tomorrow');
    }
  } else {
    // No date or time found - default to next whole hour
    parseResult.startDate = new Date(now);
    parseResult.startDate.setMinutes(0, 0, 0);
    parseResult.startDate.setHours(parseResult.startDate.getHours() + 1);
    log('No date/time found, defaulting to next hour');
  }

  // Calculate end date
  parseResult.endDate = new Date(parseResult.startDate.getTime() + durationMs);

  // Recurring weekday patterns (MWF, TTh, ...)
  if (weekdayResult.found) {
    parseResult.recurrence = {
      isRecurring: true,
      days: weekdayResult.days,
      frequency: 'WEEKLY'
    };
    log('Found recurring pattern:', weekdayResult.days.join(','));

    // Without an explicit date, start on the soonest upcoming day of the
    // pattern rather than today, keeping the time of day already parsed.
    if (!parsed.date) {
      const aligned = nextRecurrenceStart(now, weekdayResult.days, parseResult.startDate);
      if (aligned) {
        parseResult.startDate = aligned;
        parseResult.endDate = new Date(aligned.getTime() + durationMs);
        log('Aligned start to next occurrence:', aligned.toDateString());
      }
    }
  }

  // Calculate confidence score (0-1)
  parseResult.confidence = calculateConfidence(parsed, text);
  log('Confidence score:', parseResult.confidence);

  return parseResult;
}

/**
 * Calculate confidence score based on what was successfully parsed
 */
function calculateConfidence(parsed, text) {
  let score = 0;
  const weights = {
    date: 0.35,
    time: 0.35,
    duration: 0.20,
    textLength: 0.10
  };

  if (parsed.date) {
    score += weights.date;
  }
  if (parsed.time) {
    score += weights.time;
  }
  if (parsed.duration || parsed.endTime) {
    score += weights.duration;
  }

  // Bonus for reasonable text length (not too short, not too long)
  const textLength = text.trim().length;
  if (textLength >= 10 && textLength <= 200) {
    score += weights.textLength;
  } else if (textLength > 5) {
    score += weights.textLength * 0.5;
  }

  return Math.min(1, Math.round(score * 100) / 100);
}

// =============================================================================
// TITLE EXTRACTION
// =============================================================================

/**
 * Clean date/time patterns from title text
 * @param {string} text - The text to clean
 * @returns {string} - Text with date/time patterns removed
 */
function cleanTitle(text, weekdayCode) {
  // First, convert newlines to spaces
  let result = text.replace(/\n/g, ' ');

  // Full day names (with optional DUE prefix)
  result = result.replace(/\b(DUE\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b,?/gi, '');

  // Abbreviated day names: Mon, Tue, Wed, Thu, Fri, Sat, Sun
  result = result.replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b,?\s*/gi, '');

  // The compact schedule code, but only the one actually recognised as a
  // recurrence ("MWF"). A blind [MTWRFSU]+ sweep here used to eat words such
  // as "US" and "MT" out of perfectly good titles.
  if (weekdayCode) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(weekdayCode)}\\b`, 'g'), '');
  }

  // Class type indicators: LEC, LAB, DIS, SEM (lecture, lab, discussion, seminar)
  result = result.replace(/\b(LEC|LAB|DIS|SEM|LECTURE|DISCUSSION|SEMINAR|LABORATORY)\b/gi, '');

  // Relative dates
  result = result.replace(/\b(today|tomorrow|day after tomorrow|next\s+week|this\s+week)\b/gi, '');

  // Time ranges with single-letter or full meridiem: "8:00A - 11:00A", "6-8pm", "9am-5pm"
  // Handles hyphen (-), en-dash, em-dash, and "to"
  result = result.replace(
    new RegExp(`\\b${HOUR_12}(?::[0-5]\\d)?\\s*${MERIDIEM}?\\s*(?:-|\u2013|\u2014|to)\\s*${HOUR_12}(?::[0-5]\\d)?\\s*${MERIDIEM}`, 'gi'),
    ''
  );

  // Times with "at": "at 3pm", "at 11:59 PM", "at noon", "at midnight", "at 3P"
  result = result.replace(new RegExp(`\\bat\\s+\\d{1,2}(?::\\d{2})?\\s*${MERIDIEM}?`, 'gi'), '');
  result = result.replace(/\bat\s+(?:noon|midnight)\b/gi, '');

  // Standalone times: "8:00A", "3P", "3:00 pm"
  result = result.replace(new RegExp(`\\b${HOUR_12}(?::[0-5]\\d)?\\s*${MERIDIEM}`, 'gi'), '');

  // Time of day words: "morning", "afternoon", "evening", "night"
  result = result.replace(/\b(?:in\s+the\s+)?(?:morning|afternoon|evening|night)\b/gi, '');

  // Dates: MM/DD/YYYY, MM/DD, MM-DD-YYYY, MM-DD
  result = result.replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/gi, '');

  // Month day year: "January 5, 2025", "Jan 5 2025", "January 5th"
  const monthPattern = 'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec';
  result = result.replace(new RegExp(`\\b(${monthPattern})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:[,\\s]+\\d{4})?\\b`, 'gi'), '');

  // Day month: "5 January", "5th January 2025"
  result = result.replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(${monthPattern})(?:\\s+\\d{4})?\\b`, 'gi'), '');

  // ISO dates: 2025-01-25
  result = result.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '');

  // Duration phrases: "for 2 hours", "for 30 minutes", "for an hour"
  result = result.replace(/\bfor\s+(?:an?\s+)?(?:\d+(?:\.\d+)?\s*)?(?:hours?|hrs?|minutes?|mins?|half\s+(?:an?\s+)?hour)\b/gi, '');

  // "until" phrases: "until 5pm", "until noon"
  result = result.replace(new RegExp(`\\buntil\\s+\\d{1,2}(?::\\d{2})?\\s*${MERIDIEM}?`, 'gi'), '');
  result = result.replace(/\buntil\s+(?:noon|midnight)\b/gi, '');

  // Clean up leftover connecting words at start/end
  result = result.replace(/^[\s,\-\u2013\u2014:]*\b(DUE|on|at|from|to|starting|ending|begins|ends|by)\b[\s,\-\u2013\u2014:]*/gi, '');
  result = result.replace(/[\s,\-\u2013\u2014:]*\b(on|at|from|to|DUE)\b[\s,\-\u2013\u2014:]*$/gi, '');

  // Clean up multiple spaces
  result = result.replace(/\s+/g, ' ');

  // Clean up punctuation left over (leading/trailing commas, colons, dashes, parentheses)
  result = result.replace(/^[\s,\-\u2013\u2014:()]+/, '');
  result = result.replace(/[\s,\-\u2013\u2014:()]+$/, '');

  // One more pass for connecting words that might now be at edges
  result = result.replace(/^[\s,\-\u2013\u2014:]*\b(DUE|on|at|from|to)\b[\s,\-\u2013\u2014:]*/gi, '');
  result = result.replace(/[\s,\-\u2013\u2014:]*\b(on|at|from|to|DUE)\b[\s,\-\u2013\u2014:]*$/gi, '');

  return result.trim();
}

/**
 * Extract a suitable title from the text
 * @param {string} text - The selected text
 * @param {string|null} weekdayCode - Recognised schedule code to strip, if any
 */
function extractTitle(text, weekdayCode) {
  // Clean up whitespace first
  const cleaned = text.replace(/\s+/g, ' ').trim();

  // Try to clean date/time from the title
  const titleWithoutDateTime = cleanTitle(cleaned, weekdayCode);

  // Use cleaned title if it has meaningful content (at least 3 chars)
  // Otherwise fall back to original text
  const finalTitle = titleWithoutDateTime.length >= 3 ? titleWithoutDateTime : cleaned;

  // If text is short enough, use it all
  if (finalTitle.length <= 60) {
    return finalTitle;
  }

  // Try to get the first sentence
  const sentenceMatch = finalTitle.match(/^[^.!?]+[.!?]?/);
  if (sentenceMatch && sentenceMatch[0].length <= 100) {
    return sentenceMatch[0].trim();
  }

  // Truncate to 60 chars at a word boundary
  const truncated = finalTitle.substring(0, 60);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 30) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

// =============================================================================
// DATE EXTRACTION
// =============================================================================

// Month name mappings
const MONTHS = {
  'january': 0, 'jan': 0,
  'february': 1, 'feb': 1,
  'march': 2, 'mar': 2,
  'april': 3, 'apr': 3,
  'may': 4,
  'june': 5, 'jun': 5,
  'july': 6, 'jul': 6,
  'august': 7, 'aug': 7,
  'september': 8, 'sept': 8, 'sep': 8,
  'october': 9, 'oct': 9,
  'november': 10, 'nov': 10,
  'december': 11, 'dec': 11
};

const MONTH_PATTERN = Object.keys(MONTHS).join('|');

// Day name mappings
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Extract date from text
 * @returns {Object} - { date: Date|null, type: string }
 */
function extractDate(text, now) {
  const lowerText = text.toLowerCase();

  const debugLog = (pattern, matched, match = null) => {
    if (CONFIG.DEBUG) {
      console.log(`  [extractDate] Pattern "${pattern}": ${matched ? 'MATCHED' : 'no match'}${match ? ` \u2192 "${match}"` : ''}`);
    }
  };

  // Order matters - SPECIFIC dates beat GENERAL day names
  // Check numeric/explicit date formats BEFORE day names

  // 1. ISO format: YYYY-MM-DD (most specific, check first)
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  debugLog('ISO (YYYY-MM-DD)', !!isoMatch, isoMatch?.[0]);
  if (isoMatch) {
    const date = makeDate(
      parseInt(isoMatch[1], 10),
      parseInt(isoMatch[2], 10) - 1,
      parseInt(isoMatch[3], 10)
    );
    if (date) {
      return { date, type: 'iso' };
    }
  }

  // 2. MM/DD/YYYY or MM-DD-YYYY (full date with year)
  const fullDateMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  debugLog('MM/DD/YYYY', !!fullDateMatch, fullDateMatch?.[0]);
  if (fullDateMatch) {
    const date = makeDate(
      parseInt(fullDateMatch[3], 10),
      parseInt(fullDateMatch[1], 10) - 1,
      parseInt(fullDateMatch[2], 10)
    );
    if (date) {
      return { date, type: 'mm-dd-yyyy' };
    }
  }

  // 3. Month day year: "January 5, 2025" / "Jan 5 2025" / "January 5th, 2025"
  const monthDayYearRegex = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[,\\s]+|\\s+)(\\d{4})\\b`,
    'i'
  );
  const monthDayYearMatch = text.match(monthDayYearRegex);
  debugLog('month day year', !!monthDayYearMatch, monthDayYearMatch?.[0]);
  if (monthDayYearMatch) {
    const date = makeDate(
      parseInt(monthDayYearMatch[3], 10),
      MONTHS[monthDayYearMatch[1].toLowerCase()],
      parseInt(monthDayYearMatch[2], 10)
    );
    if (date) {
      return { date, type: 'month-day-year' };
    }
  }

  // 4. MM/DD (no year) - the lookbehind keeps times like "11:59" out
  const shortDateMatch = text.match(/(?<!:)\b(\d{1,2})\/(\d{1,2})\b(?!\/\d)/);
  debugLog('MM/DD (no year)', !!shortDateMatch, shortDateMatch?.[0]);
  if (shortDateMatch) {
    const month = parseInt(shortDateMatch[1], 10);
    const day = parseInt(shortDateMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = rollForward(makeDate(now.getFullYear(), month - 1, day), now, month - 1, day);
      if (date) {
        return { date, type: 'mm-dd' };
      }
    }
  }

  // 5. Month day (no year): "January 5" / "Jan 5th"
  const monthDayRegex = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\b|,|$)`,
    'i'
  );
  const monthDayMatch = text.match(monthDayRegex);
  debugLog('month day (no year)', !!monthDayMatch, monthDayMatch?.[0]);
  if (monthDayMatch) {
    const month = MONTHS[monthDayMatch[1].toLowerCase()];
    const day = parseInt(monthDayMatch[2], 10);
    const date = rollForward(makeDate(now.getFullYear(), month, day), now, month, day);
    if (date) {
      return { date, type: 'month-day' };
    }
  }

  // 6. Day month (European format): "5 January" / "5th January 2025"
  const dayMonthRegex = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?\\b`,
    'i'
  );
  const dayMonthMatch = text.match(dayMonthRegex);
  debugLog('day month (European)', !!dayMonthMatch, dayMonthMatch?.[0]);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const month = MONTHS[dayMonthMatch[2].toLowerCase()];
    const hasYear = !!dayMonthMatch[3];
    const year = hasYear ? parseInt(dayMonthMatch[3], 10) : now.getFullYear();
    let date = makeDate(year, month, day);
    if (!hasYear) {
      date = rollForward(date, now, month, day);
    }
    if (date) {
      return { date, type: 'day-month' };
    }
  }

  // 7. Relative dates: today, tomorrow, day after tomorrow
  const todayMatch = /\btoday\b/.test(lowerText);
  debugLog('today', todayMatch);
  if (todayMatch) {
    return { date: startOfDay(now, 0), type: 'relative-today' };
  }

  const tomorrowMatch = /\btomorrow\b/.test(lowerText);
  debugLog('tomorrow', tomorrowMatch);
  if (tomorrowMatch) {
    return { date: startOfDay(now, 1), type: 'relative-tomorrow' };
  }

  const dayAfterMatch = /\b(day after tomorrow|day after tmrw)\b/.test(lowerText);
  debugLog('day after tomorrow', dayAfterMatch);
  if (dayAfterMatch) {
    return { date: startOfDay(now, 2), type: 'relative-dayafter' };
  }

  // 8. Next week
  const nextWeekMatch = /\bnext\s+week\b/.test(lowerText);
  debugLog('next week', nextWeekMatch);
  if (nextWeekMatch) {
    return { date: startOfDay(now, 7), type: 'relative-nextweek' };
  }

  // 9. "next [day]" or "this [day]"
  const dayModifierMatch = lowerText.match(/\b(next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  debugLog('next/this [day]', !!dayModifierMatch, dayModifierMatch?.[0]);
  if (dayModifierMatch) {
    const modifier = dayModifierMatch[1];
    const targetDay = DAYS.indexOf(dayModifierMatch[2]);
    const date = startOfDay(now, 0);

    let daysToAdd = targetDay - date.getDay();

    if (modifier === 'next') {
      // "next Monday" means the Monday of next week
      if (daysToAdd <= 0) {
        daysToAdd += 7;
      }
      daysToAdd += 7; // Add another week for "next"
    } else if (daysToAdd < 0) {
      // "this Monday" means the upcoming Monday (or today if it's Monday)
      daysToAdd += 7;
    }

    date.setDate(date.getDate() + daysToAdd);
    return { date, type: `day-${modifier}` };
  }

  // 10. Standalone day names (next occurrence) - LAST because least specific
  const standaloneDayMatch = lowerText.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  debugLog('standalone day', !!standaloneDayMatch, standaloneDayMatch?.[0]);
  if (standaloneDayMatch) {
    const targetDay = DAYS.indexOf(standaloneDayMatch[1]);
    const date = startOfDay(now, 0);

    let daysToAdd = targetDay - date.getDay();

    // If it's today or in the past this week, go to next week
    if (daysToAdd <= 0) {
      daysToAdd += 7;
    }

    date.setDate(date.getDate() + daysToAdd);
    return { date, type: 'day-standalone' };
  }

  debugLog('No date pattern matched', true);
  return { date: null, type: 'none' };
}

/**
 * Midnight, `offsetDays` from the given date
 */
function startOfDay(from, offsetDays) {
  const date = new Date(from);
  date.setDate(date.getDate() + offsetDays);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Build a local date, rejecting values that silently roll over
 * (`new Date(2025, 1, 30)` quietly becomes March 2nd).
 * @returns {Date|null}
 */
function makeDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 1970 || year > 2100) {
    return null;
  }
  const date = new Date(year, month, day);
  if (!isValidDate(date) ||
      date.getFullYear() !== year ||
      date.getMonth() !== month ||
      date.getDate() !== day) {
    return null;
  }
  return date;
}

/**
 * A date with no year that has already passed means next year.
 * Compares whole days so an event earlier today still counts as today.
 * @returns {Date|null}
 */
function rollForward(date, now, month, day) {
  if (!date) {
    return null;
  }
  const todayMidnight = new Date(now);
  todayMidnight.setHours(0, 0, 0, 0);
  if (date < todayMidnight) {
    return makeDate(date.getFullYear() + 1, month, day);
  }
  return date;
}

/**
 * Validate that a date is reasonable
 */
function isValidDate(date) {
  return date instanceof Date && !isNaN(date.getTime());
}

// =============================================================================
// TIME EXTRACTION
// =============================================================================

// Compiled once. Neither carries the /g flag, so they hold no lastIndex state
// between calls.
//
// Groups: 1=startHour, 2=startMin, 3=startMeridiem, 4=endHour, 5=endMin, 6=endMeridiem
// Covers "6-8pm", "6pm - 8pm", "6:00-8:00pm", "10am-2pm", "8:00A - 11:00A",
// "6 to 8pm", and en/em-dash variants.
const TIME_RANGE_REGEX = new RegExp(
  `\\b(${HOUR_12})(?::([0-5]\\d))?\\s*(${MERIDIEM})?\\s*(?:-|\u2013|\u2014|to)\\s*(${HOUR_12})(?::([0-5]\\d))?\\s*(${MERIDIEM})`,
  'i'
);

const TIME_12_REGEX = new RegExp(`\\b(${HOUR_12})(?::([0-5]\\d))?\\s*(${MERIDIEM})`, 'i');

const NO_TIME_RANGE = Object.freeze({
  found: false,
  startHours: null,
  startMinutes: 0,
  endHours: null,
  endMinutes: 0,
  type: 'none'
});

/**
 * Pick the 24-hour start hour when only the end of a range carried a meridiem.
 *
 * Both readings of the bare start hour are scored by the event length they
 * imply (wrapping past midnight) and the shortest sensible one wins:
 *   "6-8pm"   6am would be 14h  -> 6pm      "10-2pm"  10pm would be negative -> 10am
 *   "12-2pm"  12am would be 14h -> noon     "11-12am" 11am would be 13h     -> 11pm
 *
 * @returns {number} start hour in 24-hour form
 */
function inferStartHour(startHours, startMinutes, endHours, endMinutes) {
  const endTotal = endHours * 60 + endMinutes;
  const asAm = startHours === 12 ? 0 : startHours;
  const asPm = startHours === 12 ? 12 : startHours + 12;

  let best = null;
  for (const hour of [asAm, asPm]) {
    let minutes = endTotal - (hour * 60 + startMinutes);
    if (minutes <= 0) {
      minutes += 24 * 60; // range runs past midnight
    }
    if (minutes <= 12 * 60 && (!best || minutes < best.minutes)) {
      best = { hour, minutes };
    }
  }

  // Neither reading gives a sane length (e.g. "1-1am") - keep the AM reading
  // and let the caller's next-day handling sort out the duration.
  return best ? best.hour : asAm;
}

/**
 * Extract a time range from text (e.g., "6-8pm", "6pm-8pm", "10am-2pm")
 * @param {string} text - The text to parse
 * @returns {Object} - { found, startHours, startMinutes, endHours, endMinutes, type }
 */
function extractTimeRange(text) {
  const match = text.match(TIME_RANGE_REGEX);
  if (!match) {
    return NO_TIME_RANGE;
  }

  let startHours = parseInt(match[1], 10);
  const startMinutes = match[2] ? parseInt(match[2], 10) : 0;
  const startMeridiem = match[3];

  let endHours = parseInt(match[4], 10);
  const endMinutes = match[5] ? parseInt(match[5], 10) : 0;
  const endMeridiem = match[6];

  // Validate hour and minute values
  if (startHours < 1 || startHours > 12 || endHours < 1 || endHours > 12 ||
      startMinutes > 59 || endMinutes > 59) {
    log('[extractTimeRange] Out of range values, skipping');
    return NO_TIME_RANGE;
  }

  // Convert end time to 24-hour format
  const endIsPM = /^p/i.test(endMeridiem);
  if (endIsPM && endHours !== 12) {
    endHours += 12;
  } else if (!endIsPM && endHours === 12) {
    endHours = 0;
  }

  // Convert start time to 24-hour format
  if (startMeridiem) {
    const startIsPM = /^p/i.test(startMeridiem);
    if (startIsPM && startHours !== 12) {
      startHours += 12;
    } else if (!startIsPM && startHours === 12) {
      startHours = 0;
    }
  } else {
    startHours = inferStartHour(startHours, startMinutes, endHours, endMinutes);
  }

  log('[extractTimeRange] Parsed range', `${startHours}:${startMinutes} - ${endHours}:${endMinutes}`);

  return {
    found: true,
    startHours,
    startMinutes,
    endHours,
    endMinutes,
    type: 'time-range'
  };
}

/**
 * Extract time from text
 * @returns {Object} - { found: boolean, hours: number, minutes: number, type: string }
 */
function extractTime(text) {
  const lowerText = text.toLowerCase();

  // 1. Special named times
  if (/\b(at\s+)?noon\b/.test(lowerText)) {
    return { found: true, hours: 12, minutes: 0, type: 'noon' };
  }

  if (/\b(at\s+)?midnight\b/.test(lowerText)) {
    return { found: true, hours: 0, minutes: 0, type: 'midnight' };
  }

  // 2. Time of day descriptors
  if (/\b(in\s+the\s+)?morning\b/.test(lowerText) && !/\bgood\s+morning\b/.test(lowerText)) {
    return { found: true, hours: 9, minutes: 0, type: 'morning' };
  }

  if (/\b(in\s+the\s+)?afternoon\b/.test(lowerText)) {
    return { found: true, hours: 14, minutes: 0, type: 'afternoon' };
  }

  if (/\b(in\s+the\s+)?evening\b/.test(lowerText)) {
    return { found: true, hours: 18, minutes: 0, type: 'evening' };
  }

  if (/\b(at\s+)?night\b/.test(lowerText) && !/\bgood\s+night\b/.test(lowerText)) {
    return { found: true, hours: 20, minutes: 0, type: 'night' };
  }

  // 3. 12-hour format: 3pm, 3:00pm, 3:00 PM, 3 pm, 3:30 a.m., 3P, 3:00A
  const time12Match = text.match(TIME_12_REGEX);
  if (time12Match) {
    let hours = parseInt(time12Match[1], 10);
    const minutes = time12Match[2] ? parseInt(time12Match[2], 10) : 0;
    const isPM = /^p/i.test(time12Match[3]);

    if (hours >= 1 && hours <= 12 && minutes <= 59) {
      if (isPM && hours !== 12) {
        hours += 12;
      } else if (!isPM && hours === 12) {
        hours = 0;
      }
      return { found: true, hours, minutes, type: '12-hour' };
    }
  }

  // 4. 24-hour format: 15:00, 09:30 (but not dates like 01/05)
  const time24Match = text.match(/(?<![/\-\d])(\d{1,2}):(\d{2})(?![/\-\d])/);
  if (time24Match) {
    const hours = parseInt(time24Match[1], 10);
    const minutes = parseInt(time24Match[2], 10);

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { found: true, hours, minutes, type: '24-hour' };
    }
  }

  // 5. "at [number]" without am/pm - guess based on context
  const atTimeMatch = text.match(/\bat\s+(\d{1,2})\b(?!\s*[:\d/\-])/i);
  if (atTimeMatch) {
    let hours = parseInt(atTimeMatch[1], 10);

    if (hours >= 1 && hours <= 12) {
      // Assume PM for hours 1-7 (business hours), AM for 8-12
      if (hours <= 7) {
        hours += 12;
      }
      return { found: true, hours, minutes: 0, type: 'at-number' };
    }
  }

  // 6. Standalone hour with o'clock: "3 o'clock"
  const oclockMatch = text.match(/\b(\d{1,2})\s*o['\u2018\u2019]?clock\b/i);
  if (oclockMatch) {
    let hours = parseInt(oclockMatch[1], 10);
    if (hours >= 1 && hours <= 12) {
      // Assume PM for hours 1-7
      if (hours <= 7) {
        hours += 12;
      }
      return { found: true, hours, minutes: 0, type: 'oclock' };
    }
  }

  return { found: false, hours: null, minutes: 0, type: 'none' };
}

// =============================================================================
// DURATION EXTRACTION
// =============================================================================

/**
 * Extract duration from text
 * @param {string} text - The text to parse
 * @param {number|null} startHours - Start hour if known (for "until" calculations)
 * @param {number} startMinutes - Start minutes if known
 * @returns {Object} - { found: boolean, duration: number (ms), type: string }
 */
function extractDuration(text, startHours, startMinutes) {
  const lowerText = text.toLowerCase();

  // 1. "until [time]" - calculate duration from start time
  const untilMatch = lowerText.match(/\buntil\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)?/i);
  if (untilMatch && startHours !== null) {
    let endHours = parseInt(untilMatch[1], 10);
    const endMinutes = untilMatch[2] ? parseInt(untilMatch[2], 10) : 0;
    const meridiem = untilMatch[3];

    // Handle meridiem
    if (meridiem) {
      const isPM = /^p/i.test(meridiem);
      if (isPM && endHours !== 12) {
        endHours += 12;
      } else if (!isPM && endHours === 12) {
        endHours = 0;
      }
    } else {
      // No meridiem - guess based on start time
      if (endHours <= 12 && endHours < (startHours % 12 || 12)) {
        if (endHours !== 12) {
          endHours += 12;
        }
      } else if (endHours <= 7) {
        endHours += 12;
      }
    }

    // Calculate duration
    const startTotalMinutes = startHours * 60 + startMinutes;
    let endTotalMinutes = endHours * 60 + endMinutes;

    // If end is before start, assume next day
    if (endTotalMinutes <= startTotalMinutes) {
      endTotalMinutes += 24 * 60;
    }

    const durationMinutes = endTotalMinutes - startTotalMinutes;
    const durationMs = durationMinutes * 60 * 1000;

    // Sanity check - cap at 24 hours
    if (durationMs > 0 && durationMs <= 24 * 60 * 60 * 1000) {
      return { found: true, duration: durationMs, type: 'until' };
    }
  }

  // 2. "for X hours/minutes" pattern
  const forDurationMatch = lowerText.match(
    /\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/
  );
  if (forDurationMatch) {
    const value = parseFloat(forDurationMatch[1]);
    const unit = forDurationMatch[2];

    if (/^(hours?|hrs?|h)$/i.test(unit)) {
      return { found: true, duration: value * 60 * 60 * 1000, type: 'for-hours' };
    } else {
      return { found: true, duration: value * 60 * 1000, type: 'for-minutes' };
    }
  }

  // 3. "for an hour" / "for a half hour"
  if (/\bfor\s+an?\s+hour\b/.test(lowerText)) {
    return { found: true, duration: 60 * 60 * 1000, type: 'for-an-hour' };
  }

  if (/\bfor\s+(a\s+)?half\s+(an?\s+)?hour\b/.test(lowerText)) {
    return { found: true, duration: 30 * 60 * 1000, type: 'for-half-hour' };
  }

  // 4. "X hour/minute [meeting/call/etc]" pattern (e.g., "2 hour meeting")
  const durationNounMatch = lowerText.match(
    /\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\s+(?:meeting|call|session|appointment|event|class|lecture|workshop)/
  );
  if (durationNounMatch) {
    const value = parseFloat(durationNounMatch[1]);
    const unit = durationNounMatch[2];

    if (/^(hours?|hrs?|h)$/i.test(unit)) {
      return { found: true, duration: value * 60 * 60 * 1000, type: 'noun-hours' };
    } else {
      return { found: true, duration: value * 60 * 1000, type: 'noun-minutes' };
    }
  }

  // 5. General "X hours/minutes" without context (lower priority)
  const generalDurationMatch = lowerText.match(
    /\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/
  );
  if (generalDurationMatch) {
    const value = parseFloat(generalDurationMatch[1]);
    const unit = generalDurationMatch[2];

    // Avoid matching things like "at 2 hours"
    const beforeMatch = lowerText.substring(0, lowerText.indexOf(generalDurationMatch[0]));
    if (!/\bat\s*$/.test(beforeMatch)) {
      if (/^(hours?|hrs?)$/i.test(unit)) {
        return { found: true, duration: value * 60 * 60 * 1000, type: 'general-hours' };
      } else {
        return { found: true, duration: value * 60 * 1000, type: 'general-minutes' };
      }
    }
  }

  // 6. "half hour" or "half an hour" without "for"
  if (/\bhalf\s+(an?\s+)?hour\b/.test(lowerText)) {
    return { found: true, duration: 30 * 60 * 1000, type: 'half-hour' };
  }

  // Default: 1 hour
  return { found: false, duration: CONFIG.DEFAULT_DURATION_MS, type: 'default' };
}

// =============================================================================
// RECURRING EVENT PARSING
// =============================================================================

/**
 * Parse compact weekday codes from text (e.g., MWF, TTh, MTWThF)
 * @param {string} text - The text to parse
 * @returns {Object} - { found: boolean, days: ['MO', 'WE', 'FR'], original: 'MWF' }
 */
function parseWeekdays(text) {
  const compact = parseCompactWeekdays(text);
  if (compact) {
    return compact;
  }
  return parseSpelledWeekdays(text);
}

// Ordered Monday-first: a real schedule code lists its days in this order.
const DAY_ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

const DAY_TOKENS_3 = {
  MON: 'MO', TUE: 'TU', WED: 'WE', THU: 'TH', FRI: 'FR', SAT: 'SA', SUN: 'SU'
};

const DAY_TOKENS_2 = {
  MO: 'MO', TU: 'TU', WE: 'WE', TH: 'TH', FR: 'FR', SA: 'SA', SU: 'SU'
};

// R is the common academic notation for Thursday
const DAY_TOKENS_1 = {
  M: 'MO', T: 'TU', W: 'WE', R: 'TH', F: 'FR', S: 'SA', U: 'SU'
};

/**
 * Split a compact schedule code ("MWF", "TuTh", "MTWThF") into day codes.
 *
 * Longest token first, so "TuTh" is Tuesday+Thursday rather than
 * Tuesday+Sunday+Thursday. Returns null the moment a character cannot be
 * consumed - that full-consumption rule is what stops ordinary words from
 * being read as schedules.
 *
 * @returns {string[]|null}
 */
function tokenizeDayCode(code) {
  const upper = code.toUpperCase();
  const days = [];
  let i = 0;

  while (i < upper.length) {
    const three = upper.substring(i, i + 3);
    const two = upper.substring(i, i + 2);
    const one = upper[i];

    if (DAY_TOKENS_3[three]) {
      days.push(DAY_TOKENS_3[three]);
      i += 3;
    } else if (DAY_TOKENS_2[two]) {
      days.push(DAY_TOKENS_2[two]);
      i += 2;
    } else if (DAY_TOKENS_1[one]) {
      days.push(DAY_TOKENS_1[one]);
      i += 1;
    } else {
      return null;
    }
  }

  return days;
}

/**
 * Find a compact weekday code such as MWF, TTh or MTWThF.
 * @returns {Object|null} - { found, days, original }
 */
function parseCompactWeekdays(text) {
  // Local (not hoisted) because of the /g flag: a shared instance would carry
  // lastIndex across calls and start matching mid-string.
  const compactPattern = /\b([MTWRFSU][MTWRFSUhuae]+)\b/g;

  let match;
  while ((match = compactPattern.exec(text)) !== null) {
    const days = tokenizeDayCode(match[1]);
    if (!days || days.length < 2) {
      continue;
    }

    const unique = [...new Set(days)];
    if (unique.length < 2) {
      continue;
    }

    // A schedule code reads Monday-first and never repeats a day. Requiring
    // strictly ascending order rejects acronyms like "US" (Sunday, Saturday)
    // and "SF" that happen to be built from day letters.
    const positions = unique.map((day) => DAY_ORDER.indexOf(day));
    const ascending = positions.every((pos, index) => index === 0 || pos > positions[index - 1]);
    if (!ascending || unique.length !== days.length) {
      continue;
    }

    return { found: true, days: unique, original: match[1] };
  }

  return null;
}

/**
 * Find spelled out day lists: "M, W, F", "Mon Wed Fri", "Tue/Thu"
 * @returns {Object} - { found, days, original }
 */
function parseSpelledWeekdays(text) {
  const spacedPattern = /\b((?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s*[,/\s]\s*(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday))+)\b/i;

  const spacedMatch = text.match(spacedPattern);
  if (spacedMatch) {
    const wordMap = {
      mon: 'MO', monday: 'MO',
      tue: 'TU', tuesday: 'TU',
      wed: 'WE', wednesday: 'WE',
      thu: 'TH', thursday: 'TH',
      fri: 'FR', friday: 'FR',
      sat: 'SA', saturday: 'SA',
      sun: 'SU', sunday: 'SU'
    };

    const days = spacedMatch[0]
      .toLowerCase()
      .split(/[\s,/]+/)
      .map((word) => wordMap[word])
      .filter(Boolean);

    const unique = [...new Set(days)];
    if (unique.length >= 2) {
      unique.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
      return { found: true, days: unique, original: spacedMatch[0] };
    }
  }

  return { found: false, days: [], original: null };
}

/**
 * First occurrence of any day in the pattern, at or after `now`, keeping the
 * time of day from `timeSource`.
 *
 * The old version wrote the target date field by field (setFullYear, then
 * setMonth, then setDate) which overflows: Jan 31 -> setMonth(1) is Mar 3.
 * @returns {Date|null}
 */
function nextRecurrenceStart(now, dayCodes, timeSource) {
  const dayNumbers = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  let best = null;

  for (const code of dayCodes) {
    const targetDay = dayNumbers[code];
    if (targetDay === undefined) {
      continue;
    }

    const candidate = new Date(now);
    candidate.setHours(timeSource.getHours(), timeSource.getMinutes(), 0, 0);

    let daysToAdd = targetDay - candidate.getDay();
    if (daysToAdd < 0) {
      daysToAdd += 7;
    }
    candidate.setDate(candidate.getDate() + daysToAdd);

    // Today's class has already started - go to next week's
    if (candidate < now) {
      candidate.setDate(candidate.getDate() + 7);
    }

    if (!best || candidate < best) {
      best = candidate;
    }
  }

  return best;
}

// =============================================================================
// CALENDAR URL GENERATION
// =============================================================================

/**
 * Format date for Google Calendar URL (YYYYMMDDTHHmmSS)
 */
function formatDateForCalendar(date) {
  const pad = (n) => n.toString().padStart(2, '0');

  // UTC with the trailing Z. A naked local timestamp is interpreted in the
  // timezone of the user's Google Calendar, which is not necessarily the
  // timezone of the browser that parsed the text.
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());

  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Create Google Calendar URL with parsed event data
 */
function createGoogleCalendarUrl(eventData) {
  const baseUrl = 'https://calendar.google.com/calendar/render';

  if (!isValidDate(eventData.startDate) || !isValidDate(eventData.endDate)) {
    throw new Error('Cannot build calendar URL without a valid start and end date');
  }

  const startFormatted = formatDateForCalendar(eventData.startDate);
  const endFormatted = formatDateForCalendar(eventData.endDate);

  // Selections can be long; keep the generated URL well inside browser limits
  const title = truncate((eventData.title || '').trim(), CONFIG.MAX_TITLE_LENGTH) || 'New Event';
  const details = truncate(eventData.description || '', CONFIG.MAX_DETAILS_LENGTH);

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${startFormatted}/${endFormatted}`,
    details: details
  });

  // Add recurrence rule if this is a recurring event
  const recurrence = eventData.recurrence;
  if (recurrence && recurrence.isRecurring && recurrence.days.length > 0) {
    const rrule = `RRULE:FREQ=${recurrence.frequency};BYDAY=${recurrence.days.join(',')}`;
    params.append('recur', rrule);
    log('Added recurrence rule:', rrule);
  }

  return `${baseUrl}?${params.toString()}`;
}

// =============================================================================
// TEST FUNCTION (for debugging from console)
// =============================================================================

/**
 * Test function for debugging date/time parsing from the console
 * Usage: testParsing("january 22, 9:30")
 * @param {string} text - The text to parse
 */
function testParsing(text) {
  console.log('='.repeat(60));
  console.log('Testing:', text);
  console.log('='.repeat(60));

  const result = parseEventFromText(text);

  console.log('\nRESULT:');
  console.log('  Title:', result.title);
  console.log('  Start:', result.startDate.toLocaleString());
  console.log('  End:', result.endDate.toLocaleString());
  console.log('  Confidence:', result.confidence);
  console.log('  Description:', result.description);

  return result;
}

// Make testParsing available globally for console access
if (typeof globalThis !== 'undefined') {
  globalThis.testParsing = testParsing;
}

