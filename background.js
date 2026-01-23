// Background service worker for Text to Calendar extension

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  DEBUG: false, // Set to true to enable detailed logging
  MAX_EVENTS: 20,
  STORAGE_KEY: 'recentEvents',
  DEFAULT_DURATION_MS: 60 * 60 * 1000 // 1 hour
};

/**
 * Debug logger - only logs when DEBUG is enabled
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

// =============================================================================
// SESSION STATE (resets when browser closes)
// =============================================================================

let sessionEventCount = 0;

// =============================================================================
// NOTIFICATION SYSTEM
// =============================================================================

/**
 * Show a notification to the user
 * Falls back to console log if notifications aren't available
 */
async function showNotification(title, message) {
  try {
    // Check if we have notification permission
    if (chrome.notifications) {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: title,
        message: message,
        silent: true
      });
      log('Notification shown:', title);
    } else {
      log('Notifications not available, message:', title, message);
    }
  } catch (error) {
    // Notifications might not be available - that's okay
    log('Could not show notification:', error.message);
  }
}

// =============================================================================
// STORAGE UTILITY
// =============================================================================

const EventStorage = {
  /**
   * Generate a unique ID for an event
   */
  generateId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  },

  /**
   * Save an event to storage
   * @param {Object} eventData - Parsed event data
   * @param {string} calendarUrl - The Google Calendar URL
   * @param {string} originalText - The original selected text
   * @returns {Promise<Object>} - The saved event record
   */
  async saveEvent(eventData, calendarUrl, originalText) {
    console.log('=== EventStorage.saveEvent START ===');
    console.log('Input eventData:', JSON.stringify(eventData, null, 2));
    try {
      const eventRecord = {
        id: this.generateId(),
        title: eventData.title,
        startDate: eventData.startDate.toISOString(),
        endDate: eventData.endDate.toISOString(),
        calendarUrl: calendarUrl,
        createdAt: new Date().toISOString(),
        originalText: originalText,
        confidence: eventData.confidence || 0
      };
      console.log('Created eventRecord:', JSON.stringify(eventRecord, null, 2));

      const result = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
      console.log('Current storage result:', JSON.stringify(result, null, 2));
      let events = result[CONFIG.STORAGE_KEY] || [];
      console.log('Current events count:', events.length);

      // Add new event at the beginning
      events.unshift(eventRecord);

      // Keep only the maximum allowed events
      if (events.length > CONFIG.MAX_EVENTS) {
        events = events.slice(0, CONFIG.MAX_EVENTS);
        log(`Trimmed history to ${CONFIG.MAX_EVENTS} events`);
      }

      console.log('About to save. Events count:', events.length);
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: events });
      console.log('chrome.storage.local.set() completed');

      // Verify the save worked
      const verifyResult = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
      console.log('VERIFY after save:', JSON.stringify(verifyResult, null, 2));
      console.log('=== EventStorage.saveEvent END ===');

      return eventRecord;
    } catch (error) {
      console.error('=== EventStorage.saveEvent FAILED ===');
      console.error('Error:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      logError('Error saving event:', error);
      throw error;
    }
  },

  /**
   * Get recent events from storage
   * @param {number} limit - Maximum number of events to return (default: 5)
   * @returns {Promise<Array>} - Array of event records
   */
  async getRecentEvents(limit = 5) {
    console.log('=== getRecentEvents START ===');
    console.log('Requested limit:', limit);
    try {
      const result = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
      console.log('Storage key used:', CONFIG.STORAGE_KEY);
      console.log('Raw storage result:', JSON.stringify(result, null, 2));
      const events = result[CONFIG.STORAGE_KEY] || [];
      console.log('Events found:', events.length);
      console.log('Returning:', events.slice(0, limit).length, 'events');
      console.log('=== getRecentEvents END ===');
      return events.slice(0, limit);
    } catch (error) {
      console.error('=== getRecentEvents FAILED ===');
      console.error('Error:', error);
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
      const result = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
      const events = result[CONFIG.STORAGE_KEY] || [];
      return events.find(event => event.id === id) || null;
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
    try {
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: [] });
      log('Event history cleared');
      // Reset session count and badge when history is cleared
      sessionEventCount = 0;
      updateBadge();
    } catch (error) {
      logError('Error clearing history:', error);
      throw error;
    }
  },

  /**
   * Delete a specific event by ID
   * @param {string} id - The event ID to delete
   * @returns {Promise<boolean>} - True if deleted, false if not found
   */
  async deleteEvent(id) {
    try {
      const result = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
      let events = result[CONFIG.STORAGE_KEY] || [];
      const initialLength = events.length;

      events = events.filter(event => event.id !== id);

      if (events.length < initialLength) {
        await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: events });
        log(`Event deleted. ID: ${id}`);
        // Decrement session count and update badge
        if (sessionEventCount > 0) {
          sessionEventCount--;
          updateBadge();
        }
        return true;
      }

      return false;
    } catch (error) {
      logError('Error deleting event:', error);
      return false;
    }
  },

  /**
   * Get the total count of stored events
   * @returns {Promise<number>}
   */
  async getEventCount() {
    try {
      const result = await chrome.storage.local.get([CONFIG.STORAGE_KEY]);
      const events = result[CONFIG.STORAGE_KEY] || [];
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
 * Update the extension badge with session event count
 */
function updateBadge() {
  // Don't run if service worker APIs aren't ready
  if (typeof chrome === 'undefined' || !chrome.action) {
    return;
  }

  try {
    if (sessionEventCount > 0) {
      const text = sessionEventCount > 99 ? '99+' : String(sessionEventCount);
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (error) {
    // Silently ignore - badge is not critical functionality
  }
}

/**
 * Increment session event count and update badge
 */
function incrementSessionCount() {
  sessionEventCount++;
  updateBadge();
  log(`Session count: ${sessionEventCount}`);
}

// =============================================================================
// EXTENSION LIFECYCLE
// =============================================================================

// Create context menu item when extension is installed
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.contextMenus.create({
      id: 'createCalendarEvent',
      title: '📅 Create Calendar Event',
      contexts: ['selection']
    });
    log('Context menu created');
  } catch (error) {
    logError('Error creating context menu:', error);
  }

  // Clear badge on install/update
  updateBadge();
});

// =============================================================================
// CONTEXT MENU HANDLER
// =============================================================================

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, _tab) => {
  console.log('=== CONTEXT MENU CLICKED ===');
  console.log('menuItemId:', info.menuItemId);
  console.log('selectionText:', info.selectionText);

  if (info.menuItemId !== 'createCalendarEvent' || !info.selectionText) {
    console.log('Early return - wrong menu or no selection');
    return;
  }

  const selectedText = info.selectionText.trim();

  if (!selectedText) {
    logError('No text selected');
    return;
  }

  console.log('Selected text:', selectedText);

  try {
    // Parse the text and create calendar URL
    const eventData = parseEventFromText(selectedText);
    console.log('Parsed event data:', JSON.stringify(eventData, (key, value) => {
      if (value instanceof Date) return value.toISOString();
      return value;
    }, 2));

    const calendarUrl = createGoogleCalendarUrl(eventData);
    console.log('Calendar URL:', calendarUrl);

    // Open the calendar link
    await chrome.tabs.create({ url: calendarUrl });
    console.log('Calendar tab opened');

    // Save to event history
    try {
      console.log('Attempting to save event...');
      const saved = await EventStorage.saveEvent(eventData, calendarUrl, selectedText);
      console.log('Event saved successfully:', JSON.stringify(saved, null, 2));
      incrementSessionCount();
      console.log('Session count incremented to:', sessionEventCount);

      // Show success notification
      await showNotification(
        'Event Created!',
        `"${eventData.title}" - ${formatDateForDisplay(eventData.startDate)}`
      );
    } catch (saveError) {
      console.error('=== SAVE FAILED ===');
      console.error('Error:', saveError);
      console.error('Error message:', saveError.message);
      console.error('Error stack:', saveError.stack);
      logError('Failed to save event to history:', saveError);
      // Don't block the user - calendar link is already open
    }
  } catch (error) {
    console.error('=== CONTEXT MENU HANDLER FAILED ===');
    console.error('Error:', error);
    logError('Error creating calendar event:', error);
    // Try to show an error notification
    await showNotification('Error', 'Failed to create calendar event. Please try again.');
  }
  console.log('=== CONTEXT MENU HANDLER END ===');
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
  console.log('=== MESSAGE RECEIVED ===');
  console.log('Message:', JSON.stringify(message, null, 2));
  console.log('Sender:', sender.id);
  handleMessage(message)
    .then(response => {
      console.log('Sending response:', JSON.stringify(response, null, 2));
      sendResponse(response);
    })
    .catch(error => {
      console.error('Message handler error:', error);
      sendResponse({ success: false, error: error.message });
    });
  return true; // Keep channel open for async response
});

async function handleMessage(message) {
  switch (message.action) {
  case 'getRecentEvents':
    console.log('Handling getRecentEvents action...');
    const events = await EventStorage.getRecentEvents(message.limit || 5);
    console.log('getRecentEvents returning', events.length, 'events');
    return { success: true, events };

  case 'clearHistory':
    await EventStorage.clearHistory();
    return { success: true };

  case 'getEvent':
    const event = await EventStorage.getEvent(message.id);
    return { success: true, event };

  case 'deleteEvent':
    const deleted = await EventStorage.deleteEvent(message.id);
    return { success: true, deleted };

  case 'getSessionCount':
    return { success: true, count: sessionEventCount };

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
 * @returns {Object} - { title, startDate, endDate, description, confidence }
 */
function parseEventFromText(text) {
  const now = new Date();
  const parseResult = {
    title: null,
    startDate: null,
    endDate: null,
    description: text,
    confidence: 0
  };

  // Track what we successfully parsed for confidence calculation
  const parsed = {
    date: false,
    time: false,
    duration: false,
    endTime: false
  };

  log('Parsing text:', text);

  // Extract title
  parseResult.title = extractTitle(text);

  // Extract date
  const dateResult = extractDate(text, now);
  let baseDate = null;
  if (dateResult.date) {
    baseDate = dateResult.date;
    parsed.date = true;
    log('Extracted date:', baseDate, `(${dateResult.type})`);
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

    log(`Extracted time range: ${startHours}:${String(startMinutes).padStart(2, '0')} - ${timeRangeResult.endHours}:${String(timeRangeResult.endMinutes).padStart(2, '0')} (${timeRangeResult.type})`);
    log(`Duration from range: ${durationMs / 60000} minutes`);
  } else {
    // Fall back to single time extraction
    const timeResult = extractTime(text);
    if (timeResult.found) {
      startHours = timeResult.hours;
      startMinutes = timeResult.minutes;
      parsed.time = true;
      log(`Extracted time: ${startHours}:${String(startMinutes).padStart(2, '0')} (${timeResult.type})`);
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
 * Extract a suitable title from the text
 */
function extractTitle(text) {
  // Clean up whitespace
  const cleaned = text.replace(/\s+/g, ' ').trim();

  // If text is short enough, use it all
  if (cleaned.length <= 60) {
    return cleaned;
  }

  // Try to get the first sentence
  const sentenceMatch = cleaned.match(/^[^.!?]+[.!?]?/);
  if (sentenceMatch && sentenceMatch[0].length <= 100) {
    return sentenceMatch[0].trim();
  }

  // Truncate to 60 chars at a word boundary
  const truncated = cleaned.substring(0, 60);
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

  // Debug logging helper
  const debugLog = (pattern, matched, match = null) => {
    if (CONFIG.DEBUG) {
      console.log(`  [extractDate] Pattern "${pattern}": ${matched ? 'MATCHED' : 'no match'}${match ? ` → "${match}"` : ''}`);
    }
  };

  if (CONFIG.DEBUG) {
    console.log(`[extractDate] Input: "${text}"`);
    console.log(`[extractDate] LowerText: "${lowerText}"`);
  }

  // Order matters - SPECIFIC dates beat GENERAL day names
  // Check numeric/explicit date formats BEFORE day names

  // 1. ISO format: YYYY-MM-DD (most specific, check first)
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  debugLog('ISO (YYYY-MM-DD)', !!isoMatch, isoMatch?.[0]);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const date = new Date(year, month, day);
    if (isValidDate(date)) {
      return { date, type: 'iso' };
    }
  }

  // 2. MM/DD/YYYY or MM-DD-YYYY (full date with year)
  const fullDateMatch = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  debugLog('MM/DD/YYYY', !!fullDateMatch, fullDateMatch?.[0]);
  if (fullDateMatch) {
    const month = parseInt(fullDateMatch[1], 10) - 1;
    const day = parseInt(fullDateMatch[2], 10);
    const year = parseInt(fullDateMatch[3], 10);
    const date = new Date(year, month, day);
    if (isValidDate(date)) {
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
    const month = MONTHS[monthDayYearMatch[1].toLowerCase()];
    const day = parseInt(monthDayYearMatch[2], 10);
    const year = parseInt(monthDayYearMatch[3], 10);
    const date = new Date(year, month, day);
    if (isValidDate(date)) {
      return { date, type: 'month-day-year' };
    }
  }

  // 4. MM/DD (no year) - use negative lookbehind to avoid matching times like "11:59"
  // Only match if preceded by word boundary or space, not by colon
  const shortDateMatch = text.match(/(?<!:)\b(\d{1,2})\/(\d{1,2})\b(?!\/\d)/);
  debugLog('MM/DD (no year)', !!shortDateMatch, shortDateMatch?.[0]);
  if (shortDateMatch) {
    const month = parseInt(shortDateMatch[1], 10);
    const day = parseInt(shortDateMatch[2], 10);
    // Validate month (1-12) and day (1-31) ranges
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = now.getFullYear();
      let date = new Date(year, month - 1, day);

      // Compare dates only (not times) to avoid same-day issues
      const todayMidnight = new Date(now);
      todayMidnight.setHours(0, 0, 0, 0);
      if (date < todayMidnight) {
        date = new Date(year + 1, month - 1, day);
      }

      if (isValidDate(date)) {
        return { date, type: 'mm-dd' };
      }
    }
  }

  // 5. Month day (no year): "January 5" / "Jan 5th"
  const monthDayRegex = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\b|,|$)`,
    'i'
  );
  if (CONFIG.DEBUG) {
    console.log(`  [extractDate] Month-day regex pattern: ${monthDayRegex}`);
  }
  const monthDayMatch = text.match(monthDayRegex);
  debugLog('month day (no year)', !!monthDayMatch, monthDayMatch?.[0]);
  if (monthDayMatch) {
    const month = MONTHS[monthDayMatch[1].toLowerCase()];
    const day = parseInt(monthDayMatch[2], 10);
    const year = now.getFullYear();
    let date = new Date(year, month, day);

    // If date is in the past, assume next year
    // Compare dates only (not times) to avoid same-day issues
    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);
    if (date < todayMidnight) {
      date = new Date(year + 1, month, day);
    }

    if (isValidDate(date)) {
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
    const year = dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : now.getFullYear();
    let date = new Date(year, month, day);

    // If no year specified and date is in the past, assume next year
    // Compare dates only (not times) to avoid same-day issues
    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);
    if (!dayMonthMatch[3] && date < todayMidnight) {
      date = new Date(year + 1, month, day);
    }

    if (isValidDate(date)) {
      return { date, type: 'day-month' };
    }
  }

  // 7. Relative dates: today, tomorrow, day after tomorrow
  const todayMatch = /\btoday\b/.test(lowerText);
  debugLog('today', todayMatch);
  if (todayMatch) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return { date, type: 'relative-today' };
  }

  const tomorrowMatch = /\btomorrow\b/.test(lowerText);
  debugLog('tomorrow', tomorrowMatch);
  if (tomorrowMatch) {
    const date = new Date(now);
    date.setDate(date.getDate() + 1);
    date.setHours(0, 0, 0, 0);
    return { date, type: 'relative-tomorrow' };
  }

  const dayAfterMatch = /\b(day after tomorrow|day after tmrw)\b/.test(lowerText);
  debugLog('day after tomorrow', dayAfterMatch);
  if (dayAfterMatch) {
    const date = new Date(now);
    date.setDate(date.getDate() + 2);
    date.setHours(0, 0, 0, 0);
    return { date, type: 'relative-dayafter' };
  }

  // 8. Next week
  const nextWeekMatch = /\bnext\s+week\b/.test(lowerText);
  debugLog('next week', nextWeekMatch);
  if (nextWeekMatch) {
    const date = new Date(now);
    date.setDate(date.getDate() + 7);
    date.setHours(0, 0, 0, 0);
    return { date, type: 'relative-nextweek' };
  }

  // 9. "next [day]" or "this [day]"
  const dayModifierMatch = lowerText.match(/\b(next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  debugLog('next/this [day]', !!dayModifierMatch, dayModifierMatch?.[0]);
  if (dayModifierMatch) {
    const modifier = dayModifierMatch[1];
    const targetDayName = dayModifierMatch[2];
    const targetDay = DAYS.indexOf(targetDayName);
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);

    const currentDay = date.getDay();
    let daysToAdd = targetDay - currentDay;

    if (modifier === 'next') {
      // "next Monday" means the Monday of next week
      if (daysToAdd <= 0) {
        daysToAdd += 7;
      }
      daysToAdd += 7; // Add another week for "next"
    } else {
      // "this Monday" means the upcoming Monday (or today if it's Monday)
      if (daysToAdd < 0) {
        daysToAdd += 7;
      }
      // If it's the same day, keep it (this Monday = today if today is Monday)
    }

    date.setDate(date.getDate() + daysToAdd);
    return { date, type: `day-${modifier}` };
  }

  // 10. Standalone day names (next occurrence) - LAST because least specific
  const standaloneDayMatch = lowerText.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  debugLog('standalone day', !!standaloneDayMatch && !dayModifierMatch, standaloneDayMatch?.[0]);
  if (standaloneDayMatch && !dayModifierMatch) {
    const targetDay = DAYS.indexOf(standaloneDayMatch[1]);
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);

    const currentDay = date.getDay();
    let daysToAdd = targetDay - currentDay;

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
 * Validate that a date is reasonable
 */
function isValidDate(date) {
  return date instanceof Date && !isNaN(date.getTime());
}

// =============================================================================
// TIME EXTRACTION
// =============================================================================

/**
 * Extract a time range from text (e.g., "6-8pm", "6pm-8pm", "10am-2pm")
 * @param {string} text - The text to parse
 * @returns {Object} - { found, startHours, startMinutes, endHours, endMinutes, type }
 */
function extractTimeRange(text) {
  const lowerText = text.toLowerCase();

  log('[extractTimeRange] Input:', text);

  // Time range patterns:
  // Pattern 1: "6-8pm", "6-8 pm", "6 - 8pm" (meridiem only on end)
  // Pattern 2: "6pm-8pm", "6pm - 8pm" (meridiem on both)
  // Pattern 3: "6:00-8:00pm", "6:30-8:30pm" (with minutes, meridiem on end)
  // Pattern 4: "6:00pm-8:00pm" (with minutes, meridiem on both)
  // Pattern 5: "6pm to 8pm", "6 to 8pm" (using "to" instead of dash)
  // Pattern 6: "10am-2pm" (different meridiems - crosses noon)

  // Comprehensive regex that handles all patterns
  // Groups: 1=startHour, 2=startMin, 3=startMeridiem, 4=endHour, 5=endMin, 6=endMeridiem
  const timeRangeRegex = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)\b/i;

  const match = text.match(timeRangeRegex);

  if (match) {
    log('[extractTimeRange] Match found:', match[0]);
    log('[extractTimeRange] Groups:', {
      startHour: match[1],
      startMin: match[2],
      startMeridiem: match[3],
      endHour: match[4],
      endMin: match[5],
      endMeridiem: match[6]
    });

    let startHours = parseInt(match[1], 10);
    const startMinutes = match[2] ? parseInt(match[2], 10) : 0;
    const startMeridiem = match[3];

    let endHours = parseInt(match[4], 10);
    const endMinutes = match[5] ? parseInt(match[5], 10) : 0;
    const endMeridiem = match[6];

    // Validate hour values
    if (startHours < 1 || startHours > 12 || endHours < 1 || endHours > 12) {
      log('[extractTimeRange] Invalid hour values, skipping');
      return { found: false, startHours: null, startMinutes: 0, endHours: null, endMinutes: 0, type: 'none' };
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
      // Start has explicit meridiem
      const startIsPM = /^p/i.test(startMeridiem);
      if (startIsPM && startHours !== 12) {
        startHours += 12;
      } else if (!startIsPM && startHours === 12) {
        startHours = 0;
      }
    } else {
      // Infer start meridiem from end meridiem and logic
      // "6-8pm" → both PM (6pm-8pm)
      // "10-2pm" → 10am-2pm (crosses noon, start must be AM)
      // "6-8am" → both AM

      if (endIsPM) {
        // End is PM
        if (startHours <= endHours % 12 || endHours % 12 === 0) {
          // Same meridiem: "6-8pm" → 6pm, 8pm
          if (startHours !== 12) {
            startHours += 12;
          }
        } else {
          // Crosses noon: "10-2pm" → 10am, 2pm
          // startHours stays as-is (AM)
          if (startHours === 12) {
            startHours = 0; // 12 without meridiem before PM end = 12am = 0
          }
        }
      } else {
        // End is AM - start is also AM
        if (startHours === 12) {
          startHours = 0;
        }
      }
    }

    log('[extractTimeRange] Parsed times:', {
      start: `${startHours}:${String(startMinutes).padStart(2, '0')}`,
      end: `${endHours}:${String(endMinutes).padStart(2, '0')}`
    });

    return {
      found: true,
      startHours,
      startMinutes,
      endHours,
      endMinutes,
      type: 'time-range'
    };
  }

  log('[extractTimeRange] No time range found');
  return { found: false, startHours: null, startMinutes: 0, endHours: null, endMinutes: 0, type: 'none' };
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

  // 3. 12-hour format: 3pm, 3:00pm, 3:00 PM, 3 pm, 3:30 a.m.
  const time12Regex = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)\b/i;
  const time12Match = text.match(time12Regex);
  if (time12Match) {
    let hours = parseInt(time12Match[1], 10);
    const minutes = time12Match[2] ? parseInt(time12Match[2], 10) : 0;
    const isPM = /^p/i.test(time12Match[3]);

    // Validate hours
    if (hours >= 1 && hours <= 12) {
      if (isPM && hours !== 12) {
        hours += 12;
      } else if (!isPM && hours === 12) {
        hours = 0;
      }
      return { found: true, hours, minutes, type: '12-hour' };
    }
  }

  // 4. 24-hour format: 15:00, 09:30 (but not dates like 01/05)
  const time24Regex = /(?<![\/\-\d])(\d{1,2}):(\d{2})(?![\/\-\d])/;
  const time24Match = text.match(time24Regex);
  if (time24Match) {
    const hours = parseInt(time24Match[1], 10);
    const minutes = parseInt(time24Match[2], 10);

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return { found: true, hours, minutes, type: '24-hour' };
    }
  }

  // 5. "at [number]" without am/pm - guess based on context
  const atTimeMatch = text.match(/\bat\s+(\d{1,2})\b(?!\s*[:\d\/\-])/i);
  if (atTimeMatch) {
    let hours = parseInt(atTimeMatch[1], 10);

    if (hours >= 1 && hours <= 12) {
      // Assume PM for hours 1-7 (business hours), AM for 8-12
      if (hours >= 1 && hours <= 7) {
        hours += 12;
      }
      return { found: true, hours, minutes: 0, type: 'at-number' };
    }
  }

  // 6. Standalone hour with o'clock: "3 o'clock"
  const oclockMatch = text.match(/\b(\d{1,2})\s*o['']?clock\b/i);
  if (oclockMatch) {
    let hours = parseInt(oclockMatch[1], 10);
    if (hours >= 1 && hours <= 12) {
      // Assume PM for hours 1-7
      if (hours >= 1 && hours <= 7) {
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
// CALENDAR URL GENERATION
// =============================================================================

/**
 * Format date for Google Calendar URL (YYYYMMDDTHHmmSS)
 */
function formatDateForCalendar(date) {
  const pad = (n) => n.toString().padStart(2, '0');

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  return `${year}${month}${day}T${hours}${minutes}${seconds}`;
}

/**
 * Create Google Calendar URL with parsed event data
 */
function createGoogleCalendarUrl(eventData) {
  const baseUrl = 'https://calendar.google.com/calendar/render';

  const startFormatted = formatDateForCalendar(eventData.startDate);
  const endFormatted = formatDateForCalendar(eventData.endDate);

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: eventData.title,
    dates: `${startFormatted}/${endFormatted}`,
    details: eventData.description
  });

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

